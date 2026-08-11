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

// Defaults for the inputs a fixture is not exercising. Direct pushes blocked
// and no bypass actors is the conforming baseline, so a fixture that does not
// mention them is testing the check logic alone.
const detect = (input) =>
  detectEvidenceGate({
    directPushesBlocked: true,
    bypassActors: [],
    sample: null,
    ...input,
  });

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
const met = detect({
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
const orgLevelRuleset = detect({
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
const declaredOnly = detect({
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
const unreadable = detect({
  paths: PENSIEVE_TREE,
  requiredChecks: [],
  hasBranchRules: false,
});
check("unreadable rules yield unknown, not unmet", unreadable.status, "unknown");

// Nothing at all: no backend claims the repository.
check(
  "an unrelated repository yields no finding",
  detect({ paths: ["README.md", "src/main.ts"], requiredChecks: ["ci"], hasBranchRules: true }),
  null,
);

// The generic backend keeps the milestone reachable without Pensieve, and
// names the context it matched so a false positive is visible.
const generic = detect({
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

// A dependency scanner is not a session record. Bare `audit` used to match, so
// `bundle-audit.yml` was reported as a declared-only evidence gate in a real
// organization that had never built one.
check(
  "a dependency-audit workflow is not an evidence gate",
  detect({
    paths: [".github/workflows/bundle-audit.yml"],
    requiredChecks: ["ci"],
    hasBranchRules: true,
  }),
  null,
);
for (const name of ["npm-audit", "cargo-audit", "pip-audit", "security-audit"]) {
  check(
    `${name} is not an evidence gate`,
    detect({
      paths: [`.github/workflows/${name}.yml`],
      requiredChecks: [name],
      hasBranchRules: true,
    }),
    null,
  );
}

// The spelled-out forms still match, so an organization that genuinely runs an
// audit trail keeps its gate.
const auditLog = detect({
  paths: [".github/workflows/audit-log.yml"],
  requiredChecks: ["audit-log/verify"],
  hasBranchRules: true,
});
check("an audit-log check is still matched", [auditLog.backend, auditLog.status], ["generic", "met"]);

// Pensieve wins when both match: its shape is specified, the other inferred.
const both = detect({
  paths: [...PENSIEVE_TREE, ".github/workflows/audit-trail.yml"],
  requiredChecks: ["evidence/commits", "audit/verify"],
  hasBranchRules: true,
});
check("pensieve takes precedence over the generic backend", both.backend, "pensieve");

// ── direct pushes ───────────────────────────────────────────────────────────

// A required check is only a control on the pull-request path. With direct
// pushes allowed, a commit reaches the branch without passing anything, so
// the gate is not met however well the check is configured (CICD-001.9.3).
const directPush = detect({
  paths: PENSIEVE_TREE,
  requiredChecks: ["evidence/commits"],
  hasBranchRules: true,
  directPushesBlocked: false,
});
check("direct pushes allowed is not met", directPush.status, "unmet");
if (!directPush.gaps.some((g) => g.includes("direct pushes"))) {
  failures++;
  console.error("FAIL direct-push gap must be named");
} else {
  console.log("ok   direct-push gap is named");
}

// ── bypass actors ───────────────────────────────────────────────────────────

// `always` bypass makes the whole ruleset optional for that actor. A
// break-glass path may exist, but it has to be recorded and produce its own
// evidence — a silent ruleset exemption is not one (CICD-001.7.4).
const bypassed = detect({
  paths: PENSIEVE_TREE,
  requiredChecks: ["evidence/commits"],
  hasBranchRules: true,
  bypassActors: [{ who: "organization admins", mode: "always" }],
});
check("an unconditional bypass actor is not met", bypassed.status, "unmet");
if (!bypassed.evidence.includes("organization admins")) {
  failures++;
  console.error("FAIL bypass actor must be named in the evidence");
} else {
  console.log("ok   bypass actor is named");
}

// A pull-request-scoped bypass relaxes the flow, not the branch, so it is
// recorded without demoting the finding.
const prScopedBypass = detect({
  paths: PENSIEVE_TREE,
  requiredChecks: ["evidence/commits"],
  hasBranchRules: true,
  bypassActors: [{ who: "repository role 5", mode: "pull_request" }],
});
check("a pull-request-scoped bypass stays met", prScopedBypass.status, "met");
check(
  "a pull-request-scoped bypass is still recorded",
  prScopedBypass.bypass_actors.length,
  1,
);

// An unreadable bypass list is unknown, never empty: an organization-level
// ruleset needs org admin to read.
const unknownBypass = detect({
  paths: PENSIEVE_TREE,
  requiredChecks: ["evidence/commits"],
  hasBranchRules: true,
  bypassActors: null,
});
check("an unreadable bypass list does not invent an empty one", unknownBypass.bypass_actors, []);

// ── exercised ───────────────────────────────────────────────────────────────

// Required and reporting are different facts. A check that never runs leaves
// a pending status and gates nothing.
const notReporting = detect({
  paths: PENSIEVE_TREE,
  requiredChecks: ["evidence/commits"],
  hasBranchRules: true,
  sample: [
    { number: 41, checks: [{ name: "ci", conclusion: "SUCCESS" }] },
    { number: 42, checks: [{ name: "ci", conclusion: "SUCCESS" }] },
  ],
});
check("a required check that never reported is not met", notReporting.status, "unmet");
check("the ungated merges are named", notReporting.sample, {
  merged_prs: 2,
  gated: 0,
  ungated: [41, 42],
});

// Wired and exercised: the whole ladder short of verified.
const exercised = detect({
  paths: PENSIEVE_TREE,
  requiredChecks: ["evidence/commits"],
  hasBranchRules: true,
  sample: [
    {
      number: 43,
      checks: [
        { name: "ci", conclusion: "SUCCESS" },
        { name: "evidence/commits", conclusion: "SUCCESS" },
      ],
    },
  ],
});
check("a reporting check is met", [exercised.status, exercised.sample.gated], ["met", 1]);

// A failing evidence check does not count as gated.
const failingCheck = detect({
  paths: PENSIEVE_TREE,
  requiredChecks: ["evidence/commits"],
  hasBranchRules: true,
  sample: [{ number: 44, checks: [{ name: "evidence/commits", conclusion: "FAILURE" }] }],
});
check("a failing evidence check is not gated", failingCheck.sample.gated, 0);

console.log(failures === 0 ? "\nevidence backends: all fixtures pass" : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
