// Dotagents source-declaration fixtures. Run after `npm run build`.
import {
  catalogSourceFindings,
  declaredSourceSignals,
  parseDeclaredSources,
} from "../dist/sources.js";

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

if (failures > 0) process.exit(1);
