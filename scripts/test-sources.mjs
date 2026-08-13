// Dotagents source-declaration fixtures. Run after `npm run build`.
import {
  catalogSourceFindings,
  declaredSourceSignals,
  githubSourceIdentity,
  parseDeclaredSources,
  resolvePinnedGithubSources,
} from "../dist/sources.js";
import {
  catalogConsumptionAssessment,
  classifyRole,
  classifySignals,
} from "../dist/index.js";

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

check(
  "sources and optional refs are parsed",
  parseDeclaredSources(`
sources:
  - github: ai-outfitter/.agents
  - github: ai-outfitter/community-profiles
    ref: v1.2.1
`),
  [
    { github: "ai-outfitter/.agents" },
    { github: "ai-outfitter/community-profiles", ref: "v1.2.1" },
  ],
);

check("malformed settings do not throw", parseDeclaredSources("sources: [\n"), null);
check("an invalid sources shape is absent", parseDeclaredSources("sources: nope\n"), null);
check(
  "legal non-GitHub sources do not hide a GitHub source",
  parseDeclaredSources(`
sources:
  - github: example/catalog
    ref: v1.0.0
  - uri: https://example.com/catalog.tar.gz
`),
  [{ github: "example/catalog", ref: "v1.0.0" }],
);
check(
  "scalar refs are normalized to strings",
  parseDeclaredSources("sources:\n  - github: example/catalog\n    ref: 1.2\n"),
  [{ github: "example/catalog", ref: "1.2" }],
);
check(
  "missing settings are distinct from malformed settings",
  [declaredSourceSignals(undefined), declaredSourceSignals("sources: nope\n")],
  [
    { declared_sources: null, settings_unparseable: false },
    { declared_sources: null, settings_unparseable: true },
  ],
);

const catalog = [{ github: "ai-outfitter/community-profiles", ref: "v1.2.1" }];

check(
  "a competing repo pin produces a finding with both refs",
  catalogSourceFindings("ai-outfitter", catalog, [
    {
      name: "wiki",
      declared_sources: [{ github: "ai-outfitter/community-profiles", ref: "v1.2.0" }],
    },
  ]),
  [
    {
      kind: "competing-source",
      repo: "wiki",
      source: "ai-outfitter/community-profiles",
      repoRef: "v1.2.0",
      catalogRef: "v1.2.1",
    },
  ],
);

check(
  "an unpinned organization catalog is compliant",
  catalogSourceFindings("ai-outfitter", catalog, [
    { name: "wiki", declared_sources: [{ github: "ai-outfitter/.agents" }] },
  ]),
  [],
);

check(
  "a pinned organization catalog produces the lesser finding",
  catalogSourceFindings("ai-outfitter", catalog, [
    {
      name: "wiki",
      declared_sources: [{ github: "ai-outfitter/.agents", ref: "v1.0.0" }],
    },
  ]),
  [
    {
      kind: "pinned-org-catalog",
      repo: "wiki",
      source: "ai-outfitter/.agents",
      repoRef: "v1.0.0",
    },
  ],
);

check(
  "no settings declaration produces no finding",
  catalogSourceFindings("ai-outfitter", catalog, [{ name: "wiki", declared_sources: null }]),
  [],
);

const scannedSources = new Map([
  ["github:ai-outfitter/.agents", { catalog: true }],
  ["github:ai-outfitter/community-profiles", { catalog: true }],
]);

check(
  "GitHub source identities are canonical and reject non-owner/repo shapes",
  [githubSourceIdentity("AI-Outfitter/.Agents"), githubSourceIdentity("not-a-repository")],
  ["github:ai-outfitter/.agents", null],
);

check(
  "pinned declarations and an allowed unpinned org catalog resolve to scanned sources",
  resolvePinnedGithubSources(
    [
      { github: "AI-Outfitter/.Agents", ref: "v1.0.0" },
      { github: "ai-outfitter/community-profiles" },
      { github: "example/missing", ref: "main" },
    ],
    scannedSources,
    new Set(["github:ai-outfitter/community-profiles"]),
  ),
  [
    {
      source: { github: "AI-Outfitter/.Agents", ref: "v1.0.0" },
      identity: "github:ai-outfitter/.agents",
      value: { catalog: true },
      trackingOrgCatalog: false,
    },
    {
      source: { github: "ai-outfitter/community-profiles" },
      identity: "github:ai-outfitter/community-profiles",
      value: { catalog: true },
      trackingOrgCatalog: true,
    },
    {
      source: { github: "example/missing", ref: "main" },
      identity: "github:example/missing",
      value: null,
      trackingOrgCatalog: false,
    },
  ],
);

const noEvidenceGate = null;
const applicationSignals = (paths, declared_sources) =>
  classifySignals(paths, null, declared_sources, false, noEvidenceGate);
const scannedCatalogSignals = applicationSignals(
  ["agents/reviewer/agent.md", "governance/policy.yml"],
  null,
);
const assessmentSources = new Map([
  ["github:ai-outfitter/.agents", scannedCatalogSignals],
]);
const assessApplication = (name, paths, declared_sources) => {
  const signals = applicationSignals(paths, declared_sources);
  const role = classifyRole(name, paths, signals);
  return {
    catalog: signals.catalog,
    role,
    assessment:
      role === "application"
        ? catalogConsumptionAssessment(
            { name, signals },
            "github.com/ai-outfitter",
            assessmentSources,
          )
        : null,
  };
};

check(
  "an application with root settings tracks the unpinned org catalog without becoming a catalog",
  assessApplication("wiki", ["settings.yml", "src/index.ts"], [
    { github: "ai-outfitter/.agents" },
  ]),
  {
    catalog: false,
    role: "application",
    assessment: {
      status: "met",
      evidence:
        "wiki inherits from ai-outfitter/.agents tracking the org catalog; catalog contents were verified from the scanned org catalog's current revision",
    },
  },
);

check(
  "a pinned org catalog declaration remains consumption evidence",
  assessApplication("app", ["settings.yml", "src/app.ts"], [
    { github: "ai-outfitter/.agents", ref: "v1.2.0" },
  ]),
  {
    catalog: false,
    role: "application",
    assessment: {
      status: "met",
      evidence:
        "app inherits from ai-outfitter/.agents at ref v1.2.0; catalog contents were verified from a scanned copy at an unknown revision (the declared ref was not checked)",
    },
  },
);

if (failures > 0) process.exit(1);
