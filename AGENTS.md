# AGENTS.md

@CONTRIBUTING.md

## Architecture essentials

- `link` is two things in one repository: the SDLC reference catalog (the
  dotagents payload) and the scanner that audits organizations against it.
  A release ships both together, so a change to `governance/` is as
  user-facing as a change to the scanner.
- The scanner decides everything from file trees and branch rules. It calls
  no model and holds no LLM dependency — checks are deterministic TypeScript
  over `gh` output. Keep it that way: judgment belongs in the `sdlc-report`
  skill, which is the deeper pass, not here.
- Determinism is the product. Two runs of the same org must differ only in
  `generated_at` and `scanned_at`, because report diffs are what an
  organization uses to measure progress between rungs.
- The report's output is a ranked plan, not a grade. `next_steps` is ordered
  by what reaches the next rung, and every instruction in it must name a
  signal the scanner reads — advice the tool cannot then measure tells an
  organization to do work the next report will not credit. When a check
  changes, its remediation text changes with it.
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
- Both the scanner and the site resolve the catalog payload by walking up
  from their own location to `governance/sdlc-baseline.yaml`, because they
  run from `code/report/src` or `code/web/src/lib` in a checkout and from
  `dist/` or `dist-web/server/` when installed. Do not reintroduce a fixed
  relative depth in either.
- `gh` failures resolve to `null` so one unreadable repository degrades to
  "unknown" instead of failing the scan. Preserve that; a partial report that
  says what it could not see beats no report.
