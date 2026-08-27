import assert from "node:assert/strict";
import { assessGitHubScope, canonicalizeAssessment, fingerprintAssessment } from "../dist/core/core.js";
import { observeGitHubRepository } from "../dist/core/octokit.js";
import { createObservationFixtureClient } from "../dist/core/testing.js";

const observation = await observeGitHubRepository(createObservationFixtureClient(), { owner: "acme", name: "widget" });
const assessment = assessGitHubScope({ kind: "installation" }, [{ area: "scope", status: "complete" }], [observation], { generatedAt: "2026-08-26T00:00:00.000Z" });
assert.equal(assessment.model, "readiness-model/v1alpha1");
assert.equal(assessment.currentRung, 2);
assert.equal(assessment.reviewedRung, null);
assert.equal(assessment.rungs[3].status, "not-satisfied");
assert.equal(assessment.rungs[4].status, "unavailable");
assert.match(assessment.limitations[0], /installation-scope/);
assert.equal(assessment.repositories[0].capabilities.find(({ capability }) => capability === "automated-review").state, "detected");
assert.equal(assessment.repositories[0].capabilities.find(({ capability }) => capability === "automated-review").requiredState, "exercised");
assert.equal(assessment.repositories[0].capabilities.find(({ capability }) => capability === "automated-review").title, "Exercised automated review");
assert.match(assessment.repositories[0].capabilities.find(({ capability }) => capability === "automated-review").nextAction, /real change/);

const reversed = structuredClone(observation);
reversed.artifacts.reverse(); reversed.evidence.reverse();
const canonical = canonicalizeAssessment(assessment);
const reordered = assessGitHubScope({ kind: "installation" }, [{ area: "scope", status: "complete" }], [reversed], { generatedAt: "2026-08-26T00:00:00.000Z" });
assert.equal(canonicalizeAssessment(reordered), canonical);
assert.equal(await fingerprintAssessment(reordered), await fingerprintAssessment(assessment));

const incomplete = structuredClone(observation);
incomplete.artifacts = incomplete.artifacts.filter(({ kind }) => kind !== "code-owners");
incomplete.evidence = incomplete.evidence.filter(({ artifact }) => artifact !== "code-owners");
incomplete.coverage[3] = { area: "content", status: "unknown", reason: "permission_denied" };
const partial = assessGitHubScope({ kind: "organization", owner: "acme" }, [{ area: "scope", status: "complete" }], [incomplete], { generatedAt: "2026-08-26T00:00:00.000Z" });
assert.equal(partial.currentRung, 0);
assert.equal(partial.repositories[0].capabilities.find(({ capability }) => capability === "accountable-ownership").state, "unknown");
assert.match(partial.limitations.join(" "), /partial or unknown/);
console.log("readiness assessment tests passed");
