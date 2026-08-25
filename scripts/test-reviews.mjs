import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "link-review-test-"));
process.env.XDG_DATA_HOME = join(temp, "data");
process.env.XDG_CONFIG_HOME = join(temp, "config");
const { reviewInternals } = await import("../code/web/src/lib/reviews.ts");

const fingerprint = "a".repeat(64);
const scan = { scan_id: "scan-1", fingerprint, generated_at: "2026-08-25T12:00:00.000Z" };
const report = { orgs: [{ org: "acme", org_level: 2, repos: [{ name: "app" }], milestones: [
  { id: "instructions", status: "met" },
  { id: "shared-catalog", status: "met" },
  { id: "catalog-consumed", status: "met" },
  { id: "triggered-agents", status: "met" },
  { id: "agent-review", status: "unmet" },
  { id: "protected-landing", status: "met" },
  { id: "session-capture", status: "met" },
  { id: "bot-identity", status: "unknown" },
  { id: "strict-governance", status: "unmet" },
] }] };
const result = {
  version: "reviewed-evidence/v1",
  source_scan: { id: scan.scan_id, fingerprint, generated_at: scan.generated_at },
  scope: { organization: "acme", repositories: ["acme/app"] },
  claims: [{
    target: "agent-review", scanner_status: "unmet", proposed_status: "met",
    disposition: "supplement", confidence: 0.95,
    rationale: "A custom-named job invokes the reviewer.",
    evidence: [{ source_type: "local-file", repository: "acme/app", path: ".github/workflows/quality.yml", locator: "jobs.semantic-review", observation: "The job runs the read-only reviewer on pull requests." }],
  }],
  unresolved_questions: [], evidence_limits: [],
};

assert.deepEqual(reviewInternals.validateResult(JSON.stringify(result), scan, report), result);
assert.deepEqual(reviewInternals.validateResult(JSON.stringify({ structured_output: result }), scan, report), result);
assert.throws(() => reviewInternals.validateResult("```json\n{}\n```", scan, report), /raw JSON/);
assert.throws(() => reviewInternals.validateResult(JSON.stringify({ ...result, source_scan: { ...result.source_scan, fingerprint: "b".repeat(64) } }), scan, report), /stale/);
assert.throws(() => reviewInternals.validateResult(JSON.stringify({ ...result, claims: [...result.claims, result.claims[0]] }), scan, report), /duplicate/);
assert.throws(() => reviewInternals.validateResult(JSON.stringify({ ...result, claims: [{ ...result.claims[0], target: "made-up" }] }), scan, report), /unknown milestone/);

const rejected = reviewInternals.reviewedScores(report, result, [{ target: "agent-review", decision: "rejected", decided_at: "now" }]);
assert.equal(rejected[0].scanner_level, 2);
assert.equal(rejected[0].reviewed_level, 2);
const accepted = reviewInternals.reviewedScores(report, result, [{ target: "agent-review", decision: "accepted", decided_at: "now" }]);
assert.equal(accepted[0].scanner_level, 2);
assert.equal(accepted[0].reviewed_level, 3);

rmSync(temp, { recursive: true, force: true });
console.log("reviewed evidence tests passed");
