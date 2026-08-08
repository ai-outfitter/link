# link

The SDLC reference catalog, published with the tooling that measures adoption
of it. The dotagents payload (agents, workflows, governance, environments,
spec) is the [community-profiles SDLC reference
collection](https://github.com/ai-outfitter/community-profiles); `code/`
holds a Bun report tool that audits organizations against the catalog's
governance baseline and an Astro site that renders the report and the
defined workflows.

## Layout

```text
agents/         the four sdlc-* agents (read-only planner/reviewer/explorer, engineer)
workflows/      agent-workflow/v1 definitions (feature-request, vulnerability-fix)
governance/     git-forge-governance/v1 baseline (sdlc-baseline)
environments/   deployment-layer templates (copy, don't pin): github-actions, kube, kube-api
spec/           versioned meta-schemas incl. work-graph/v1, with validated examples
mcp.json        default MCP server bindings; agents opt in via frontmatter `mcp:`
docs/           the SDLC reference collection documentation
code/report/    Bun + zod org scanner: audits orgs against governance/sdlc-baseline.yaml
code/web/       Astro site: the org report and the workflow definitions
```

## Generate a report

Requires [Bun](https://bun.sh) and an authenticated `gh` CLI. Read-only: the
scanner lists repositories, reads git trees, and reads effective branch
rules; it changes nothing.

```sh
cd code/report
bun install
bun run src/index.ts <org> [org...]
```

The report is typed JSON validated with zod (`code/report/src/schema.ts`)
and lands in `code/web/src/data/report.json`, beside `workflows.json`
parsed from `workflows/*.yaml` with Bun's native YAML support. Each
repository gets maturity-ramp placement (level 0–5), tree-derived signals
(instruction files, `.agents/`, agent workflows), and a per-rule audit
against `governance/sdlc-baseline.yaml`. Absence of evidence is recorded as
absence — local-only practice is invisible to a forge scan, and the report
says so in `evidence_limits`.

## View it

```sh
cd code/web
bun install
bun run dev     # or: bun run build && bun run preview
```

Two pages: `/` is the organization report; `/workflows` renders each
`agent-workflow/v1` definition — steps, `with:` handoffs, `posts-to:`
targets, routing — with the YAML source inline.
