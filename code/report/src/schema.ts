import { z } from "zod";

export const LEVEL_NAMES = [
  "none",
  "assisted",
  "delegated",
  "automated",
  "governed",
  "self-improving",
] as const;

// What an evidence-gate backend found for one repository. Null when no
// backend recognized anything: absence, recorded as absence.
export const EvidenceFinding = z.object({
  backend: z.string(),
  backend_name: z.string(),
  status: z.enum(["met", "unmet", "unknown"]),
  // The gate exists in the tree and no effective rule requires it. A workflow
  // a branch can add or omit is not a control (CICD-001.1.2), so this reads
  // as unmet however complete the files are.
  declared_only: z.boolean(),
  tiers: z.array(z.string()),
  // The matched required check contexts.
  required_checks: z.array(z.string()).default([]),
  // Requiring a pull request is the only preventive direct-push control on a
  // forge with no pre-receive hook (CICD-001.9.3). Null when unreadable.
  direct_pushes_blocked: z.boolean().nullable().default(null),
  // Who may route around the ruleset. `always` makes the gate optional for
  // that actor; a silent ruleset bypass is not a recorded break-glass path.
  bypass_actors: z
    .array(z.object({ who: z.string(), mode: z.string() }))
    .default([]),
  // Whether the gate was exercised: how many recently merged pull requests
  // carried a passing evidence check. Required and reporting are different
  // facts. Null when not sampled.
  sample: z
    .object({
      merged_prs: z.number().int().min(0),
      gated: z.number().int().min(0),
      ungated: z.array(z.number().int()),
    })
    .nullable()
    .default(null),
  // Everything standing between this repository and a met finding. Empty is
  // what makes a finding met, so a new obligation cannot be added without
  // also being reported.
  gaps: z.array(z.string()).default([]),
  evidence: z.string(),
  docs: z.string(),
});

export const Signals = z.object({
  agents_md: z.boolean(),
  claude_md: z.boolean(),
  // The contributor-docs convention: CONTRIBUTING.md carries the shared
  // contributor docs for humans and agents, AGENTS.md stays light and
  // references it, DESIGN.md governs frontend and generated documents.
  contributing_md: z.boolean(),
  design_md: z.boolean(),
  // True when AGENTS.md references CONTRIBUTING.md; only meaningful when
  // both files exist.
  agents_links_contributing: z.boolean(),
  dotagents_tree: z.boolean(),
  ci_workflows: z.number().int().min(0),
  agent_workflows: z.array(z.string()),
  // Catalog-repo signals: an Outfitter catalog carries its payload at the
  // repo root, so .agents/ and .github/workflows/ heuristics miss it.
  catalog: z.boolean(),
  declared_workflows: z.array(z.string()),
  governance: z.boolean(),
  // copilot-setup-steps.yml is not an agent workflow itself, but it is
  // evidence the forge's coding agent is enabled for this repo.
  copilot_agent: z.boolean(),
  // deploy/<agent>.yaml manifests beside a dotagents payload: a resident
  // agent deployment (self-hosted, e.g. via agent-operator), not a SaaS
  // coding agent.
  resident_deploy: z.boolean(),
  // deploy/ manifests alone; residency also counts when the org keeps its
  // catalog in a sibling repo (the catalog-apart-from-deployment shape).
  deploy_manifests: z.boolean(),
  docs: z.enum(["none", "thin", "adequate"]),
  // Whether an evidence gate is wired on the branch agents land on. Whether
  // it ever fired is a sink question this scan cannot answer — see
  // evidence.ts for that boundary.
  evidence_gate: EvidenceFinding.nullable().default(null),
});

export const Role = z.enum(["catalog", "application", "meta"]);

export const Milestone = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["met", "unmet", "unknown"]),
  evidence: z.string(),
  // The rung this milestone gates, so a reader can tell at a glance which
  // rung an unmet row is holding up. Null for the smoke test, which is a
  // precondition of the whole ramp rather than a step on it.
  level: z.number().int().min(1).max(5).nullable().default(null),
});

// One remediation action, ranked. The report's purpose is not to grade an
// organization but to tell it what to do next, in the order that moves it up
// the ramp, so this is the part a reader acts on.
export const NextStep = z.object({
  // 1 is the action to take first. The order is the product: a list of
  // everything wrong is a backlog, and a backlog is not a plan.
  rank: z.number().int().min(1),
  // The milestone this unblocks; empty for baseline hygiene that no
  // milestone owns.
  milestone: z.string(),
  // Imperative, one action.
  title: z.string(),
  // What the step buys, in the ramp's terms.
  unblocks: z.string(),
  // Ordered instructions. Each one matches a signal the scanner reads, so
  // completing them changes the next report.
  how: z.array(z.string()),
  // Where to do the work, when the scan can name it.
  repos: z.array(z.string()),
  // The level this step gates, or null when no level owns it.
  blocks_level: z.number().int().min(0).max(5).nullable(),
  // Which band the step belongs to, for grouping. `foundation` is the smoke
  // test, which gates nothing and blocks everything; `level` steps carry a
  // `blocks_level`; `hygiene` is baseline conformance no milestone owns.
  group: z.enum(["foundation", "level", "hygiene"]).default("level"),
});

export const BaselineCheck = z.object({
  rule: z.string(),
  status: z.enum(["pass", "fail", "unknown"]),
  note: z.string(),
});

export const RepoReport = z.object({
  name: z.string(),
  // Forge URL, for repositories the scan listed from a forge. A local-only
  // checkout has none: it was never seen on a forge, and a guessed URL that
  // 404s is worse than no link.
  url: z.string().nullable().default(null),
  visibility: z.string(),
  default_branch: z.string(),
  pushed_at: z.string(),
  active: z.boolean(),
  role: Role,
  signals: Signals,
  baseline: z.array(BaselineCheck),
  level: z.number().int().min(0).max(5),
  level_name: z.enum(LEVEL_NAMES),
});

export const OrgReport = z.object({
  org: z.string(),
  // Which evidence sources this unit was built from, joined with "+" in a
  // fixed order: org listing, named repositories, local folders. A value
  // without "github-org" saw only the repositories it names, so the level
  // derived from it describes those repositories, not the organization.
  source_type: z.enum([
    "github-org",
    "github-repo",
    "folder",
    "github-org+github-repo",
    "github-org+folder",
    "github-repo+folder",
    "github-org+github-repo+folder",
  ]),
  // Canonical identity resolved from git remotes (host/owner), used to
  // merge a local checkout folder with the forge org it clones.
  identity: z.string().nullable(),
  // The org's dotagents catalog repository, when the scan found one. It is
  // the canonical eval anchor, so the report points at it rather than
  // leaving the reader to guess where the org keeps its agent definitions.
  dotagents_repo: z.string().nullable().default(null),
  dotagents_url: z.string().nullable().default(null),
  scanned_at: z.string(),
  sampling_note: z.string(),
  ranking_note: z.string(),
  repos: z.array(RepoReport),
  milestones: z.array(Milestone),
  org_level: z.number().int().min(0).max(5),
  org_level_name: z.enum(LEVEL_NAMES),
  gaps: z.array(z.string()),
  // The same findings as `gaps`, ordered and made actionable. `gaps` stays
  // for anything that already parses it.
  next_steps: z.array(NextStep).default([]),
});

export const Report = z.object({
  generated_at: z.string(),
  // The policy travels with the report. A report filed into an org's
  // `.agents` catalog is evidence, and evidence that cites a policy without
  // carrying it cannot be re-read once the policy moves on.
  baseline: z.object({
    name: z.string(),
    enforcement: z.string(),
    kind: z.string().default(""),
    // The policy document as parsed, and its YAML source. The site renders
    // both, so nobody has to open the package to read what was audited.
    doc: z.record(z.string(), z.unknown()).default({}),
    raw: z.string().default(""),
    // The rules this scanner measures. Every other rule in the policy is
    // stated but unmeasured, and the site says which is which — an
    // unmeasured rule read as a passing one is a false clean bill.
    audited_rules: z.array(z.string()).default([]),
  }),
  // The evidence-gate backends this scan looked for. A reader who sees
  // `session-capture` unmet is owed the list of shapes that would have
  // satisfied it, so an organization running its own system can tell whether
  // it was looked for or merely not recognized.
  evidence_backends: z
    .array(z.object({ id: z.string(), name: z.string(), docs: z.string() }))
    .default([]),
  orgs: z.array(OrgReport),
  evidence_limits: z.array(z.string()),
});

export type Report = z.infer<typeof Report>;
export type Milestone = z.infer<typeof Milestone>;
export type Role = z.infer<typeof Role>;
export type OrgReport = z.infer<typeof OrgReport>;
export type RepoReport = z.infer<typeof RepoReport>;
export type Signals = z.infer<typeof Signals>;
export type BaselineCheck = z.infer<typeof BaselineCheck>;
export type EvidenceFinding = z.infer<typeof EvidenceFinding>;
export type NextStep = z.infer<typeof NextStep>;

// Loose view of an agent-workflow/v1 document, for the web's workflow pages.
// The authoritative validation is spec/agent-workflow.v1.schema.json in CI;
// this schema only shapes what the site renders.
export const WorkflowStep = z
  .object({
    id: z.string().optional(),
    agent: z.string().optional(),
    run: z.string().optional(),
    if: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    "posts-to": z.string().optional(),
    "runs-on": z.string().optional(),
    emit: z.record(z.string(), z.unknown()).optional(),
    output: z.unknown().optional(),
    reviewers: z.array(z.string()).optional(),
  })
  .loose();

export const WorkflowDoc = z
  .object({
    kind: z.string(),
    name: z.string(),
    on: z.record(z.string(), z.unknown()),
    steps: z.array(WorkflowStep),
  })
  .loose();

export const WorkflowsFile = z.array(
  z.object({
    file: z.string(),
    raw: z.string(),
    doc: WorkflowDoc,
  }),
);

export type WorkflowsFile = z.infer<typeof WorkflowsFile>;
