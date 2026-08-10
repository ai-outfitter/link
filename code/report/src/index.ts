// Org SDLC report: scan GitHub orgs (read-only, via the authenticated `gh`
// CLI) and local checkout folders, audit each repository against the
// catalog's governance baseline, and emit typed JSON the Astro site renders.
//
// Sources are persistent: `add <target>` registers a GitHub org or a folder
// in $XDG_CONFIG_HOME/outfitter-link/sources.json; a bare run scans every
// registered source. An org/user's .agents catalog folder is the canonical
// eval anchor — folder expansion therefore includes hidden directories.
//
// Usage:
//   link report                  # scan registered sources
//   link report add <target>...  # register org(s)/folder(s), then scan
//   link report <target>...      # scan registered + these (not saved)
//
// Runs on plain node (so `npx @ai-outfitter/link` works) and on Bun, which
// starts faster. Keep this file free of Bun-only globals.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  BaselineCheck,
  LEVEL_NAMES,
  Milestone,
  OrgReport,
  Report,
  RepoReport,
  Signals,
  WorkflowsFile,
} from "./schema.js";

// The catalog payload (governance, workflows) sits at the package root, but
// this file runs from two depths: code/report/src in a checkout, dist/ in an
// installed package. Walk up to the payload rather than counting directories.
function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "governance", "sdlc-baseline.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "cannot locate the catalog payload: governance/sdlc-baseline.yaml is missing",
  );
}

const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));
// Present only in a repo checkout; the Astro dev site reads the report here.
const DATA_DIR = join(ROOT, "code", "web", "src", "data");
const XDG_CONFIG = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "outfitter-link",
);
const XDG_DATA = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "outfitter-link",
);
const SOURCES_FILE = join(XDG_CONFIG, "sources.json");
const REPO_LIMIT = 30;
const CONCURRENCY = 8;
// A repo with no push in this window is inactive: still scanned and shown,
// but excluded from the org-level ranking and the gap counts.
const ACTIVE_WINDOW_DAYS = 7;

type Source = { type: "github-org" | "github-repo" | "folder"; target: string };

// `owner/repo` names one repository; a bare `owner` means the whole org. A
// path that exists on disk always wins, so a folder called `acme/link` under
// the working directory is still a folder source.
const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const baselineDoc = parseYaml(
  readFileSync(join(ROOT, "governance", "sdlc-baseline.yaml"), "utf8"),
) as Record<string, any>;

// ── source registry ─────────────────────────────────────────────────────────

function loadSources(): Source[] {
  if (!existsSync(SOURCES_FILE)) return [];
  try {
    const doc = JSON.parse(readFileSync(SOURCES_FILE, "utf8"));
    return Array.isArray(doc.sources) ? doc.sources : [];
  } catch {
    return [];
  }
}

async function saveSources(sources: Source[]) {
  mkdirSync(XDG_CONFIG, { recursive: true });
  await writeFile(SOURCES_FILE, JSON.stringify({ sources }, null, 2) + "\n");
}

function toSource(target: string): Source {
  const expanded = target.startsWith("~") ? join(homedir(), target.slice(1)) : target;
  if (existsSync(expanded)) return { type: "folder", target: resolve(expanded) };
  return OWNER_REPO.test(target)
    ? { type: "github-repo", target }
    : { type: "github-org", target };
}

function dedupe(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = `${s.type}:${s.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── shared classification ───────────────────────────────────────────────────

type RepoInput = {
  name: string;
  visibility: string;
  default_branch: string;
  pushed_at: string;
  paths: string[];
  agentsMdBody: string | null;
  branchRules: any[] | null;
  rulesNote: string;
};

const AGENT_WORKFLOW_HINT = /agent|claude|outfitter|triage|copilot|review-bot/i;
// Build/publish/setup workflows that merely mention agents are not agent
// workflows: publish-agent-image builds an image, copilot-setup-steps
// configures an environment.
const AGENT_WORKFLOW_EXCLUDE = /setup|publish|deploy|build|image|release/i;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|rb|c|cc|cpp|h|hpp|ex|exs|nix|sh|bash|sql|proto|astro|vue|svelte)$/;
// GitHub and Forgejo/Gitea CI both count.
const CI_DIR = /^\.(github|forgejo|gitea)\/workflows\//;

function classifySignals(paths: string[], agentsMdBody: string | null): Signals {
  const has = (p: string) => paths.includes(p);
  const ciWorkflows = paths.filter((p) => CI_DIR.test(p) && /\.ya?ml$/.test(p));
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
  const dotagentsTree = paths.some((p) => p.startsWith(".agents/"));
  return Signals.parse({
    agents_md: has("AGENTS.md"),
    claude_md: has("CLAUDE.md"),
    contributing_md: has("CONTRIBUTING.md"),
    design_md: has("DESIGN.md"),
    agents_links_contributing:
      agentsMdBody !== null && /CONTRIBUTING\.md/i.test(agentsMdBody),
    dotagents_tree: dotagentsTree,
    ci_workflows: ciWorkflows.length,
    agent_workflows: ciWorkflows
      .filter((p) => AGENT_WORKFLOW_HINT.test(p) && !AGENT_WORKFLOW_EXCLUDE.test(p))
      .map((p) => p.replace(CI_DIR, "")),
    catalog,
    declared_workflows: declaredWorkflows,
    governance: paths.some((p) => /^governance\/.+\.ya?ml$/.test(p)),
    copilot_agent: ciWorkflows.some((p) => p.includes("copilot-setup-steps")),
    resident_deploy:
      (catalog || dotagentsTree) && paths.some((p) => /^deploy\/.*\.ya?ml$/.test(p)),
    deploy_manifests: paths.some((p) => /^deploy\/.*\.ya?ml$/.test(p)),
    docs: docCount >= 5 ? "adequate" : docCount >= 1 || has("README.md") ? "thin" : "none",
  });
}

function classifyRole(name: string, paths: string[], signals: Signals): "catalog" | "application" | "meta" {
  if (signals.catalog) return "catalog";
  // Meta repos (org config, docs-only) are listed but never ranked: they
  // will never need agent workflows, and counting them against the org
  // punishes having utility repos.
  if (basename(name) === ".github") return "meta";
  if (!paths.some((p) => CODE_FILE.test(p)) && signals.ci_workflows === 0) return "meta";
  return "application";
}

function auditBaseline(signals: Signals, input: RepoInput): BaselineCheck[] {
  const checks: BaselineCheck[] = [];
  const bp = baselineDoc.rules?.["branch-protection"] ?? {};

  if (input.branchRules === null) {
    checks.push({ rule: "branch-protection", status: "unknown", note: input.rulesNote });
  } else {
    const types = new Set(input.branchRules.map((r) => r.type));
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

function buildRepoReport(input: RepoInput, activeCutoff: number): RepoReport {
  const signals = classifySignals(input.paths, input.agentsMdBody);
  const baseline = auditBaseline(signals, input);
  const level = maturityLevel(signals, baseline);
  return RepoReport.parse({
    name: input.name,
    visibility: input.visibility,
    default_branch: input.default_branch,
    pushed_at: input.pushed_at,
    active: Date.parse(input.pushed_at) >= activeCutoff,
    role: classifyRole(input.name, input.paths, signals),
    signals,
    baseline,
    level,
    level_name: LEVEL_NAMES[level],
  });
}

// ── milestones ──────────────────────────────────────────────────────────────

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

  // The e2e smoke test: does ANY path exist from an issue to an agent the
  // org itself hosts and controls? SaaS coding agents (Copilot, vendor
  // GitHub apps) are excluded by definition — they are someone else's
  // destiny. Evidence: self-hosted harnesses running in own CI, or
  // resident agents with deployment manifests. The org/user's .agents
  // catalog is the canonical place this evidence lives.
  const sovereignCI = ranked.filter((r) => r.signals.agent_workflows.length > 0);
  // Residency: payload and deploy manifests in one repo, or split across
  // the org — a catalog repo plus a sibling repo carrying deploy/ manifests.
  const hasCatalog = ranked.some((r) => r.signals.catalog);
  const resident = ranked.filter(
    (r) => r.signals.resident_deploy || (hasCatalog && r.signals.deploy_manifests),
  );
  const declared = ranked.filter((r) => r.signals.declared_workflows.length > 0);
  const smoketestParts: string[] = [];
  if (sovereignCI.length > 0)
    smoketestParts.push(
      `self-hosted CI agents: ${sovereignCI.map((r) => `${r.name} (${r.signals.agent_workflows.join(", ")})`).join("; ")}`,
    );
  if (resident.length > 0)
    smoketestParts.push(`resident agents: ${names(resident)} (deploy/ manifests)`);

  return [
    {
      id: "e2e-smoketest",
      title: "e2e smoke test: issue → self-hosted agent",
      status: sovereignCI.length > 0 || resident.length > 0 ? "met" : "unmet",
      evidence:
        smoketestParts.length > 0
          ? `${smoketestParts.join(" · ")} (SaaS coding agents excluded)`
          : declared.length > 0
            ? `declared only: ${names(declared)} carry workflow definitions but no runtime executes them; SaaS coding agents excluded`
            : "no self-hosted path from an issue to an agent (SaaS coding agents excluded by definition)",
    },
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

// ── github source ───────────────────────────────────────────────────────────

type RepoListing = {
  name: string;
  visibility: string;
  defaultBranchRef: { name: string } | null;
  pushedAt: string;
};

// Resolves to null on a non-zero exit so a repo the token cannot read
// degrades to "unknown" instead of failing the whole scan.
function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolvePromise(error ? null : stdout),
    );
  });
}

async function ghJson<T>(args: string[]): Promise<T | null> {
  const out = await run("gh", args);
  if (out === null) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

async function scanGithubRepo(org: string, listing: RepoListing): Promise<RepoInput | null> {
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
  const branchRules = await ghJson<any[]>([
    "api",
    `repos/${org}/${listing.name}/rules/branches/${branch}`,
  ]);
  return {
    name: listing.name,
    visibility: listing.visibility.toLowerCase(),
    default_branch: branch,
    pushed_at: listing.pushedAt,
    paths,
    agentsMdBody,
    branchRules,
    rulesNote: "branch rules endpoint not readable with this token",
  };
}

// ── folder source ───────────────────────────────────────────────────────────

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function listRepoDirs(root: string): string[] {
  // A folder source is a repo, a folder of repos (an owner), or a folder of
  // owners. Hidden directories are included deliberately: the org/user
  // .agents catalog is the canonical eval anchor. Worktree siblings are not
  // separate repos.
  if (isGitRepo(root)) return [root];
  const children = readdirSync(root)
    .filter((c) => !c.endsWith(".worktrees") && c !== "node_modules")
    .map((c) => join(root, c))
    .filter((p) => statSync(p, { throwIfNoEntry: false })?.isDirectory());
  const repos = children.filter(isGitRepo);
  if (repos.length > 0) return repos;
  return children.flatMap((owner) =>
    readdirSync(owner)
      .filter((c) => !c.endsWith(".worktrees") && c !== "node_modules")
      .map((c) => join(owner, c))
      .filter((p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() && isGitRepo(p)),
  );
}

async function git(dir: string, args: string[]): Promise<string | null> {
  const out = await run("git", ["-C", dir, ...args]);
  return out === null ? null : out.trim();
}

async function scanLocalRepo(root: string, dir: string): Promise<RepoInput | null> {
  const files = await git(dir, ["ls-files"]);
  if (files === null) return null;
  const paths = files.split("\n").filter(Boolean);
  const pushedAt = (await git(dir, ["log", "-1", "--format=%cI"])) ?? new Date(0).toISOString();
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD";
  let agentsMdBody: string | null = null;
  if (paths.includes("AGENTS.md") && paths.includes("CONTRIBUTING.md")) {
    try {
      agentsMdBody = readFileSync(join(dir, "AGENTS.md"), "utf8");
    } catch {}
  }
  const name = dir === root ? basename(dir) : dir.slice(root.length + 1);
  return {
    name,
    visibility: "local",
    default_branch: branch,
    pushed_at: pushedAt,
    paths,
    agentsMdBody,
    branchRules: null,
    rulesNote: "local checkout; forge branch rules not queried",
  };
}

// ── orchestration ───────────────────────────────────────────────────────────

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

// A scan unit merges every source that resolves to the same canonical
// identity (host/owner from git remotes): a GitHub org and the local
// folder of its clones are the same organization seen from two sides.
type ScanUnit = {
  label: string;
  identity: string | null;
  // The whole organization, listed from the forge.
  org: string | null;
  // Named repositories in that owner, when the caller asked for repositories
  // rather than an org. Both may be set: `report acme acme/other-repo` lists
  // acme and adds a repository the sample might otherwise have missed.
  repos: string[];
  folders: { root: string; dirs: string[] }[];
};

const REMOTE_OWNER = /(?:@|\/\/)([^/:@]+)(?::\d+)?[:/]([^/]+)\//;

async function repoIdentity(dir: string): Promise<string | null> {
  const url = await git(dir, ["remote", "get-url", "origin"]);
  const m = url?.match(REMOTE_OWNER);
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null;
}

async function buildUnits(sources: Source[]): Promise<ScanUnit[]> {
  const units: ScanUnit[] = sources
    .filter((s) => s.type === "github-org")
    .map((s) => ({
      label: s.target,
      identity: `github.com/${s.target.toLowerCase()}`,
      org: s.target,
      repos: [],
      folders: [],
    }));

  // Repositories join the unit for their owner, so `acme/one acme/two` is one
  // report about acme rather than two reports about one repository each.
  for (const source of sources.filter((s) => s.type === "github-repo")) {
    const owner = source.target.slice(0, source.target.indexOf("/"));
    const identity = `github.com/${owner.toLowerCase()}`;
    const existing = units.find((u) => u.identity === identity);
    if (existing) existing.repos.push(source.target);
    else units.push({ label: owner, identity, org: null, repos: [source.target], folders: [] });
  }

  for (const source of sources.filter((s) => s.type === "folder")) {
    const dirs = listRepoDirs(source.target);
    const ids = await mapLimit(dirs, CONCURRENCY, repoIdentity);
    const counts = new Map<string, number>();
    for (const id of ids) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const identity = top && top[1] * 2 > dirs.length ? top[0] : null;
    const existing = identity ? units.find((u) => u.identity === identity) : undefined;
    if (existing) existing.folders.push({ root: source.target, dirs });
    else
      units.push({
        label: identity ?? source.target,
        identity,
        org: null,
        repos: [],
        folders: [{ root: source.target, dirs }],
      });
  }
  return units;
}

// What the report says it looked at. A unit can mix all three, and the
// combination matters to a reader: "github-repo" alone means the org's other
// repositories were never examined, so an org level derived from it is a
// statement about those repositories only.
function sourceType(unit: ScanUnit): string {
  const parts: string[] = [];
  if (unit.org !== null) parts.push("github-org");
  if (unit.repos.length > 0) parts.push("github-repo");
  if (unit.folders.length > 0) parts.push("folder");
  return parts.join("+") || "folder";
}

async function scanUnit(unit: ScanUnit): Promise<OrgReport> {
  const activeCutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const inputs: (RepoInput | null)[] = [];
  const notes: string[] = [];

  const owner = unit.org ?? (unit.repos[0]?.split("/")[0] || null);
  const listings: RepoListing[] = [];

  if (unit.org !== null) {
    const listed = await ghJson<RepoListing[]>([
      "repo",
      "list",
      unit.org,
      "--json",
      "name,visibility,defaultBranchRef,pushedAt",
      "--limit",
      String(REPO_LIMIT),
    ]);
    if (listed === null) throw new Error(`cannot list repositories for ${unit.org}`);
    listings.push(...listed);
    notes.push(
      listed.length >= REPO_LIMIT
        ? `most recently pushed ${REPO_LIMIT} repositories`
        : `all ${listed.length} repositories`,
    );
  }

  // Named repositories are fetched one at a time: `gh repo list` cannot
  // address a single repository, and an unreadable one must not fail a scan
  // that also covers repositories the token can read.
  if (unit.repos.length > 0) {
    const named = await mapLimit(unit.repos, CONCURRENCY, async (full) => {
      const view = await ghJson<RepoListing>([
        "repo",
        "view",
        full,
        "--json",
        "name,visibility,defaultBranchRef,pushedAt",
      ]);
      if (view === null) notes.push(`${full} could not be read`);
      return view;
    });
    const found = named.filter((r): r is RepoListing => r !== null);
    if (found.length === 0 && unit.org === null && unit.folders.length === 0)
      throw new Error(
        `cannot read ${unit.repos.join(", ")} — check the name and that the token can see it`,
      );
    // A repository named explicitly and also present in the org listing is
    // one repository; the listing already carries it.
    const already = new Set(listings.map((l) => l.name.toLowerCase()));
    listings.push(...found.filter((r) => !already.has(r.name.toLowerCase())));
    notes.push(
      found.length === 1
        ? `repository ${found[0].name}`
        : `${found.length} named repositories`,
    );
  }

  if (listings.length > 0 && owner) {
    const sorted = [...listings].sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
    inputs.push(...(await mapLimit(sorted, CONCURRENCY, (l) => scanGithubRepo(owner, l))));
  }

  // Local checkouts of repos the forge scan already covered are the same
  // repo, not a second one; only local-only checkouts are appended.
  const forgeNames = new Set(
    inputs.filter((r): r is RepoInput => r !== null).map((r) => basename(r.name).toLowerCase()),
  );
  const seenDirs = new Set<string>();
  for (const folder of unit.folders) {
    const fresh = folder.dirs.filter((d) => !seenDirs.has(d));
    fresh.forEach((d) => seenDirs.add(d));
    const locals = await mapLimit(fresh, CONCURRENCY, (d) => scanLocalRepo(folder.root, d));
    const localOnly = locals.filter(
      (r): r is RepoInput => r !== null && !forgeNames.has(basename(r.name).toLowerCase()),
    );
    localOnly.forEach((r) => forgeNames.add(basename(r.name).toLowerCase()));
    inputs.push(...localOnly);
    notes.push(
      unit.org !== null
        ? `${localOnly.length} local-only checkouts under ${folder.root} (${fresh.length - localOnly.length} matched forge repos)`
        : `${fresh.length} local checkouts under ${folder.root}`,
    );
  }
  const samplingNote = notes.join("; ");

  const repos = inputs
    .filter((r): r is RepoInput => r !== null)
    .map((r) => buildRepoReport(r, activeCutoff));

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
    org: unit.label,
    source_type: sourceType(unit),
    identity: unit.identity,
    scanned_at: new Date().toISOString(),
    sampling_note: samplingNote,
    ranking_note: `ranking covers the ${ranked.length} active catalog/application repos; ${repos.length - ranked.length} inactive or meta repos are listed but not ranked`,
    repos,
    milestones,
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
    const raw = readFileSync(join(dir, file), "utf8");
    out.push({ file, raw, doc: parseYaml(raw) });
  }
  return WorkflowsFile.parse(out);
}

// ── main ────────────────────────────────────────────────────────────────────

export async function runReport(argv: string[]): Promise<number> {
  let registered = loadSources();

  if (argv[0] === "add") {
    const added = argv.slice(1).map(toSource);
    if (added.length === 0) {
      console.error("usage: link report add <org-or-path>...");
      return 2;
    }
    registered = dedupe([...registered, ...added]);
    await saveSources(registered);
    console.log(`registered: ${registered.map((s) => s.target).join(", ")}`);
    argv = [];
  }

  // --out <dir> puts the report where the caller wants it — the org's
  // .agents/reports/sdlc/<date>/ directory, for the onboarding runbook.
  let outDir = process.cwd();
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" || argv[i] === "-o") {
      const dir = argv[++i];
      if (!dir) {
        console.error("--out needs a directory");
        return 2;
      }
      outDir = resolve(dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir);
    } else {
      targets.push(argv[i]);
    }
  }

  const ephemeral = targets.map(toSource);
  // Named targets scope the scan to themselves. A report is filed into one
  // organization's .agents catalog, so `link report acme` must not carry
  // every org the machine has ever registered — the operator would commit
  // another org's inventory into acme's repository without noticing.
  //
  // A bare run scans the registered sources and nothing else. The tool ships
  // with no source of its own: a machine that has registered nothing has
  // nothing to scan, and says so.
  const sources = ephemeral.length > 0 ? dedupe(ephemeral) : dedupe(registered);

  if (sources.length === 0) {
    console.error("no sources: pass a GitHub org or folder, or `add` one first");
    return 2;
  }

  const orgs = await mapLimit(await buildUnits(sources), 2, scanUnit);

  const evidenceLimits = [
    "forge tree scan and local git ls-files only: unpushed and untracked practice is invisible",
    "absence of evidence is recorded as absence, not as a negative fact",
    `github orgs sample at most the ${REPO_LIMIT} most recently pushed repositories`,
    "org-level settings (bot capability caps, team membership) were not queried",
    "local checkouts report forge branch rules as unknown",
  ];
  // A scan of named repositories never listed the owner, so its level is a
  // statement about those repositories. Saying so here is the difference
  // between a scoped answer and a wrong one.
  const scoped = orgs.filter((o) => !o.source_type.includes("github-org"));
  if (scoped.length > 0)
    evidenceLimits.push(
      `named repositories only for ${scoped
        .map((o) => o.org)
        .join(", ")}: the rest of the owner was not listed, so the level describes the repositories scanned, not the organization`,
    );

  const report = Report.parse({
    generated_at: new Date().toISOString(),
    baseline: { name: baselineDoc.name, enforcement: baselineDoc.enforcement },
    orgs,
    evidence_limits: evidenceLimits,
  });

  const body = JSON.stringify(report, null, 2) + "\n";
  mkdirSync(outDir, { recursive: true });
  mkdirSync(XDG_DATA, { recursive: true });
  await writeFile(join(outDir, "report.json"), body);
  await writeFile(join(XDG_DATA, "report.json"), body);
  // `link web` renders /workflows from this, so it goes everywhere the report
  // goes. In a container the XDG copy dies with the container, and the
  // mounted output directory is the only one that survives to the next
  // `docker run … web`.
  const workflows = JSON.stringify(await collectWorkflows(), null, 2) + "\n";
  await writeFile(join(outDir, "workflows.json"), workflows);
  await writeFile(join(XDG_DATA, "workflows.json"), workflows);
  // Only in a checkout: the Astro dev site also reads from its own source
  // tree. An installed package must never write inside node_modules.
  if (existsSync(DATA_DIR)) {
    await writeFile(join(DATA_DIR, "report.json"), body);
    await writeFile(join(DATA_DIR, "workflows.json"), workflows);
  }

  for (const org of report.orgs) {
    const smoke = org.milestones.find((m) => m.id === "e2e-smoketest");
    console.log(
      `${org.org} [${org.source_type}]: level ${org.org_level} (${org.org_level_name}), ${org.repos.length} repos, smoketest ${smoke?.status}`,
    );
  }
  console.log(`wrote ${join(outDir, "report.json")} (+ ${join(XDG_DATA, "report.json")})`);
  return 0;
}
