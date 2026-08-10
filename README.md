# link

The SDLC reference catalog, published with the tooling that measures adoption
of it. The dotagents payload (agents, workflows, governance, environments,
spec) is the [community-profiles SDLC reference
collection](https://github.com/ai-outfitter/community-profiles); the
`@ai-outfitter/link` package audits organizations against the catalog's
governance baseline and serves a site that renders the report and the
defined workflows.

## Quick start

Requires an authenticated `gh` CLI. The scanner is read-only: it lists
repositories, reads git trees, and reads effective branch rules; it changes
nothing.

```sh
npx @ai-outfitter/link report <org> [org...]
```

`report` writes `report.json` to the working directory, plus a copy in
`$XDG_DATA_HOME/outfitter-link/`. `--out <dir>` puts it somewhere else and
creates the directory — how the onboarding runbook files a dated baseline
into an org's `.agents` catalog:

```sh
npx @ai-outfitter/link report my-org --out ~/repos/my-org/.agents/reports/sdlc/2026-08-10-initial
```

The scan runs on plain node, so `npx` needs no other toolchain. With
[Bun](https://bun.sh) installed, `bunx` works the same and starts faster.
Scanning five orgs and 80-odd repositories takes about six seconds.

Pin a version in automation — an unpinned run executes whatever the latest
release ships:

```sh
npx @ai-outfitter/link@1 report my-org
```

### Container

The image carries `gh` and `git`, so it needs only a token. The working
directory is `/work`; mount over it to keep the report:

```sh
docker run --rm -e GH_TOKEN -v "$PWD:/work" ghcr.io/ai-outfitter/link report my-org
```

### The site

`link web` serves the report at `http://localhost:4321` — `/` is the
organization report, `/workflows` renders each `agent-workflow/v1`
definition with its steps, `with:` handoffs, `posts-to:` targets, and YAML
source. The report page manages sources directly: add a GitHub org or a
local folder in the form and rescan — the same XDG registry the CLI uses,
served by API routes on the local server. The site is not part of the
published package; `link web` needs a checkout of this repository.

## Releases

Versioning and the changelog are automated with
[release-please](https://github.com/googleapis/release-please): merges to
`main` with conventional-commit messages accumulate into a release PR, and
merging that PR tags the release and publishes the package. See
[CHANGELOG.md](CHANGELOG.md) and the
[releases page](https://github.com/ai-outfitter/link/releases). The catalog
payload and the tooling version together — a release is one coherent
snapshot of agents, workflows, governance, spec, and the scanner that audits
against them.

## The report

Sources can be GitHub orgs or **local folders** — a single checkout, an
owner folder of clones, or a whole `~/repos/` root; hidden directories are
included because the org/user `.agents` catalog is the canonical eval
anchor. `link report add <org-or-path>` registers a source persistently in
`$XDG_CONFIG_HOME/outfitter-link/sources.json`; a bare `link report` scans
everything registered. The local `~/repos/ai-outfitter` folder is always
included for local development, and a copy of every report also lands in
`$XDG_DATA_HOME/outfitter-link/report.json`.

The first milestone in every report is the **e2e smoke test**: does any
path exist from an issue to an agent the org itself hosts and controls — a
self-hosted harness in its own CI, or a resident agent with `deploy/`
manifests? SaaS coding agents (Copilot, vendor apps) are excluded by
definition; being able to assign work to an agent whose destiny you control
is the capability everything else builds on.

Each repository gets maturity-ramp placement (level 0–5), tree-derived
signals (instruction files, `.agents/`, agent workflows), and a per-rule
audit against `governance/sdlc-baseline.yaml`. Output is typed JSON
validated with zod (`code/report/src/schema.ts`); in a checkout,
`workflows/*.yaml` are parsed into `workflows.json` beside it for the site.
Repositories with no push in the last 7 days are scanned and listed but
excluded from the org ranking and gap counts — the site collapses them
into a hidden section by default. Absence of evidence is recorded as
absence — local-only practice is invisible to a forge scan, and the report
says so in `evidence_limits`.

## Layout

```text
agents/         the four sdlc-* agents (read-only planner/reviewer/explorer, engineer)
workflows/      agent-workflow/v1 definitions (feature-request, vulnerability-fix)
governance/     git-forge-governance/v1 baseline (sdlc-baseline)
environments/   deployment-layer templates (copy, don't pin): github-actions, kube, kube-api
spec/           versioned meta-schemas incl. work-graph/v1, with validated examples
mcp.json        default MCP server bindings; agents opt in via frontmatter `mcp:`
docs/           the SDLC reference collection documentation
code/report/    the scanner behind `link report` (node + zod)
code/web/       the Astro site behind `link web`
```

## Develop

```sh
npm install && npm run build          # build dist/
node dist/cli.js report               # scan registered sources
node dist/cli.js report add <org-or-path>
npm --prefix code/web install && npm --prefix code/web run dev   # site
```

The scanner targets plain node so `npx` works without another toolchain; it
runs under Bun too, which starts faster. Keep `code/report/src` free of
Bun-only globals — `bun run code/report/src/index.ts` stays available for a
fast edit loop, but node is the contract.

In a checkout the report also lands in `code/web/src/data/report.json`,
which the site imports statically — regenerating the report and reloading
the page is the whole feedback loop.
