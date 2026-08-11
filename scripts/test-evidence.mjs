// Evidence-gate backend fixtures.
//
// This exists because the check it covers was a hardcoded literal for months:
// `session-capture` reported unmet unconditionally, so a reader who did the
// work exactly as the runbook said was still told they had failed. The point
// of the backends is that following the instructions changes the report, and
// the only way that stays true is a test that fails when it stops being true.
//
// Run with `npm run test:evidence` after `npm run build`.
import { detectEvidenceGate, requiredCheckContexts } from "../dist/evidence.js";

let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const PENSIEVE_TREE = [
  "README.md",
  ".github/pensieve.yml",
  ".github/rulesets/default-branch.json",
  ".github/workflows/evidence-pr.yml",
  ".github/workflows/evidence-main.yml",
];

const RULES_WITH_EVIDENCE_CHECK = [
  { type: "pull_request", parameters: {} },
  {
    type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "ci" }, { context: "evidence/commits" }] },
  },
];

const RULES_WITHOUT = [
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } },
];

// The required check is read out of the rule parameters the scan already has.
check(
  "required contexts are read from the rules payload",
  requiredCheckContexts(RULES_WITH_EVIDENCE_CHECK),
  ["ci", "evidence/commits"],
);
check("unreadable rules yield no contexts", requiredCheckContexts(null), []);

// The gate is required: met. This is the transition the remediation promises.
const met = detectEvidenceGate({
  paths: PENSIEVE_TREE,
  requiredChecks: requiredCheckContexts(RULES_WITH_EVIDENCE_CHECK),
  hasBranchRules: true,
});
check("required evidence check is met", [met.backend, met.status, met.declared_only], [
  "pensieve",
  "met",
  false,
]);

// A required check with no gate files in tree is still met: the ruleset is
// the control, and it may be defined at organization level.
const orgLevelRuleset = detectEvidenceGate({
  paths: ["README.md"],
  requiredChecks: ["evidence/commits"],
  hasBranchRules: true,
});
check(
  "an org-level ruleset with no repo files is met",
  [orgLevelRuleset.backend, orgLevelRuleset.status],
  ["pensieve", "met"],
);

// The whole example tree, required by nothing: the CICD-001.1.2 trap.
const declaredOnly = detectEvidenceGate({
  paths: PENSIEVE_TREE,
  requiredChecks: requiredCheckContexts(RULES_WITHOUT),
  hasBranchRules: true,
});
check(
  "gate files with no required check are declared only",
  [declaredOnly.backend, declaredOnly.status, declaredOnly.declared_only],
  ["pensieve", "unmet", true],
);

// Unreadable rules must not read as absence.
const unreadable = detectEvidenceGate({
  paths: PENSIEVE_TREE,
  requiredChecks: [],
  hasBranchRules: false,
});
check("unreadable rules yield unknown, not unmet", unreadable.status, "unknown");

// Nothing at all: no backend claims the repository.
check(
  "an unrelated repository yields no finding",
  detectEvidenceGate({ paths: ["README.md", "src/main.ts"], requiredChecks: ["ci"], hasBranchRules: true }),
  null,
);

// The generic backend keeps the milestone reachable without Pensieve, and
// names the context it matched so a false positive is visible.
const generic = detectEvidenceGate({
  paths: [".github/workflows/audit-trail.yml"],
  requiredChecks: ["session-capture/verify"],
  hasBranchRules: true,
});
check("a non-pensieve evidence check is met by the generic backend", [generic.backend, generic.status], [
  "generic",
  "met",
]);
if (!generic.evidence.includes("session-capture/verify")) {
  failures++;
  console.error("FAIL generic backend must name the context it matched");
} else {
  console.log("ok   generic backend names the matched context");
}

// Pensieve wins when both match: its shape is specified, the other inferred.
const both = detectEvidenceGate({
  paths: [...PENSIEVE_TREE, ".github/workflows/audit-trail.yml"],
  requiredChecks: ["evidence/commits", "audit/verify"],
  hasBranchRules: true,
});
check("pensieve takes precedence over the generic backend", both.backend, "pensieve");

console.log(failures === 0 ? "\nevidence backends: all fixtures pass" : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
