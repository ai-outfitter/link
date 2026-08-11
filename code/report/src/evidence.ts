// Evidence-gate detection, as a pluggable backend registry.
//
// The boundary, first, because everything here depends on it: this module
// answers whether an evidence gate is *wired*, never whether it *fired*.
// Verifying that evidence records exist means reading a sink with a workload
// identity credential — that is `pensieve verify` and the CI gate itself, per
// CICD-001.6, and a read-only forge scan holds no such credential for its own
// organization, let alone somebody else's. A scanner that claimed otherwise
// would be reporting an unverifiable fact as a measured one.
//
// Backends are plural on purpose. `link` audits organizations it does not
// own, so a scanner that recognized only ai-outfitter's own evidence system
// would be grading strangers on whether they adopted our product and calling
// the result a maturity level. Pensieve is the primary backend because its
// shape is specified; the generic backend is what keeps the milestone
// reachable for an organization that built its own.
//
// Everything is derived from data the scan already has: the repository file
// tree, and the effective branch rules that `runReport` already fetches. No
// backend adds a network call, and two runs of the same repository produce
// the same finding.
//
// Later, a backend MAY gain an optional `verify()` for the case where the
// operator does hold sink credentials for their own organization. The
// interface leaves room for it. Nothing calls it today.

export type EvidenceInput = {
  // Repository file tree, as `git ls-tree`/`gh api` paths.
  paths: string[];
  // Status-check contexts required on the default branch by effective rules.
  requiredChecks: string[];
  // False when the branch rules could not be read at all. A gate that cannot
  // be seen is unknown, never absent — the difference between "no gate" and
  // "no answer" is the whole honesty position of this report.
  hasBranchRules: boolean;
};

export type EvidenceFinding = {
  // Backend id that produced this finding.
  backend: string;
  backend_name: string;
  status: "met" | "unmet" | "unknown";
  // True when the gate exists in the tree but no effective rule requires it.
  // This is the finding the whole feature is for: per CICD-001.1.2 a workflow
  // a branch can add or omit is not a control, so a repository can carry the
  // complete gate and be protected by none of it.
  declared_only: boolean;
  // Which gate tiers were recognized, for the reader who wants to know how
  // far the adoption went.
  tiers: string[];
  evidence: string;
  // Reference for the shape this backend looked for.
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

// ── pensieve ────────────────────────────────────────────────────────────────

// Pensieve is design stage as of 2026-08-07: the actions its example workflows
// reference do not exist yet. That does not weaken this backend, because the
// control is the ruleset and the required check, not the implementation behind
// them. A repository where `evidence/commits` is required and reporting is
// gated whatever produces the check.
const PENSIEVE_POLICY = ".github/pensieve.yml";
const PENSIEVE_RULESETS = /^\.github\/rulesets\/(default-branch|release-tags)\.json$/;
// The tier workflows from CICD-001, by the names the reference repository uses.
const PENSIEVE_TIERS: [RegExp, string][] = [
  [/^\.(github|forgejo|gitea)\/workflows\/evidence-pr\.ya?ml$/, "tier 1 — pull request and merge queue"],
  [/^\.(github|forgejo|gitea)\/workflows\/evidence-main\.ya?ml$/, "tier 2 — landing and linkage"],
  [/^\.(github|forgejo|gitea)\/workflows\/evidence-reconcile\.ya?ml$/, "tier 2 — completeness"],
];
// The required check that makes the gate a control. `evidence/commits` is the
// reference name; any context under the `evidence/` namespace counts, because
// the namespace is the convention and the exact leaf is the repository's.
const PENSIEVE_CHECK = /^evidence\//;

const pensieve: EvidenceBackend = {
  id: "pensieve",
  name: "Pensieve evidence gates (CICD-001)",
  docs: "https://github.com/ai-outfitter/pensieve/blob/main/docs/requirements/CICD-001-evidence-gates.md",
  detect(input) {
    const required = input.requiredChecks.filter((context) => PENSIEVE_CHECK.test(context));
    const tiers = PENSIEVE_TIERS.filter(([pattern]) => input.paths.some((p) => pattern.test(p))).map(
      ([, label]) => label,
    );
    const policy = input.paths.includes(PENSIEVE_POLICY);
    const rulesetFiles = input.paths.filter((p) => PENSIEVE_RULESETS.test(p));
    const declared = tiers.length > 0 || policy || rulesetFiles.length > 0;

    if (required.length === 0 && !declared) return null;

    const found = (base: string) =>
      [
        base,
        tiers.length > 0 ? `gates: ${tiers.join(", ")}` : null,
        policy ? `policy: ${PENSIEVE_POLICY}` : null,
      ]
        .filter(Boolean)
        .join("; ");

    if (required.length > 0)
      return {
        backend: pensieve.id,
        backend_name: pensieve.name,
        status: "met",
        declared_only: false,
        tiers,
        evidence: found(`required check ${required.join(", ")} on the default branch`),
        docs: pensieve.docs,
      };

    // Files but no required check. Either the rules could not be read, or the
    // gate is installed and enforcing nothing.
    if (!input.hasBranchRules)
      return {
        backend: pensieve.id,
        backend_name: pensieve.name,
        status: "unknown",
        declared_only: false,
        tiers,
        evidence: found("gate files present, but the branch rules could not be read"),
        docs: pensieve.docs,
      };

    return {
      backend: pensieve.id,
      backend_name: pensieve.name,
      status: "unmet",
      declared_only: true,
      tiers,
      evidence: found(
        `no effective rule requires an evidence/* check${
          rulesetFiles.length > 0
            ? `; ${rulesetFiles.join(", ")} is an import source, not an active rule`
            : ""
        } — a workflow a branch can add or omit is not a gate (CICD-001.1.2)`,
      ),
      docs: pensieve.docs,
    };
  },
  remediation: {
    title: "Require an evidence check on the branch agents land on",
    how: [
      "Copy the gate workflows from `pensieve/code/example-repo/.github/workflows/` into the repository. `evidence-pr.yml` is tier 1 and the one this check reads first.",
      "Add `.github/pensieve.yml` and set `epoch.commit` to the commit from which evidence is required. Without an epoch the first release in an existing repository fails forever (CICD-001.8.1).",
      "Import `.github/rulesets/default-branch.json` with `gh api -X POST /repos/{owner}/{repo}/rulesets --input .github/rulesets/default-branch.json`.",
      "Confirm the ruleset requires a status check whose context starts with `evidence/`. The scan reads the effective branch rules, so a ruleset that is not active does not count.",
      "The required check is the control, not the workflow file. A repository that carries every gate file and requires no check is reported as declared only, because a branch that can omit the workflow routes around it (CICD-001.1.2).",
      "The check must report on the merge-queue event as well as the pull-request event, under the same name, or the rule is never satisfied in the queue.",
    ],
  },
};

// ── generic ─────────────────────────────────────────────────────────────────

// For an organization that captures evidence with something other than
// Pensieve. Weaker by construction: it recognizes a naming convention rather
// than a specified shape, so it names the context it matched — a false
// positive a reader can see is one a reader can correct.
const GENERIC_CHECK = /(^|[-_/ ])(evidence|transcript|session-capture|audit)([-_/ ]|$)/i;
const GENERIC_WORKFLOW = /(evidence|transcript|session-capture|audit)/i;

const generic: EvidenceBackend = {
  id: "generic",
  name: "evidence gate by naming convention",
  docs: "",
  detect(input) {
    const required = input.requiredChecks.filter((context) => GENERIC_CHECK.test(context));
    const workflows = input.paths.filter((p) => CI_DIR.test(p) && GENERIC_WORKFLOW.test(p));
    if (required.length === 0 && workflows.length === 0) return null;

    if (required.length > 0)
      return {
        backend: generic.id,
        backend_name: generic.name,
        status: "met",
        declared_only: false,
        tiers: [],
        evidence: `required check ${required.join(", ")} on the default branch, matched by name`,
        docs: generic.docs,
      };

    if (!input.hasBranchRules)
      return {
        backend: generic.id,
        backend_name: generic.name,
        status: "unknown",
        declared_only: false,
        tiers: [],
        evidence: `${workflows.join(", ")} looks like an evidence workflow, but the branch rules could not be read`,
        docs: generic.docs,
      };

    return {
      backend: generic.id,
      backend_name: generic.name,
      status: "unmet",
      declared_only: true,
      tiers: [],
      evidence: `${workflows.join(", ")} looks like an evidence workflow, but no effective rule requires a matching check`,
      docs: generic.docs,
    };
  },
  remediation: {
    title: "Require your evidence check on the branch agents land on",
    how: [
      "Make the workflow that captures agent sessions report a status check.",
      "Require that check on the default branch through a ruleset or branch protection.",
      "Name the check so the convention is legible — a context containing `evidence`, `transcript`, `session-capture`, or `audit`. The scan matches the required check by name.",
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
