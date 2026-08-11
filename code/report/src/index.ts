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
  BypassActor,
  contributingRulesets,
  defaultEvidenceBackend,
  detectEvidenceGate,
  directPushesBlocked,
  EVIDENCE_BACKENDS,
  evidenceBackendById,
  MergedPr,
  readBypassActors,
  requiredCheckContexts,
} from "./evidence.js";
import {
  BaselineCheck,
  EvidenceFinding,
  LEVEL_NAMES,
  Milestone,
  NextStep,
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

const baselineRaw = readFileSync(join(ROOT, "governance", "sdlc-baseline.yaml"), "utf8");
const baselineDoc = parseYaml(baselineRaw) as Record<string, any>;

// The rules `auditBaseline` measures. Keep this in step with the checks it
// pushes: the site marks every other rule in the policy as stated but
// unmeasured, and a rule wrongly listed here reads as a clean result nobody
// ever checked.
const AUDITED_RULES = ["branch-protection", "evidence.landing-gate"];

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
  // Fetched only where they change an answer; null means not looked at, or
  // looked at and not readable. Either way: unknown, not absent.
  bypassActors: BypassActor[] | null;
  sample: MergedPr[] | null;
};

const AGENT_WORKFLOW_HINT = /agent|claude|outfitter|triage|copilot/i;
// Adversarial review is part of rung 3 in the canonical ramp, but the only
// spelling that used to score was the literal `review-bot`, so following the
// ramp with an obviously-named file earned nothing.
//
// A review workflow counts when its name says *whose* review it is —
// `pr-review`, `code-review`, `review-undrafted-pr`, `scheduled-commit-review`.
// A bare `review.yml` is ordinary CI: a nixpkgs fork ships one, and counting it
// would claim a self-hosted agent the repository does not have. `preview.yml`
// is excluded by the leading boundary rather than by the qualifier.
const REVIEW_WORKFLOW = /(^|[-_./])review/i;
const REVIEW_QUALIFIER = /(^|[-_./])(pr|pull-request|code|commit|agent|bot)([-_./]|$)/i;
// Build/publish/setup workflows that merely mention agents are not agent
// workflows: publish-agent-image builds an image, copilot-setup-steps
// configures an environment.
const AGENT_WORKFLOW_EXCLUDE = /setup|publish|deploy|build|image|release/i;
const isAgentWorkflow = (p: string) =>
  (AGENT_WORKFLOW_HINT.test(p) || (REVIEW_WORKFLOW.test(p) && REVIEW_QUALIFIER.test(p))) &&
  !AGENT_WORKFLOW_EXCLUDE.test(p);
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|rb|c|cc|cpp|h|hpp|ex|exs|nix|sh|bash|sql|proto|astro|vue|svelte)$/;
// GitHub and Forgejo/Gitea CI both count.
const CI_DIR = /^\.(github|forgejo|gitea)\/workflows\//;

function classifySignals(
  paths: string[],
  agentsMdBody: string | null,
  evidenceGate: EvidenceFinding | null,
): Signals {
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
    agent_workflows: ciWorkflows.filter(isAgentWorkflow).map((p) => p.replace(CI_DIR, "")),
    catalog,
    declared_workflows: declaredWorkflows,
    governance: paths.some((p) => /^governance\/.+\.ya?ml$/.test(p)),
    copilot_agent: ciWorkflows.some((p) => p.includes("copilot-setup-steps")),
    resident_deploy:
      (catalog || dotagentsTree) && paths.some((p) => /^deploy\/.*\.ya?ml$/.test(p)),
    deploy_manifests: paths.some((p) => /^deploy\/.*\.ya?ml$/.test(p)),
    docs: docCount >= 5 ? "adequate" : docCount >= 1 || has("README.md") ? "thin" : "none",
    evidence_gate: evidenceGate,
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
  //
  // The verdict comes from the evidence-gate backends, so this check and the
  // `session-capture` milestone are two views of one measurement and cannot
  // disagree. It was a hardcoded "fail" before: unconditional, so no amount
  // of correct work could clear it.
  const changeLanding = signals.agent_workflows.filter((w) => !/triage/i.test(w));
  if (changeLanding.length > 0 || signals.copilot_agent) {
    const gate = signals.evidence_gate;
    // Branch rules are what makes a gate provable, so when they cannot be read
    // this check is unknown for the same reason `branch-protection` is — no
    // forge was queried. Reporting `fail` here would record the absence of a
    // measurement as a negative fact about the repository, and it would make
    // the two checks disagree about the same missing evidence.
    if (input.branchRules === null) {
      checks.push({ rule: "evidence.landing-gate", status: "unknown", note: input.rulesNote });
    } else {
      // With no backend matched there is no finding to carry the facts the
      // scan already fetched for this repository — and these are the repos
      // where they matter most: an agent lands changes here. Report them
      // rather than discarding them for want of somewhere to put them.
      const facts: string[] = [];
      if (directPushesBlocked(input.branchRules) === false)
        facts.push(
          "direct pushes to the default branch are not blocked, so a commit can land without passing any check (CICD-001.9.3)",
        );
      // Deduped: the same actor reaches a branch through every ruleset that
      // grants it, and naming it once per ruleset reads as several exemptions
      // where there is one.
      const always = [
        ...new Set(
          (input.bypassActors ?? []).filter((a) => a.mode === "always").map((a) => a.who),
        ),
      ];
      if (always.length > 0)
        facts.push(
          `${always.join(", ")} ${always.length === 1 ? "bypasses" : "bypass"} the ruleset unconditionally (CICD-001.7.4)`,
        );
      checks.push({
        rule: "evidence.landing-gate",
        status:
          gate === null ? "fail" : gate.status === "met" ? "pass" : gate.status === "unknown" ? "unknown" : "fail",
        note:
          gate === null
            ? [
                "change-landing agent automation present and no evidence gate found by any backend",
                ...facts,
              ].join("; ")
            : `${gate.backend}: ${gate.evidence}`,
      });
    }
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
  const evidenceGate = detectEvidenceGate({
    paths: input.paths,
    requiredChecks: requiredCheckContexts(input.branchRules),
    hasBranchRules: input.branchRules !== null,
    directPushesBlocked: directPushesBlocked(input.branchRules),
    bypassActors: input.bypassActors,
    sample: input.sample,
  });
  const signals = classifySignals(input.paths, input.agentsMdBody, evidenceGate);
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

// The rung each milestone gates, inverted from LEVEL_REQUIREMENTS so the two
// cannot drift. A milestone absent from the map gates no rung: the smoke
// test is a precondition of the ramp rather than a step on it.
const MILESTONE_LEVEL: Record<string, number> = Object.fromEntries(
  Object.entries(LEVEL_REQUIREMENTS).flatMap(([level, ids]) =>
    ids.map((id) => [id, Number(level)]),
  ),
);

// How to clear each milestone. Every instruction names a signal the scanner
// reads, so following one changes the next report — advice the tool cannot
// then measure is advice this report has no business giving.
//
// The scanner is a file-tree heuristic, and these instructions say so where
// the heuristic is what stands between real work and credit for it. Somebody
// who does the work and gets no credit is the failure mode worth avoiding.
// `empty` replaces the step when the scan finds no repository to point at.
// A milestone can be unmet because the work is undone or because nothing
// exists to do it to, and one instruction cannot serve both.
const REMEDIATION: Record<
  string,
  { title: string; how: string[]; empty?: { title: string; how: string[] } }
> = {
  "e2e-smoketest": {
    title: "Give the organization one agent it hosts itself",
    how: [
      "Add a CI workflow to one active repository. Put it in `.github/workflows/`, `.forgejo/workflows/`, or `.gitea/workflows/`.",
      "Name the file for the agent, for example `agent-triage.yml`. The scan looks for `agent`, `claude`, `outfitter`, `triage`, or `review-bot` in the file name.",
      "Do not use `setup`, `publish`, `deploy`, `build`, `image`, or `release` in the name. The scan reads those as infrastructure workflows.",
      "Trigger the workflow from an issue event. Let it call a model and write one comment back.",
      "As an alternative, deploy a resident agent: add `deploy/<agent>.yaml` beside a dotagents payload.",
      "A SaaS coding agent does not satisfy this milestone. The capability being measured is an agent whose runtime the organization controls.",
    ],
  },
  instructions: {
    title: "Write contributor documentation that humans and agents both read",
    how: [
      "Add `AGENTS.md` to the repository root. `CLAUDE.md` also counts.",
      "Put the shared contributor guidance in `CONTRIBUTING.md`.",
      "Reference `CONTRIBUTING.md` from `AGENTS.md`, so one document stays authoritative.",
      "Add `DESIGN.md` when the repository has a frontend or produces generated documents.",
    ],
  },
  "shared-catalog": {
    title: "Publish one governed catalog repository",
    how: [
      "Create a catalog repository. Put `agents/<name>/agent.md` or `skills/<name>/SKILL.md` at its root.",
      "Add one `workflows/<name>.yaml` for each agent workflow.",
      "Add `spec/agent-workflow.v1.schema.json` beside them. Without the schema the workflows are a directory, not a validated contract, and the scan does not count them.",
      "Add a policy file under `governance/`, for example `governance/sdlc-baseline.yaml`.",
      "Validate the workflow files against the schema in CI.",
    ],
  },
  "catalog-consumed": {
    title: "Consume the catalog from an application repository",
    how: [
      "Sync the catalog payload into `.agents/` in at least one application repository.",
      "Pin the catalog version that you sync.",
      "Commit the `.agents/` tree. Consumption through a package manager is invisible to a tree scan, so an uncommitted payload cannot be counted.",
    ],
  },
  "triggered-agents": {
    title: "Trigger an agent from continuous integration",
    how: [
      "Add a CI workflow that runs an agent on an issue or pull request event.",
      "Name the workflow file for the agent, and avoid `setup`, `publish`, `deploy`, `build`, `image`, and `release`.",
      "A resident agent also satisfies this milestone: `deploy/<agent>.yaml` beside a dotagents payload is the evidence. The rung asks for an agent triggered from CI or a cluster, and a cluster counts.",
      "A forge coding agent also satisfies this milestone. `copilot-setup-steps.yml` in the CI directory is the evidence, although it does not satisfy the smoke test.",
    ],
  },
  "protected-landing": {
    title: "Protect the branches where agents land changes",
    how: [
      "Turn on branch protection for `main` in each repository that runs a change-landing agent workflow.",
      "Require the `ci` status check.",
      "Require one review.",
      "Apply the rules to administrators.",
      "A triage workflow does not land code and does not need this. A workflow that opens or merges pull requests does.",
    ],
    empty: {
      title: "Let an agent land a change, then protect where it lands",
      how: [
        "No agent workflow lands code yet. A triage workflow comments and labels; it does not open or merge a pull request.",
        "Extend one agent workflow so that it opens a pull request.",
        "Turn on branch protection for `main` in that repository before the workflow runs.",
        "Require the `ci` status check, require one review, and apply the rules to administrators.",
      ],
    },
  },
  // Filled from the evidence backend that matched, or from the default
  // backend when none did — see `remediationPlan`. These entries are the
  // fallback for a report with no change-landing automation at all.
  "session-capture": {
    title: "Require an evidence check on the branch agents land on",
    how: defaultEvidenceBackend().remediation.how,
    empty: {
      title: "Let an agent land a change, then gate what it lands",
      how: [
        "No agent workflow lands code yet, so there is nothing for an evidence gate to cover.",
        "Extend one agent workflow so that it opens a pull request.",
        "Then install the gate: copy `evidence-pr.yml` and `.github/pensieve.yml` from the Pensieve reference repository, and import a ruleset that requires a status check whose context starts with `evidence/`.",
        "The required check is what the scan reads. Gate files that no rule requires are reported as declared only.",
      ],
    },
  },
  "bot-identity": {
    title: "Give the agents a capped bot identity",
    how: [
      "Create a forge app for the agents. Do not let an agent act as a human account.",
      "Grant the app permission to open pull requests, comment, and request review.",
      "Withhold merge and push-to-protected permissions.",
      "Record the app and its permissions in the organization catalog. The scan cannot read organization-level app configuration, so it reports this as unknown until a human records it.",
    ],
  },
  "strict-governance": {
    title: "Move governance enforcement to strict",
    how: [
      "Confirm that the warn fraction has fallen to zero across the cohort.",
      "Set `enforcement: strict` in `governance/sdlc-baseline.yaml`.",
      "Do not move it back to `warn`. Effective strictness only ratchets up.",
    ],
  },
  "branch-protection-backlog": {
    title: "Clear the branch-protection backlog",
    how: [
      "Turn on branch protection for `main` in each listed repository.",
      "Require the `ci` status check, require one review, and apply the rules to administrators.",
      "This is baseline hygiene rather than a ramp blocker, so it comes after the steps above — but every later milestone assumes it.",
    ],
  },
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
  // "an issue, a message, or a schedule triggers agents in CI **or a cluster**"
  // — outfitter/docs/philosophy.md, the canonical ramp definition. A resident
  // agent satisfies this rung, and excluding it meant an organization that ran
  // its own agents in its own cluster capped at rung 2 while one that enabled a
  // SaaS coding agent — which the smoke test refuses as someone else's destiny
  // — climbed past it. The evidence bar is the same either way: a file in the
  // tree, `copilot-setup-steps.yml` or `deploy/<agent>.yaml`.
  const triggered = ranked.filter(
    (r) =>
      r.signals.agent_workflows.length > 0 ||
      r.signals.copilot_agent ||
      r.signals.resident_deploy,
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
                  `${r.name}: ${[
                    ...r.signals.agent_workflows,
                    ...(r.signals.copilot_agent ? ["copilot coding agent"] : []),
                    ...(r.signals.resident_deploy ? ["resident agent (deploy/ manifests)"] : []),
                  ].join(", ")}`,
              )
              .join("; ")
          : "no agent triggered from CI or a cluster, and no forge coding agent",
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
    // Measured over exactly the repos the `evidence.landing-gate` baseline
    // check covers, so the milestone and the rule are two views of one
    // measurement. `link` reads whether the gate is wired, never whether it
    // fired — that needs a sink credential, and it is `pensieve verify`'s job.
    (() => {
      const gated = changeLanding.map((r) => ({ repo: r, gate: r.signals.evidence_gate }));
      const met = gated.filter((g) => g.gate?.status === "met");
      const unknown = gated.filter((g) => g.gate?.status === "unknown");
      const declaredOnly = gated.filter((g) => g.gate?.declared_only);
      const backends = [...new Set(met.map((g) => g.gate!.backend))];
      return {
        id: "session-capture",
        title: "session capture before landing",
        status:
          changeLanding.length === 0
            ? "unmet"
            : met.length === changeLanding.length
              ? "met"
              : unknown.length > 0 && met.length + unknown.length === changeLanding.length
                ? "unknown"
                : "unmet",
        evidence:
          changeLanding.length === 0
            ? "no change-landing agent automation exists yet, so there is nothing to gate (triage does not land code)"
            : met.length === changeLanding.length
              ? `all ${changeLanding.length} change-landing repos require an evidence check (${backends.join(", ")})`
              : declaredOnly.length > 0
                ? `${declaredOnly.length} of ${changeLanding.length} change-landing repos carry evidence gate files that no effective rule requires — a workflow a branch can add or omit is not a gate: ${names(declaredOnly.map((g) => g.repo))}`
                : `${changeLanding.length - met.length} of ${changeLanding.length} change-landing repos have no evidence gate: ${names(gated.filter((g) => g.gate?.status !== "met").map((g) => g.repo))}`,
      };
    })(),
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
  ].map((m) => Milestone.parse({ ...m, level: MILESTONE_LEVEL[m.id] ?? null }));
}

// The ordered plan. A list of everything wrong is a backlog; the order is
// what makes it a plan, so this ranks by what the organization has to clear
// to reach its next rung rather than by how bad each finding looks.
function remediationPlan(
  milestones: Milestone[],
  orgLevel: number,
  ranked: RepoReport[],
  failingProtection: RepoReport[],
): NextStep[] {
  const byId = (id: string) => milestones.find((m) => m.id === id);
  const names = (repos: RepoReport[]) => repos.map((r) => r.name);

  // Where the work lands, when the scan can name it. No entry means the step
  // is an organization-level decision and not a per-repository edit.
  const targets: Record<string, () => string[]> = {
    instructions: () =>
      names(ranked.filter((r) => !r.signals.agents_md && !r.signals.claude_md)),
    "catalog-consumed": () =>
      names(ranked.filter((r) => r.role === "application" && !r.signals.dotagents_tree)),
    "protected-landing": () =>
      names(
        ranked.filter(
          (r) =>
            (r.signals.agent_workflows.some((w) => !/triage/i.test(w)) ||
              r.signals.copilot_agent) &&
            !r.baseline.some((c) => c.rule === "branch-protection" && c.status === "pass"),
        ),
      ),
    // The same population the milestone and the baseline rule measure: repos
    // whose automation lands changes, minus those already gated.
    "session-capture": () =>
      names(
        ranked.filter(
          (r) =>
            (r.signals.agent_workflows.some((w) => !/triage/i.test(w)) ||
              r.signals.copilot_agent) &&
            r.signals.evidence_gate?.status !== "met",
        ),
      ),
    "branch-protection-backlog": () => names(failingProtection),
  };

  const steps: NextStep[] = [];
  const push = (
    id: string,
    unblocks: string,
    blocksLevel: number | null,
    group: NextStep["group"],
  ) => {
    const remedy = REMEDIATION[id];
    if (!remedy) return;
    const repos = targets[id]?.() ?? [];
    let variant = repos.length === 0 && remedy.empty ? remedy.empty : remedy;
    // An organization that already started on an evidence backend gets that
    // backend's instructions, not the default one's. Telling somebody
    // half-way through a Pensieve adoption to start a different system is
    // advice that costs them the work they already did.
    if (id === "session-capture" && repos.length > 0) {
      const started = ranked.find((r) => r.signals.evidence_gate !== null)?.signals.evidence_gate;
      const backend = started ? evidenceBackendById(started.backend) : defaultEvidenceBackend();
      if (backend) variant = backend.remediation;
    }
    steps.push({
      rank: steps.length + 1,
      milestone: id === "branch-protection-backlog" ? "" : id,
      title: variant.title,
      unblocks,
      how: variant.how,
      repos,
      blocks_level: blocksLevel,
      group,
    });
  };

  // The smoke test goes first whenever it is unmet, whatever rung the ramp
  // reports. Being able to give work to an agent the organization controls
  // is what every later milestone builds on, and it is not a level
  // requirement, so nothing else would ever raise it.
  const smoke = byId("e2e-smoketest");
  if (smoke && smoke.status !== "met")
    push("e2e-smoketest", `the end-to-end smoke test — ${smoke.evidence}`, null, "foundation");

  // Every rung still ahead, nearest first and in requirement order inside
  // each rung. The rung after next is not actionable yet, but grouping the
  // whole ramp is what lets a reader see the shape of the climb instead of
  // one step of it — and the ramp is cumulative, so a later rung's work
  // never becomes irrelevant.
  const levels = Object.keys(LEVEL_REQUIREMENTS)
    .map(Number)
    .filter((level) => level > orgLevel)
    .sort((a, b) => a - b);
  for (const level of levels) {
    for (const id of LEVEL_REQUIREMENTS[level]) {
      const m = byId(id);
      if (!m || m.status === "met") continue;
      push(id, `level ${level} (${LEVEL_NAMES[level]}) — ${m.title}: ${m.evidence}`, level, "level");
    }
  }

  // Then hygiene, which no milestone owns and every later one assumes.
  if (failingProtection.length > 0)
    push(
      "branch-protection-backlog",
      `${failingProtection.length} of ${ranked.length} ranked repositories miss the baseline branch-protection rule`,
      null,
      "hygiene",
    );

  return steps.map((step, index) => ({ ...step, rank: index + 1 }));
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

  // Bypass lists and the merged-pull-request sample cost one request each, so
  // they are fetched only where they change an answer: a repository that
  // neither lands agent changes nor carries any evidence shape is scanned
  // exactly as cheaply as before.
  const evidenceRelevant =
    evidenceShaped(paths, requiredCheckContexts(branchRules)) ||
    landsAgentChanges(paths);
  const [bypassActors, sample] = evidenceRelevant
    ? await Promise.all([
        fetchBypassActors(org, listing.name, branchRules),
        fetchMergedSample(org, listing.name),
      ])
    : [null, null];

  return {
    name: listing.name,
    visibility: listing.visibility.toLowerCase(),
    default_branch: branch,
    pushed_at: listing.pushedAt,
    paths,
    agentsMdBody,
    branchRules,
    rulesNote: "branch rules endpoint not readable with this token",
    bypassActors,
    sample,
  };
}

// Cheap predicates over data already in hand, so the decision to spend two
// more requests costs nothing itself.
function evidenceShaped(paths: string[], requiredChecks: string[]): boolean {
  return (
    requiredChecks.some((c) => /evidence|transcript|session-capture|audit/i.test(c)) ||
    paths.some((p) => /evidence|transcript|session-capture|audit|pensieve/i.test(p))
  );
}

function landsAgentChanges(paths: string[]): boolean {
  const ci = paths.filter((p) => CI_DIR.test(p) && /\.ya?ml$/.test(p));
  return ci.some(
    (p) =>
      p.includes("copilot-setup-steps") ||
      (AGENT_WORKFLOW_HINT.test(p) && !AGENT_WORKFLOW_EXCLUDE.test(p) && !/triage/i.test(p)),
  );
}

// The bypass lists of every ruleset contributing a rule to this branch. An
// organization-level ruleset needs org admin to read, so a scan that cannot
// see one returns null — unknown, never "nobody bypasses".
async function fetchBypassActors(
  org: string,
  repo: string,
  branchRules: any[] | null,
): Promise<BypassActor[] | null> {
  const sources = contributingRulesets(branchRules);
  if (sources.length === 0) return branchRules === null ? null : [];
  const lists = await mapLimit(sources, CONCURRENCY, async (source) => {
    const ruleset = await ghJson<any>(["api", `repos/${org}/${repo}/rulesets/${source.id}`]);
    return ruleset === null ? null : readBypassActors(ruleset);
  });
  if (lists.some((list) => list === null)) return null;
  return lists.flat() as BypassActor[];
}

// Was the gate exercised? A required check that never reports leaves a
// pending status and gates nothing, so "required" is not the same fact as
// "ran". The sample is defined in pull requests rather than days, so the
// number is stable between runs of different length.
const MERGED_SAMPLE = 10;

async function fetchMergedSample(org: string, repo: string): Promise<MergedPr[] | null> {
  const prs = await ghJson<any[]>([
    "pr",
    "list",
    "--repo",
    `${org}/${repo}`,
    "--state",
    "merged",
    "--limit",
    String(MERGED_SAMPLE),
    "--json",
    "number,statusCheckRollup",
  ]);
  if (prs === null) return null;
  return prs.map((pr) => ({
    number: Number(pr.number),
    checks: (pr.statusCheckRollup ?? []).map((check: any) => ({
      name: String(check?.name ?? check?.context ?? ""),
      conclusion: String(check?.conclusion ?? check?.state ?? "").toUpperCase(),
    })),
  }));
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
    bypassActors: null,
    sample: null,
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

  // Only repositories the forge listed get a URL. A local-only checkout was
  // never seen on a forge, so a URL built from the owner would be a guess.
  const forgeListed = new Set(listings.map((l) => l.name.toLowerCase()));
  const repos = inputs
    .filter((r): r is RepoInput => r !== null)
    .map((r) => {
      const report = buildRepoReport(r, activeCutoff);
      const url =
        owner && forgeListed.has(basename(r.name).toLowerCase())
          ? `https://github.com/${owner}/${basename(r.name)}`
          : null;
      return { ...report, url };
    });

  // The dotagents catalog, if the org keeps one. Searched across every
  // repository rather than the ranked subset: `.agents` classifies as a meta
  // repo and would be filtered out of the ranking before it could be found.
  const dotagents = repos.find((r) => basename(r.name).toLowerCase() === ".agents") ?? null;

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

  const nextSteps = remediationPlan(milestones, orgLevel, ranked, failing);

  return OrgReport.parse({
    org: unit.label,
    source_type: sourceType(unit),
    identity: unit.identity,
    dotagents_repo: dotagents?.name ?? null,
    dotagents_url: dotagents?.url ?? null,
    scanned_at: new Date().toISOString(),
    sampling_note: samplingNote,
    ranking_note: `ranking covers the ${ranked.length} active catalog/application repos; ${repos.length - ranked.length} inactive or meta repos are listed but not ranked`,
    repos,
    milestones,
    org_level: orgLevel,
    org_level_name: LEVEL_NAMES[orgLevel],
    gaps,
    next_steps: nextSteps,
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
    baseline: {
      name: baselineDoc.name,
      enforcement: baselineDoc.enforcement,
      kind: baselineDoc.kind ?? "",
      doc: baselineDoc,
      raw: baselineRaw,
      audited_rules: AUDITED_RULES,
    },
    evidence_backends: EVIDENCE_BACKENDS.map((b) => ({ id: b.id, name: b.name, docs: b.docs })),
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
