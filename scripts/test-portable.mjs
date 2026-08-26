import assert from "node:assert/strict";
import { canonicalizeObservation, fingerprintObservation } from "../dist/core/core.js";
import { listGitHubScope, observeGitHubRepository } from "../dist/core/octokit.js";
import { createObservationFixtureClient, observationFixture } from "../dist/core/testing.js";

const scopeClient = createObservationFixtureClient();
const inventory = await listGitHubScope(scopeClient, { kind: "organization", owner: "acme" });
assert.equal(inventory.repositories.length, 105, "pagination must continue beyond 100 and remove duplicates");
assert.deepEqual(scopeClient.calls.filter((call) => call.route.includes("/repos")).map((call) => call.parameters.page), [1, 2]);
assert.deepEqual(inventory.repositories.map((repo) => repo.fullName),
  [...inventory.repositories.map((repo) => repo.fullName)].sort((a, b) => a.localeCompare(b)));
assert.deepEqual(inventory.coverage, [{ area: "scope", status: "complete" }]);

const installation = await listGitHubScope(createObservationFixtureClient(), { kind: "installation" });
assert.deepEqual(installation.repositories, inventory.repositories, "scope shapes must share normalization");

const observationClient = createObservationFixtureClient();
const observation = await observeGitHubRepository(observationClient, { owner: "acme", name: "widget" });
assert.deepEqual(observation.artifacts.map((artifact) => artifact.path), [
  ".agents/settings.yml", ".github/CODEOWNERS", ".github/workflows/custom-review.yml", "AGENTS.md",
  "agents/reviewer/agent.md",
  "environments/production/deployment.yml", "governance/policy.yml",
]);
assert.equal(observation.artifacts.find((artifact) => artifact.path === "governance/policy.yml").readable, null);
assert.deepEqual(observation.coverage, [
  { area: "metadata", status: "complete" },
  { area: "revision", status: "complete" },
  { area: "manifest", status: "partial", reason: "tree_truncated" },
  { area: "content", status: "unknown", reason: "permission_denied" },
]);
assert(!observationClient.calls.some((call) => call.parameters.tree_sha === "tree-src"), "unbounded directories must not be read");
assert(!observationClient.calls.some((call) => call.parameters.tree_sha === "tree-issues"), "unrecognized subtrees must not be read");
assert(!observationClient.calls.some((call) => call.parameters.path === "README.md"), "unrecognized files must not be read");
assert(!canonicalizeObservation(observation).includes('"content":'), "raw file bodies must not be persisted");

const reordered = structuredClone(observationFixture);
reordered.trees["tree-root"].tree.reverse();
reordered.trees["tree-github"].tree.reverse();
const reorderedObservation = await observeGitHubRepository(createObservationFixtureClient(reordered), { owner: "acme", name: "widget" });
assert.equal(canonicalizeObservation(reorderedObservation), canonicalizeObservation(observation), "tree order must not affect output");
assert.equal(await fingerprintObservation(reorderedObservation), await fingerprintObservation(observation));

const malformedClient = { request: async () => ({ data: { repositories: "nope" } }) };
assert.deepEqual((await listGitHubScope(malformedClient, { kind: "installation" })).coverage,
  [{ area: "scope", status: "unknown", reason: "malformed_response" }]);

const deniedClient = { request: async () => { throw { status: 403 }; } };
assert.deepEqual((await observeGitHubRepository(deniedClient, { owner: "acme", name: "widget" })).coverage[0],
  { area: "metadata", status: "unknown", reason: "permission_denied" });

const missingRevisionFixture = structuredClone(observationFixture);
const missingRevisionClient = createObservationFixtureClient(missingRevisionFixture);
missingRevisionClient.request = async function(route, parameters = {}) {
  if (route.includes("/commits/")) throw { status: 404 };
  return Object.getPrototypeOf(this).request.call(this, route, parameters);
};
assert.deepEqual((await observeGitHubRepository(missingRevisionClient, { owner: "acme", name: "widget" })).coverage[1],
  { area: "revision", status: "unknown", reason: "not_found" });

const rateLimitedFixture = structuredClone(observationFixture);
rateLimitedFixture.contents["AGENTS.md"] = { error: { status: 403, rateLimited: true } };
const rateLimited = await observeGitHubRepository(createObservationFixtureClient(rateLimitedFixture), { owner: "acme", name: "widget" });
assert.equal(rateLimited.coverage[3].status, "unknown");
assert.match(rateLimited.coverage[3].reason, /rate_limited/);

const contentTruncatedFixture = structuredClone(observationFixture);
contentTruncatedFixture.contents["AGENTS.md"] = { type: "file", truncated: true, content: "partial" };
const contentTruncated = await observeGitHubRepository(createObservationFixtureClient(contentTruncatedFixture), { owner: "acme", name: "widget" });
assert.match(contentTruncated.coverage[3].reason, /content_truncated/);

const bounded = await observeGitHubRepository(createObservationFixtureClient(), { owner: "acme", name: "widget" }, { maxArtifacts: 2 });
assert.equal(bounded.artifacts.length, 2);
assert.match(bounded.coverage[2].reason, /artifact_limit/);

console.log(`fixture fingerprint ${await fingerprintObservation(observation)}`);
console.log("portable observation contract tests passed");
