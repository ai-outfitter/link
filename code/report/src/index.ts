// Org SDLC report: scan one or more GitHub orgs read-only through the
// authenticated `gh` CLI, audit each repository against the catalog's
// governance baseline, and emit typed JSON the Astro site renders.
//
// Usage: bun run src/index.ts <org> [org...]
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BaselineCheck,
  LEVEL_NAMES,
  OrgReport,
  Report,
  RepoReport,
  Signals,
  WorkflowsFile,
} from "./schema.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DATA_DIR = join(ROOT, "code", "web", "src", "data");
const REPO_LIMIT = 30;
const CONCURRENCY = 8;
// A repo with no push in this window is inactive: still scanned and shown,
// but excluded from the org-level ranking and the gap counts.
const ACTIVE_WINDOW_DAYS = 7;

const orgs = Bun.argv.slice(2);
if (orgs.length === 0) {
  console.error("usage: bun run src/index.ts <org> [org...]");
  process.exit(2);
}

const baselineDoc = Bun.YAML.parse(
  await Bun.file(join(ROOT, "governance", "sdlc-baseline.yaml")).text(),
) as Record<string, any>;

type RepoListing = {
  name: string;
  visibility: string;
  defaultBranchRef: { name: string } | null;
  pushedAt: string;
};

const AGENT_WORKFLOW_HINT = /agent|claude|outfitter|triage|copilot|review-bot/i;

async function ghJson<T>(args: string[]): Promise<T | null> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

function classifySignals(paths: string[]): Signals {
  const has = (p: string) => paths.includes(p);
  const ciWorkflows = paths.filter(
    (p) => p.startsWith(".github/workflows/") && /\.ya?ml$/.test(p),
  );
  const docCount = paths.filter((p) => p.startsWith("docs/") && p.endsWith(".md")).length;
  return Signals.parse({
    agents_md: has("AGENTS.md"),
    claude_md: has("CLAUDE.md"),
    dotagents_tree: paths.some((p) => p.startsWith(".agents/")),
    ci_workflows: ciWorkflows.length,
    agent_workflows: ciWorkflows
      .filter((p) => AGENT_WORKFLOW_HINT.test(p))
      .map((p) => p.replace(".github/workflows/", "")),
    docs: docCount >= 5 ? "adequate" : docCount >= 1 || has("README.md") ? "thin" : "none",
  });
}

function auditBaseline(
  signals: Signals,
  branchRules: any[] | null,
): BaselineCheck[] {
  const checks: BaselineCheck[] = [];
  const bp = baselineDoc.rules?.["branch-protection"] ?? {};

  if (branchRules === null) {
    checks.push({
      rule: "branch-protection",
      status: "unknown",
      note: "branch rules endpoint not readable with this token",
    });
  } else {
    const types = new Set(branchRules.map((r) => r.type));
    const hasChecks = types.has("required_status_checks");
    const hasReviews = types.has("pull_request");
    const wanted = `required-checks ${JSON.stringify(bp["required-checks"] ?? [])}, required-reviews ${bp["required-reviews"] ?? 0}`;
    checks.push({
      rule: "branch-protection",
      status: hasChecks && hasReviews ? "pass" : "fail",
      note: `effective rules: [${[...types].join(", ") || "none"}]; baseline wants ${wanted}`,
    });
  }

  checks.push({
    rule: "agent-identities",
    status: "unknown",
    note: "bot capability caps are org-level configuration, not visible in a repo scan",
  });
  checks.push({
    rule: "teams.reviewers",
    status: "unknown",
    note: "team membership requires org admin read; not queried",
  });
  checks.push({
    rule: "evidence.landing-gate",
    status: signals.agent_workflows.length > 0 ? "fail" : "unknown",
    note:
      signals.agent_workflows.length > 0
        ? "agent workflows present but no session-capture landing gate found"
        : "no agent workflows found, gate not applicable yet",
  });
  return checks;
}

function maturityLevel(signals: Signals, baseline: BaselineCheck[]): number {
  const bp = baseline.find((c) => c.rule === "branch-protection");
  if (signals.agent_workflows.length > 0 && bp?.status === "pass") return 3;
  if (signals.agent_workflows.length > 0 || signals.dotagents_tree) return 2;
  if (signals.agents_md || signals.claude_md) return 1;
  return 0;
}

async function scanRepo(
  org: string,
  listing: RepoListing,
  activeCutoff: number,
): Promise<RepoReport | null> {
  const branch = listing.defaultBranchRef?.name;
  if (!branch) return null; // empty repository
  const tree = await ghJson<{ tree?: { path: string }[] }>([
    "api",
    `repos/${org}/${listing.name}/git/trees/${branch}?recursive=1`,
  ]);
  const paths = (tree?.tree ?? []).map((e) => e.path);
  const signals = classifySignals(paths);
  const rules = await ghJson<any[]>([
    "api",
    `repos/${org}/${listing.name}/rules/branches/${branch}`,
  ]);
  const baseline = auditBaseline(signals, rules);
  const level = maturityLevel(signals, baseline);
  return RepoReport.parse({
    name: listing.name,
    visibility: listing.visibility.toLowerCase(),
    default_branch: branch,
    pushed_at: listing.pushedAt,
    active: Date.parse(listing.pushedAt) >= activeCutoff,
    signals,
    baseline,
    level,
    level_name: LEVEL_NAMES[level],
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

async function scanOrg(org: string): Promise<OrgReport> {
  const listings = await ghJson<RepoListing[]>([
    "repo",
    "list",
    org,
    "--json",
    "name,visibility,defaultBranchRef,pushedAt",
    "--limit",
    String(REPO_LIMIT),
  ]);
  if (listings === null) throw new Error(`cannot list repositories for ${org}`);
  const activeCutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const sorted = [...listings].sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  const repos = (
    await mapLimit(sorted, CONCURRENCY, (l) => scanRepo(org, l, activeCutoff))
  ).filter((r): r is RepoReport => r !== null);

  // Ranking and gaps consider only active repos: a shelved repo's missing
  // branch protection is not the org's current practice.
  const ranked = repos.filter((r) => r.active);

  // The org level is what it can claim consistently: the highest level at
  // least half of the ranked repositories reach.
  const orgLevel =
    [5, 4, 3, 2, 1].find(
      (lvl) => ranked.length > 0 && ranked.filter((r) => r.level >= lvl).length * 2 >= ranked.length,
    ) ?? 0;

  const gaps: string[] = [];
  const failing = ranked.filter((r) =>
    r.baseline.some((c) => c.rule === "branch-protection" && c.status === "fail"),
  );
  if (failing.length > 0)
    gaps.push(
      `${failing.length}/${ranked.length} active repos miss baseline branch protection (required checks + reviews)`,
    );
  const noInstructions = ranked.filter((r) => !r.signals.agents_md && !r.signals.claude_md);
  if (noInstructions.length > 0)
    gaps.push(`${noInstructions.length}/${ranked.length} active repos have no AGENTS.md or CLAUDE.md`);
  const withAgents = ranked.filter((r) => r.signals.agent_workflows.length > 0);
  if (withAgents.length > 0)
    gaps.push(
      `no session-capture landing gate found on any of the ${withAgents.length} repos running agent workflows`,
    );

  return OrgReport.parse({
    org,
    scanned_at: new Date().toISOString(),
    sampling_note:
      listings.length >= REPO_LIMIT
        ? `most recently pushed ${REPO_LIMIT} repositories`
        : `all ${listings.length} repositories`,
    ranking_note: `ranking covers the ${ranked.length} repos pushed within ${ACTIVE_WINDOW_DAYS} days; ${repos.length - ranked.length} inactive repos are listed but not ranked`,
    repos,
    org_level: orgLevel,
    org_level_name: LEVEL_NAMES[orgLevel],
    gaps,
  });
}

async function collectWorkflows(): Promise<WorkflowsFile> {
  const dir = join(ROOT, "workflows");
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  const out = [];
  for (const file of files) {
    const raw = await Bun.file(join(dir, file)).text();
    out.push({ file, raw, doc: Bun.YAML.parse(raw) });
  }
  return WorkflowsFile.parse(out);
}

const report = Report.parse({
  generated_at: new Date().toISOString(),
  baseline: { name: baselineDoc.name, enforcement: baselineDoc.enforcement },
  orgs: await mapLimit(orgs, 2, scanOrg),
  evidence_limits: [
    "forge tree scan only: local-only harness use and unpushed practice are invisible",
    "absence of evidence is recorded as absence, not as a negative fact",
    `sampled at most ${REPO_LIMIT} most recently pushed repositories per org`,
    "org-level settings (bot capability caps, team membership) were not queried",
  ],
});

await Bun.write(join(DATA_DIR, "report.json"), JSON.stringify(report, null, 2) + "\n");
await Bun.write(
  join(DATA_DIR, "workflows.json"),
  JSON.stringify(await collectWorkflows(), null, 2) + "\n",
);

for (const org of report.orgs) {
  console.log(
    `${org.org}: level ${org.org_level} (${org.org_level_name}), ${org.repos.length} repos scanned, ${org.gaps.length} gaps`,
  );
}
console.log(`wrote ${join(DATA_DIR, "report.json")} and workflows.json`);
