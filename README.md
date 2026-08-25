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

Either way the scan writes `report.json` to the working directory, keeps the
latest compatibility copy in `$XDG_DATA_HOME/outfitter-link/`, and preserves
an immutable snapshot under `scans/<scope>/<scan-id>/`. `--out <dir>` puts it somewhere
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
docker run --rm -e GH_TOKEN="$(gh auth token)" -e LINK_HOST=0.0.0.0 \
  -e LINK_ACCESS_TOKEN="$(openssl rand -hex 24)" -v "$PWD:/work" -p 4321:4321 \
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

It binds to loopback by default. A container or remote bind MUST set
`LINK_HOST` explicitly and MUST supply `LINK_ACCESS_TOKEN` on requests.

### Reviewed evidence

The scanner remains deterministic. When a custom implementation does not use
a filename the scanner recognizes, select a preserved scan and choose
**Prepare agent review**. Link writes `prompt.md`, the strict
`reviewed-evidence/v1` schema, and the expected `result.json` path beneath that
scan, then displays copy-paste commands for Claude Code, Codex, Pi through
Outfitter, and a prompt-only fallback. Link never launches an agent.

The result loader rejects prose, fenced JSON, stale scan fingerprints,
duplicate or unknown milestone targets, and malformed evidence. Each claim
remains pending until a person accepts or rejects it. Accepted claims recompute
a separate reviewed score; `report.json` and the scanner score never change. A
new scan starts with no accepted annotations, while prior reviews remain in
history. The `sdlc-report` skill is an optional reusable implementation of this
semantic review, not the assessment entry point.

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

Level 3 includes `agent-review`: conventionally named pull-request review
workflows are detected deterministically, while custom-named implementations
can be credited only through accepted reviewed evidence.

Every org report ends in a ranked **plan**, not a grade. `next_steps[]`
lists what to do, ordered by the rung each step reaches: the smoke test
first when it is unmet, then every rung still ahead — nearest first, in
requirement order inside each rung — then the branch-protection backlog.
Each step carries imperative instructions, the repositories to apply them
to, and the `blocks_level` it clears, so the site can band the plan by rung
and a reader can see the shape of the climb rather than one step of it.
Every milestone carries its rung too, which makes the milestone list
readable as a column: where the ✗ marks start is where the ramp stops.

Every instruction names a signal the scanner reads, so following one
changes the next report — advice this tool cannot then measure is advice it
has no business giving. `gaps[]` remains, unordered, for anything that
parses it.

### Evidence gates

`session-capture` and the `evidence.landing-gate` baseline rule are decided by
**evidence-gate backends** — a small registry in `code/report/src/evidence.ts`,
every one of them reading the repository tree and the effective branch rules
the scan already fetched. No backend adds a network call.

| Backend | Recognizes |
| --- | --- |
| `pensieve` | The [CICD-001](https://github.com/ai-outfitter/pensieve/blob/main/docs/requirements/CICD-001-evidence-gates.md) shape: a required status check under `evidence/`, the tier workflows, and `.github/pensieve.yml` |
| `generic` | A required check named for evidence, a transcript, session capture, an audit trail, or an audit log — for an organization that built its own. Bare `audit` is not matched: a dependency audit is not a session record |

Backends are plural on purpose. `link` audits organizations it does not own, so
a scanner that recognized only ai-outfitter's own evidence system would be
grading strangers on whether they adopted our product and calling the result a
maturity level.

A gate is `met` only when it is **wired** — an effective branch rule requires
the check — and **exercised**: the check actually reported on what landed.
Whether it ever **fired**, meaning the records exist and verify, needs a
credential for the evidence store, so it belongs to `pensieve verify` and the
CI gate, not to a read-only forge scan.

Four things demote a gate that looks configured, each reported by name:

- **No effective rule requires the check.** A repository carrying every
  workflow and policy file that nothing requires is `declared only` —
  [CICD-001.1.2](https://github.com/ai-outfitter/pensieve/blob/main/docs/requirements/CICD-001-evidence-gates.md).
  In-tree `rulesets/*.json` are import sources, not active rules.
- **Direct pushes reach the default branch.** github.com has no pre-receive
  hook, so requiring a pull request is the only preventive direct-push control
  (CICD-001.9.3). Without it a commit lands having passed nothing.
- **An actor bypasses the ruleset unconditionally.** A break-glass path may
  exist, but it has to be recorded and produce its own evidence; a silent
  ruleset bypass is not one (CICD-001.7.4). A pull-request-scoped bypass is
  recorded without demoting the gate.
- **The required check never reports.** The last ten merged pull requests are
  sampled for a passing check. A required check that never runs leaves a
  pending status and gates nothing — required and reporting are different
  facts.

The bypass and sample lookups cost one request each and run only where they
change an answer, so a repository that neither lands agent changes nor carries
an evidence shape is scanned exactly as cheaply as before. A bypass list that
needs org admin to read is reported unknown, never empty.

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
