# AGENTS.md

@CONTRIBUTING.md

## Architecture essentials

- `link` is two things in one repository: the SDLC reference catalog (the
  dotagents payload) and the scanner that audits organizations against it.
  A release ships both together, so a change to `governance/` is as
  user-facing as a change to the scanner.
- The scanner decides everything from file trees and branch rules. It calls
  no model and holds no LLM dependency — checks are deterministic TypeScript
  over `gh` output. Keep it that way. Semantic review is a separate,
  human-started evidence path: Link may prepare harness commands and validate
  their results, but MUST NOT launch an agent or rewrite scanner output.
- Scanner and reviewed evidence are separate records. A claim affects only the
  reviewed score after explicit acceptance; rejection and supersession remain
  historical, and a new scan MUST NOT inherit decisions from an older scan.
  The `sdlc-report` skill is an optional review implementation, not Link's
  entry point.
- Determinism is the product. Two runs of the same org must differ only in
  `generated_at` and `scanned_at`, because report diffs are what an
  organization uses to measure progress between rungs.
- The report's output is a ranked plan, not a grade. `next_steps` is ordered
  by what reaches the next rung, and every instruction in it must name a
  signal the scanner reads — advice the tool cannot then measure tells an
  organization to do work the next report will not credit. When a check
  changes, its remediation text changes with it.
- Evidence gates are backends, and the boundary is *wired, never fired*. A
  required status check is a control this scan can see; whether an evidence
  record was ever written needs a sink credential and belongs to
  `pensieve verify`. Never add a backend that reaches a network service — a
  backend reads the tree and the effective branch rules, both already fetched.
  Keep the registry plural: `link` audits organizations it does not own, and a
  scanner that recognizes only our own evidence system grades strangers on
  whether they adopted our product.
- A check whose status is a literal is a bug, not a placeholder. `session-capture`
  was hardcoded `unmet` for months, so a reader who did the work exactly as the
  runbook said was still told they failed. `scripts/test-evidence.mjs` exists to
  make that regression fail loudly.
- Record absence of evidence as absence, never as a negative fact. A forge
  scan cannot see local-only practice; `evidence_limits` bounds every claim
  the report makes.
- A scan scoped to named repositories reports a level for those repositories,
  not for the organization. `source_type` and `evidence_limits` must both say
  so. A scoped number presented as an org number is the worst failure this
  tool has, because it is wrong while looking right.
- Node is the contract, for the scanner and the web server alike — see
  CONTRIBUTING.md. Bun is a faster runtime for the edit loop, not a target,
  and nothing may spawn it: the published package does not require it.
- There is one scanner entry point. The site's rescan spawns
  `<root>/dist/cli.js` on `process.execPath`, never a second implementation
  and never the TypeScript source, which the package does not ship.
- Never write inside the installed package. Reports go to the working
  directory, `--out`, and `$XDG_DATA_HOME`; the `code/web/src/data` copy is
  written only when that directory already exists, which is true in a
  checkout and false under `npx`. The site reads XDG first for the same
  reason, and its rescan passes `--out $XDG_DATA_HOME` so it never litters
  the directory the user launched `link web` from.
- Review file reads stay beneath server-generated scan/review directories.
  Never accept an arbitrary result path from a request body. Mutation routes
  require same-origin requests and the per-process request token.
- Both the scanner and the site resolve the catalog payload by walking up
  from their own location to `governance/sdlc-baseline.yaml`, because they
  run from `code/report/src` or `code/web/src/lib` in a checkout and from
  `dist/` or `dist-web/server/` when installed. Do not reintroduce a fixed
  relative depth in either.
- `gh` failures resolve to `null` so one unreadable repository degrades to
  "unknown" instead of failing the scan. Preserve that; a partial report that
  says what it could not see beats no report.
