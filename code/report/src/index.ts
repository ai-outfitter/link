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
  Milestone,
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
// Build/publish/setup workflows that merely mention agents are not agent
// workflows: publish-agent-image builds an image, copilot-setup-steps
// configures an environment.
const AGENT_WORKFLOW_EXCLUDE = /setup|publish|deploy|build|image|release/i;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|rb|c|cc|cpp|h|hpp|ex|exs|nix|sh|bash|sql|proto|astro|vue|svelte)$/;

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

function classifySignals(paths: string[], agentsMdBody: string | null): Signals {
  const has = (p: string) => paths.includes(p);
  const ciWorkflows = paths.filter(
    (p) => p.startsWith(".github/workflows/") && /\.ya?ml$/.test(p),
  );
  const docCount = paths.filter((p) => p.startsWith("docs/") && p.endsWith(".md")).length;
  // A catalog repo carries its dotagents payload at the repository root.
  const catalog =
    paths.some((p) => /^agents\/[^/]+\/agent\.md$/.test(p)) ||
    paths.some((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)) ||
    has("settings.yml");
  // Declared workflows count only when the meta-schema is carried beside
  // them — the validated-contract marker, not just a directory name.
  const declaredWorkflows = has("spec/agent-workflow.v1.schema.json")
    ? paths
        .filter((p) => /^workflows\/[^/]+\.ya?ml$/.test(p))
        .map((p) => p.replace("workflows/", ""))
    : [];
  return Signals.parse({
    agents_md: has("AGENTS.md"),
    claude_md: has("CLAUDE.md"),
    contributing_md: has("CONTRIBUTING.md"),
    design_md: has("DESIGN.md"),
    agents_links_contributing:
      agentsMdBody !== null && /CONTRIBUTING\.md/i.test(agentsMdBody),
    dotagents_tree: paths.some((p) => p.startsWith(".agents/")),
    ci_workflows: ciWorkflows.length,
    agent_workflows: ciWorkflows
      .filter((p) => AGENT_WORKFLOW_HINT.test(p) && !AGENT_WORKFLOW_EXCLUDE.test(p))
      .map((p) => p.replace(".github/workflows/", "")),
    catalog,
    declared_workflows: declaredWorkflows,
    governance: paths.some((p) => /^governance\/.+\.ya?ml$/.test(p)),
    copilot_agent: ciWorkflows.some((p) => p.includes("copilot-setup-steps")),
    docs: docCount >= 5 ? "adequate" : docCount >= 1 || has("README.md") ? "thin" : "none",
  });
}

function classifyRole(name: string, paths: string[], signals: Signals): "catalog" | "application" | "meta" {
  if (signals.catalog) return "catalog";
  // Meta repos (org config, docs-only) are listed but never ranked: they
  // will never need agent workflows, and counting them against the org
  // punishes having utility repos.
  if (name === ".github") return "meta";
  if (!paths.some((p) => CODE_FILE.test(p)) && signals.ci_workflows === 0) return "meta";
  return "application";
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

  // The landing gate applies only to workflows that land changes; triage
  // never merges code. agent-identities and teams.reviewers are org-level
  // facts and are reported once per org, not per repo.
  const changeLanding = signals.agent_workflows.filter((w) => !/triage/i.test(w));
  if (changeLanding.length > 0 || signals.copilot_agent) {
    checks.push({
      rule: "evidence.landing-gate",
      status: "fail",
      note: "change-landing agent automation present but no session-capture landing gate found",
    });
  }
  return checks;
}

function maturityLevel(signals: Signals, baseline: BaselineCheck[]): number {
  // A shared catalog carrying validated workflow definitions and a
  // governance policy is the level-4 marker on the adoption ramp.
  if (signals.catalog && signals.declared_workflows.length > 0 && signals.governance) return 4;
  const bp = baseline.find((c) => c.rule === "branch-protection");
  if (signals.agent_workflows.length > 0 && bp?.status === "pass") return 3;
  if (signals.catalog || signals.agent_workflows.length > 0 || signals.dotagents_tree) return 2;
  if (signals.agents_md || signals.claude_md) return 1;
  return 0;
}

const LEVEL_REQUIREMENTS: Record<number, string[]> = {
  1: ["instructions"],
  2: ["shared-catalog", "catalog-consumed"],
  3: ["triggered-agents", "protected-landing", "session-capture"],
  4: ["bot-identity", "strict-governance"],
};

function orgMilestones(ranked: RepoReport[]): Milestone[] {
  const names = (repos: RepoReport[]) => repos.map((r) => r.name).join(", ");
  const instr = ranked.filter((r) => r.signals.agents_md || r.signals.claude_md);
  const catalogs = ranked.filter(
    (r) => r.signals.catalog && r.signals.declared_workflows.length > 0 && r.signals.governance,
  );
  const consumers = ranked.filter(
    (r) => r.role === "application" && r.signals.dotagents_tree,
  );
  const triggered = ranked.filter(
    (r) => r.signals.agent_workflows.length > 0 || r.signals.copilot_agent,
  );
  const changeLanding = ranked.filter(
    (r) =>
      r.signals.agent_workflows.some((w) => !/triage/i.test(w)) || r.signals.copilot_agent,
  );
  const unprotectedLanding = changeLanding.filter(
    (r) => !r.baseline.some((c) => c.rule === "branch-protection" && c.status === "pass"),
  );
  const enforcement = String(baselineDoc.enforcement ?? "warn");

  return [
    {
      id: "instructions",
      title: "contributor docs for humans and agents",
      status: instr.length > 0 ? "met" : "unmet",
      evidence:
        instr.length > 0
          ? (() => {
              const contributing = ranked.filter((r) => r.signals.contributing_md);
              const linked = ranked.filter((r) => r.signals.agents_links_contributing);
              const design = ranked.filter((r) => r.signals.design_md);
              return (
                `${instr.length}/${ranked.length} carry AGENTS.md or CLAUDE.md; ` +
                `${contributing.length} pair it with CONTRIBUTING.md` +
                (contributing.length > 0 ? ` (${linked.length} reference it from AGENTS.md)` : "") +
                `; DESIGN.md in ${design.length}`
              );
            })()
          : "no ranked repo carries AGENTS.md or CLAUDE.md",
    },
    {
      id: "shared-catalog",
      title: "governed shared catalog",
      status: catalogs.length > 0 ? "met" : "unmet",
      evidence:
        catalogs.length > 0
          ? `${names(catalogs)} carry validated workflows beside a governance policy`
          : "no repo carries validated workflow definitions beside a governance policy",
    },
    {
      id: "catalog-consumed",
      title: "catalog consumed by application repos",
      status: consumers.length > 0 ? "met" : "unmet",
      evidence:
        consumers.length > 0
          ? `${consumers.length} application repos carry a dotagents payload (${names(consumers)})`
          : "no application repo carries a dotagents payload; pinned-source consumption is not tree-visible",
    },
    {
      id: "triggered-agents",
      title: "triggered agent automation",
      status: triggered.length > 0 ? "met" : "unmet",
      evidence:
        triggered.length > 0
          ? triggered
              .map(
                (r) =>
                  `${r.name}: ${[...r.signals.agent_workflows, ...(r.signals.copilot_agent ? ["copilot coding agent"] : [])].join(", ")}`,
              )
              .join("; ")
          : "no CI-triggered agent workflow or forge coding agent found",
    },
    {
      id: "protected-landing",
      title: "protection where agents land changes",
      status:
        changeLanding.length === 0 ? "unmet" : unprotectedLanding.length === 0 ? "met" : "unmet",
      evidence:
        changeLanding.length === 0
          ? "no change-landing agent automation exists yet (triage does not land code)"
          : unprotectedLanding.length === 0
            ? `all ${changeLanding.length} change-landing repos pass branch protection`
            : `unprotected: ${names(unprotectedLanding)}`,
    },
    {
      id: "session-capture",
      title: "session capture before landing",
      status: "unmet",
      evidence:
        "no session-capture landing gate detected; becomes scannable once workflows upload session artifacts behind a required check",
    },
    {
      id: "bot-identity",
      title: "capped agent identity (bot app)",
      status: "unknown",
      evidence: "org-level GitHub App configuration is not scanned; verify and record manually",
    },
    {
      id: "strict-governance",
      title: "governance enforcement at strict",
      status: enforcement === "strict" ? "met" : "unmet",
      evidence: `sdlc-baseline enforcement: ${enforcement}`,
    },
  ].map((m) => Milestone.parse(m));
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
  // One content fetch, only where the convention check is meaningful:
  // does AGENTS.md reference CONTRIBUTING.md?
  let agentsMdBody: string | null = null;
  if (paths.includes("AGENTS.md") && paths.includes("CONTRIBUTING.md")) {
    const file = await ghJson<{ content?: string }>([
      "api",
      `repos/${org}/${listing.name}/contents/AGENTS.md`,
    ]);
    if (file?.content) agentsMdBody = Buffer.from(file.content, "base64").toString("utf8");
  }
  const signals = classifySignals(paths, agentsMdBody);
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
    role: classifyRole(listing.name, paths, signals),
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

  // Ranking considers only active, non-meta repos: a shelved repo's missing
  // branch protection is not current practice, and org-config or docs-only
  // repos will never need agent workflows.
  const ranked = repos.filter((r) => r.active && r.role !== "meta");

  // The org level is a cumulative capability checklist with evidence, not a
  // repo count — repo counts can be bought with copy-paste workflows.
  const milestones = orgMilestones(ranked);
  const met = (id: string) => milestones.find((m) => m.id === id)?.status === "met";
  let orgLevel = 0;
  for (const [level, ids] of Object.entries(LEVEL_REQUIREMENTS)) {
    if (orgLevel === Number(level) - 1 && ids.every(met)) orgLevel = Number(level);
  }

  // Gaps are what blocks the next level, plus the protection backlog.
  const gaps: string[] = [];
  for (const id of LEVEL_REQUIREMENTS[orgLevel + 1] ?? []) {
    const m = milestones.find((x) => x.id === id)!;
    if (m.status !== "met") gaps.push(`level ${orgLevel + 1} blocked — ${m.title}: ${m.evidence}`);
  }
  const failing = ranked.filter((r) =>
    r.baseline.some((c) => c.rule === "branch-protection" && c.status === "fail"),
  );
  if (failing.length > 0)
    gaps.push(
      `${failing.length}/${ranked.length} ranked repos miss baseline branch protection (required checks + reviews)`,
    );

  return OrgReport.parse({
    org,
    scanned_at: new Date().toISOString(),
    sampling_note:
      listings.length >= REPO_LIMIT
        ? `most recently pushed ${REPO_LIMIT} repositories`
        : `all ${listings.length} repositories`,
    ranking_note: `ranking covers the ${ranked.length} active catalog/application repos; ${repos.length - ranked.length} inactive or meta repos are listed but not ranked`,
    milestones,
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
