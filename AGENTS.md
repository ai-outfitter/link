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
- Record absence of evidence as absence, never as a negative fact. A forge
  scan cannot see local-only practice; `evidence_limits` bounds every claim
  the report makes.
- Node is the contract for `code/report/src` — see CONTRIBUTING.md. Bun is a
  faster runtime for the edit loop, not a target.
- Never write inside the installed package. Reports go to the working
  directory, `--out`, and `$XDG_DATA_HOME`; the `code/web/src/data` copy is
  written only when that directory already exists, which is true in a
  checkout and false under `npx`.
- The scanner resolves the catalog payload by walking up from its own
  location to `governance/sdlc-baseline.yaml`, because it runs from
  `code/report/src` in a checkout and `dist/` when installed. Do not
  reintroduce a fixed relative depth.
- `gh` failures resolve to `null` so one unreadable repository degrades to
  "unknown" instead of failing the scan. Preserve that; a partial report that
  says what it could not see beats no report.
