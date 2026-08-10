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
npx @ai-outfitter/link review <org>        # a whole organization
npx @ai-outfitter/link review <org>/<repo> # one repository
```

`review` is the one to reach for: it scans and then opens the report, which
is what you wanted both times. `report` does the scan alone, for scripts and
CI, and `web` serves the last one without rescanning.

Either way the scan writes `report.json` to the working directory, plus a
copy in `$XDG_DATA_HOME/outfitter-link/`. `--out <dir>` puts it somewhere
else and creates the directory — how the onboarding runbook files a dated
baseline into an org's `.agents` catalog:

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

Each release is one coherent snapshot: the catalog payload and the scanner
that audits against it move together. See [CHANGELOG.md](CHANGELOG.md) and
the [releases page](https://github.com/ai-outfitter/link/releases).

### Container

The image carries `gh` and `git`, so it needs only a token, and it serves the
report too — the container is a complete path with no toolchain on the host.
`review` is its default command, so one run scans and then serves:

```sh
docker run --rm -e GH_TOKEN="$(gh auth token)" -v "$PWD:/work" -p 4321:4321 \
  ghcr.io/ai-outfitter/link:1 review my-org
```

The working directory is `/work`; mount over it to keep the report, which
lands there as `report.json` alongside `workflows.json`. A container's own
state does not outlive it, so that mount is what a later `web` run reads.

`report` and `web` remain callable on their own when automation wants one
without the other.

### The site

```sh
npx @ai-outfitter/link@1 web        # http://localhost:4321; set PORT to change it
```

`/` is the organization report; `/workflows` renders each `agent-workflow/v1`
definition with its steps, `with:` handoffs, `posts-to:` targets, and YAML
source; `/baseline` renders the governance policy the report was audited
against, rule by rule, and marks which rules a forge scan can measure. The
report page manages sources directly: add a GitHub org or a local folder in
the form and rescan — the same XDG registry the CLI uses, and the same
scanner, run for you.

The policy travels inside `report.json`, so a report filed into an org's
`.agents` catalog can still be read against the rules it was scored under
after the catalog moves on.

The site ships prebuilt and needs no toolchain of its own. Run `report` at
least once first: the page renders whatever the last scan wrote.

## The report

Sources can be a GitHub org (`acme`), a single repository (`acme/widgets`),
or a **local folder** — a single checkout, an owner folder of clones, or a
whole `~/repos/` root; hidden directories are included because the org/user
`.agents` catalog is the canonical eval anchor. `link report add
<org-or-path>` registers a source persistently in
`$XDG_CONFIG_HOME/outfitter-link/sources.json`.

Repositories group by owner, so `link report acme/one acme/two` is one
report covering two repositories rather than two reports. Naming an org and
one of its repositories is not a duplicate — the org listing already carries
it.

A repository-scoped scan never lists the rest of the owner, so its level
describes the repositories it saw and not the organization. The report says
exactly that in `evidence_limits`, and its `source_type` is `github-repo`
rather than `github-org`.

Named targets scope the scan to themselves: `link report acme` reports on
acme and nothing else, because that report gets filed into acme's own
`.agents` catalog. A bare `link report` sweeps every registered source
instead. A copy of every report also lands in
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

## Contributing

Repository layout, the development loop, the Docker build, and the release
workflow are in [CONTRIBUTING.md](CONTRIBUTING.md).
