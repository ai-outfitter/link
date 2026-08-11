// Evidence-gate detection, as a pluggable backend registry.
//
// The boundary, first, because everything here depends on it: this module
// answers whether an evidence gate is *wired* and whether it was *exercised*.
// It never answers whether the gate *fired* — whether evidence records exist
// and verify. That means reading a store with a workload identity credential,
// which is `pensieve verify` and the CI gate per CICD-001.6, and a read-only
// forge scan holds no such credential for its own organization, let alone
// somebody else's.
//
//   wired      an effective branch rule requires the check
//   exercised  the check actually reported on what landed
//   verified   the records exist and verify        ← not this tool
//
// The middle rung matters because "required" and "running" are different
// facts. A check that never reports leaves a permanently pending status, and
// what happens next is that somebody removes it or bypasses it.
//
// Backends are plural on purpose. `link` audits organizations it does not
// own, so a scanner that recognized only ai-outfitter's own evidence system
// would be grading strangers on whether they adopted our product and calling
// the result a maturity level. Pensieve is the primary backend because its
// shape is specified; the generic backend is what keeps the milestone
// reachable for an organization that built its own.
//
// Later, a backend MAY gain an optional `verify()` for the case where the
// operator does hold sink credentials for their own organization. The
// interface leaves room for it. Nothing calls it today.

// Who may route around the rules, and how. GitHub's `always` mode makes the
// gate optional for that actor; `pull_request` only relaxes it inside the
// pull-request flow.
export type BypassActor = { who: string; mode: string };

export type MergedPr = {
  number: number;
  checks: { name: string; conclusion: string }[];
};

export type EvidenceInput = {
  // Repository file tree, as `git ls-tree`/`gh api` paths.
  paths: string[];
  // Status-check contexts required on the default branch by effective rules.
  requiredChecks: string[];
  // False when the branch rules could not be read at all. A gate that cannot
  // be seen is unknown, never absent — the difference between "no gate" and
  // "no answer" is the whole honesty position of this report.
  hasBranchRules: boolean;
  // CICD-001.9.3: github.com has no pre-receive hook, so the obligation
  // "every commit on a protected ref carries evidence" has exactly one
  // preventive compilation — forbid direct pushes. Requiring a pull request
  // *is* that control. Null when the rules could not be read.
  directPushesBlocked: boolean | null;
  // Null when a contributing ruleset could not be read: an organization-level
  // ruleset needs org admin, so its bypass list is genuinely unknown rather
  // than empty.
  bypassActors: BypassActor[] | null;
  // The most recently merged pull requests and the checks that reported on
  // them. Null when not sampled.
  sample: MergedPr[] | null;
};

export type EvidenceFinding = {
  backend: string;
  backend_name: string;
  status: "met" | "unmet" | "unknown";
  // True when the gate exists in the tree but no effective rule requires it.
  // Per CICD-001.1.2 a workflow a branch can add or omit is not a control, so
  // a repository can carry the complete gate and be protected by none of it.
  declared_only: boolean;
  tiers: string[];
  // The matched required check contexts.
  required_checks: string[];
  direct_pushes_blocked: boolean | null;
  bypass_actors: BypassActor[];
  // What the sample showed: how many merged pull requests carried a passing
  // check, and which did not.
  sample: { merged_prs: number; gated: number; ungated: number[] } | null;
  // Everything standing between this repository and a met finding. Empty is
  // what makes a finding met, so a new obligation cannot be added without
  // also being reported.
  gaps: string[];
  evidence: string;
  docs: string;
};

export type EvidenceBackend = {
  id: string;
  name: string;
  docs: string;
  // Returns null when nothing of this backend's shape is present, so the
  // registry can tell "not this backend" from "this backend, unsatisfied".
  detect(input: EvidenceInput): EvidenceFinding | null;
  // How to reach a `met` finding with this backend. Every instruction names
  // a signal `detect` reads, so following them changes the next report.
  remediation: { title: string; how: string[] };
};

const CI_DIR = /^\.(github|forgejo|gitea)\/workflows\//;

// Shared shape for both backends: only the check pattern and the tree signals
// differ, and the obligations around them do not.
function assemble(
  backend: EvidenceBackend,
  input: EvidenceInput,
  checkPattern: RegExp,
  parts: { declared: boolean; tiers: string[]; describe: string[] },
): EvidenceFinding {
  const required = input.requiredChecks.filter((context) => checkPattern.test(context));
  const gaps: string[] = [];

  if (required.length === 0) gaps.push("no effective branch rule requires an evidence check");

  // A required check that PRs can bypass entirely is not a control on the
  // branch, only on the pull-request path.
  if (input.directPushesBlocked === false)
    gaps.push(
      "direct pushes to the default branch are not blocked, so a commit can land without passing any check (CICD-001.9.3)",
    );

  // `always` bypass makes the whole ruleset optional for that actor. A
  // break-glass path may exist (CICD-001.7.4), but it has to be a recorded
  // one that produces its own evidence, not a silent ruleset exemption.
  const always = (input.bypassActors ?? []).filter((actor) => actor.mode === "always");
  if (always.length > 0)
    gaps.push(
      `${always.map((a) => a.who).join(", ")} bypass the ruleset unconditionally — a silent ruleset bypass is not a recorded break-glass path`,
    );

  // Exercised: did the check actually report on what landed?
  let sample: EvidenceFinding["sample"] = null;
  if (input.sample !== null && input.sample.length > 0) {
    const gated = input.sample.filter((pr) =>
      pr.checks.some((c) => checkPattern.test(c.name) && c.conclusion === "SUCCESS"),
    );
    const ungated = input.sample.filter((pr) => !gated.includes(pr)).map((pr) => pr.number);
    sample = { merged_prs: input.sample.length, gated: gated.length, ungated };
    if (required.length > 0 && ungated.length > 0)
      gaps.push(
        `${ungated.length} of the last ${input.sample.length} merged pull requests landed with no passing evidence check (#${ungated.join(", #")}) — required and reporting are different facts`,
      );
  }

  const status: EvidenceFinding["status"] =
    !input.hasBranchRules && required.length === 0
      ? "unknown"
      : gaps.length === 0
        ? "met"
        : "unmet";

  const describe = [
    required.length > 0
      ? `required check ${required.join(", ")} on the default branch`
      : "no required evidence check",
    ...parts.describe,
    sample ? `${sample.gated}/${sample.merged_prs} recent merges gated` : null,
  ].filter(Boolean) as string[];

  return {
    backend: backend.id,
    backend_name: backend.name,
    status,
    // Files present, nothing requiring them: the trap worth naming.
    declared_only: required.length === 0 && parts.declared && input.hasBranchRules,
    tiers: parts.tiers,
    required_checks: required,
    direct_pushes_blocked: input.directPushesBlocked,
    bypass_actors: input.bypassActors ?? [],
    sample,
    gaps,
    evidence:
      status === "unknown"
        ? `${describe.join("; ")}; the branch rules could not be read`
        : `${describe.join("; ")}${gaps.length > 0 ? `. Blocking: ${gaps.join("; ")}` : ""}`,
    docs: backend.docs,
  };
}

// ── pensieve ────────────────────────────────────────────────────────────────

// Pensieve is design stage as of 2026-08-07: the actions its example workflows
// reference do not exist yet. That does not weaken this backend, because the
// control is the ruleset and the required check, not the implementation behind
// them. A repository where `evidence/commits` is required and reporting is
// gated whatever produces the check.
const PENSIEVE_POLICY = ".github/pensieve.yml";
const PENSIEVE_RULESETS = /^\.github\/rulesets\/(default-branch|release-tags)\.json$/;
const PENSIEVE_TIERS: [RegExp, string][] = [
  [/^\.(github|forgejo|gitea)\/workflows\/evidence-pr\.ya?ml$/, "tier 1 — pull request and merge queue"],
  [/^\.(github|forgejo|gitea)\/workflows\/evidence-main\.ya?ml$/, "tier 2 — landing and linkage"],
  [/^\.(github|forgejo|gitea)\/workflows\/evidence-reconcile\.ya?ml$/, "tier 2 — completeness"],
];
// `evidence/commits` is the reference name; any context under the `evidence/`
// namespace counts, because the namespace is the convention and the exact
// leaf is the repository's.
const PENSIEVE_CHECK = /^evidence\//;

const pensieve: EvidenceBackend = {
  id: "pensieve",
  name: "Pensieve evidence gates (CICD-001)",
  docs: "https://github.com/ai-outfitter/pensieve/blob/main/docs/requirements/CICD-001-evidence-gates.md",
  detect(input) {
    const tiers = PENSIEVE_TIERS.filter(([pattern]) => input.paths.some((p) => pattern.test(p))).map(
      ([, label]) => label,
    );
    const policy = input.paths.includes(PENSIEVE_POLICY);
    // In-tree ruleset JSON is an import source, never proof of an active
    // rule. It counts toward "declared", never toward "met".
    const rulesetFiles = input.paths.filter((p) => PENSIEVE_RULESETS.test(p));
    const declared = tiers.length > 0 || policy || rulesetFiles.length > 0;
    const required = input.requiredChecks.some((c) => PENSIEVE_CHECK.test(c));
    if (!required && !declared) return null;

    return assemble(pensieve, input, PENSIEVE_CHECK, {
      declared,
      tiers,
      describe: [
        tiers.length > 0 ? `gates: ${tiers.join(", ")}` : null,
        policy ? `policy: ${PENSIEVE_POLICY}` : null,
        rulesetFiles.length > 0 && !required
          ? `${rulesetFiles.join(", ")} is an import source, not an active rule`
          : null,
      ].filter(Boolean) as string[],
    });
  },
  remediation: {
    title: "Require an evidence check on the branch agents land on",
    how: [
      "Copy the gate workflows from `pensieve/code/example-repo/.github/workflows/` into the repository. `evidence-pr.yml` is tier 1 and the one this check reads first.",
      "Add `.github/pensieve.yml` and set `epoch.commit` to the commit from which evidence is required. Without an epoch the first release in an existing repository fails forever (CICD-001.8.1).",
      "Import `.github/rulesets/default-branch.json` with `gh api -X POST /repos/{owner}/{repo}/rulesets --input .github/rulesets/default-branch.json`.",
      "Confirm the active ruleset requires a status check whose context starts with `evidence/`. The scan reads the effective branch rules, so a ruleset file in the tree does not count.",
      "Keep the `pull_request` rule. On github.com there is no pre-receive hook, so requiring a pull request is the only preventive way to stop a commit landing unchecked (CICD-001.9.3).",
      "Leave `bypass_actors` empty. An actor with `always` bypass makes the gate optional, and a silent ruleset bypass is not a break-glass path — record break-glass in `.github/pensieve.yml` instead (CICD-001.7.4).",
      "Report the check on the merge-queue event as well as the pull-request event, under the same name, or the rule is never satisfied in the queue.",
      "Watch the recent merges line in the next report. A required check that never reports leaves a pending status and gates nothing.",
    ],
  },
};

// ── generic ─────────────────────────────────────────────────────────────────

// For an organization that captures evidence with something other than
// Pensieve. Weaker by construction: it recognizes a naming convention rather
// than a specified shape, so it names the context it matched — a false
// positive a reader can see is one a reader can correct.
// `audit` is spelled out as `audit-trail` / `audit-log` rather than left bare.
// Bare `audit` matched `bundle-audit.yml` — a Ruby dependency scanner — and
// would equally match `npm-audit`, `cargo-audit`, and `security-audit`. A
// dependency scan is not a session record, and a backend that claims one as
// evidence reports a gate the organization never built.
const GENERIC_CHECK = /(^|[-_/ ])(evidence|transcript|session-capture|audit-trail|audit-log)([-_/ ]|$)/i;
const GENERIC_WORKFLOW = /(evidence|transcript|session-capture|audit-trail|audit-log)/i;

const generic: EvidenceBackend = {
  id: "generic",
  name: "evidence gate by naming convention",
  docs: "",
  detect(input) {
    const workflows = input.paths.filter((p) => CI_DIR.test(p) && GENERIC_WORKFLOW.test(p));
    const required = input.requiredChecks.some((c) => GENERIC_CHECK.test(c));
    if (!required && workflows.length === 0) return null;
    return assemble(generic, input, GENERIC_CHECK, {
      declared: workflows.length > 0,
      tiers: [],
      describe: workflows.length > 0 ? [`matched by name: ${workflows.join(", ")}`] : [],
    });
  },
  remediation: {
    title: "Require your evidence check on the branch agents land on",
    how: [
      "Make the workflow that captures agent sessions report a status check.",
      "Require that check on the default branch through a ruleset or branch protection.",
      "Name the check so the convention is legible — a context containing `evidence`, `transcript`, `session-capture`, `audit-trail`, or `audit-log`. The scan matches the required check by name; bare `audit` is not matched, because a dependency audit is not a session record.",
      "Block direct pushes to the default branch, or a commit lands without passing the check at all.",
      "Give no actor an unconditional ruleset bypass.",
      "Prefer the Pensieve gate shape if you have no evidence system yet: it is specified rather than inferred, and this backend recognizes a naming convention only.",
    ],
  },
};

// ── registry ────────────────────────────────────────────────────────────────

// Order is precedence for equal-strength findings. Pensieve first: its shape
// is specified, so its finding carries more meaning than a name match.
export const EVIDENCE_BACKENDS: EvidenceBackend[] = [pensieve, generic];

const RANK: Record<EvidenceFinding["status"], number> = { met: 3, unknown: 2, unmet: 1 };

// Every backend runs; the strongest finding wins. An organization is not asked
// to declare which evidence system it uses, because `link` is pointed at
// organizations that never configured it.
export function detectEvidenceGate(input: EvidenceInput): EvidenceFinding | null {
  let best: EvidenceFinding | null = null;
  for (const backend of EVIDENCE_BACKENDS) {
    const finding = backend.detect(input);
    if (finding && (best === null || RANK[finding.status] > RANK[best.status])) best = finding;
  }
  return best;
}

// The remediation to offer when nothing was detected: the specified shape,
// not a naming convention.
export function defaultEvidenceBackend(): EvidenceBackend {
  return pensieve;
}

export function evidenceBackendById(id: string): EvidenceBackend | undefined {
  return EVIDENCE_BACKENDS.find((backend) => backend.id === id);
}

// ── branch-rule reading ─────────────────────────────────────────────────────

// Status-check contexts required by the effective branch rules. Reads the
// `required_status_checks` rule's parameters, which the rules endpoint already
// returns — no extra request.
export function requiredCheckContexts(branchRules: any[] | null): string[] {
  if (branchRules === null) return [];
  return branchRules
    .filter((rule) => rule?.type === "required_status_checks")
    .flatMap((rule) => rule?.parameters?.required_status_checks ?? [])
    .map((check: any) => String(check?.context ?? ""))
    .filter((context: string) => context.length > 0);
}

// Requiring a pull request is the direct-push control on a forge with no
// pre-receive hook. Null when the rules could not be read.
export function directPushesBlocked(branchRules: any[] | null): boolean | null {
  if (branchRules === null) return null;
  return branchRules.some((rule) => rule?.type === "pull_request");
}

// The rulesets that contribute the effective rules, so their bypass lists can
// be read. Repository-sourced rulesets are readable with a normal token;
// organization-sourced ones need org admin.
export function contributingRulesets(
  branchRules: any[] | null,
): { id: number; source: string }[] {
  if (branchRules === null) return [];
  const seen = new Map<number, string>();
  for (const rule of branchRules) {
    const id = Number(rule?.ruleset_id);
    if (Number.isFinite(id) && !seen.has(id)) seen.set(id, String(rule?.ruleset_source_type ?? ""));
  }
  return [...seen].map(([id, source]) => ({ id, source }));
}

// Flatten a ruleset's `bypass_actors` into readable rows.
export function readBypassActors(ruleset: any): BypassActor[] {
  return (ruleset?.bypass_actors ?? []).map((actor: any) => ({
    who:
      actor?.actor_type === "RepositoryRole"
        ? `repository role ${actor?.actor_id}`
        : actor?.actor_type === "OrganizationAdmin"
          ? "organization admins"
          : actor?.actor_type === "DeployKey"
            ? "deploy key"
            : `${actor?.actor_type ?? "actor"} ${actor?.actor_id ?? ""}`.trim(),
    mode: String(actor?.bypass_mode ?? "always"),
  }));
}
