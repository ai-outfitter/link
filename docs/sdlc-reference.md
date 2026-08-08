# SDLC reference collection

A canonical, adoptable configuration for an agentic software development
lifecycle: four agents, two declarative workflows, and one git-forge
governance policy. Copy it, then edit the data — the reviewer team, the
backend list, the repo targeting — to fit your organization.

## What works today

Each resource kind in this collection has a different maturity. The honest
support matrix:

| Resource | Status today |
| --- | --- |
| `agents/sdlc-*` | **Runnable.** Plain Dotagents agents. `outfitter run sdlc-planner` works now; `sdlc-explorer` is selectable as a subagent from any agent in your own catalog. |
| `governance/sdlc-baseline.yaml` | **Readable.** The `sdlc-report` skill can diff repositories against it (read-only conformance). An apply/converge command comes later. |
| `workflows/*.yaml` | **Validated only.** Schema-checked in CI against `spec/agent-workflow.v1.schema.json`; no runtime executes them yet. They freeze the authored surface for the workflow compiler and serve as its future conformance fixtures. |

## The agents

- **sdlc-explorer** — read-only scout subagent: one question in, work-graph
  evidence nodes with code anchors out. Never edits, executes, or reaches
  the network.
- **sdlc-planner** — read-only planner that fans out explorers and returns
  an implementation plan as a work graph. The graph is its only artifact.
- **sdlc-reviewer** — read-only adversarial reviewer that verifies a change
  against its plan graph and returns findings as work-graph nodes. Never
  edits or merges.
- **sdlc-engineer** — implements a planned change on a draft PR branch, tests
  before pushing, never merges.

Permissions live on the agents, not in the workflows: a workflow step names
an agent; the agent's loadout is what it may touch. Restricting a planning
step to read-only is done by giving the step a read-only agent.

Explorer, planner, and reviewer carry no bash at all. Two mechanisms make
that possible:

- **Forge reads go through a read-only MCP server.** Planner and reviewer
  select `github-read` — the official GitHub MCP server pinned to
  `GITHUB_READ_ONLY=true` with the `issues,pull_requests` toolsets — so they
  read issues, discussion, and pull-request diffs without `gh` or a shell.
  The agents select the server id, not its implementation: the tree-root
  `mcp.json` definition is the default (local) binding, and a deployment
  layer rebinds the same id per environment (see
  [Reference environments](#reference-environments)).
- **Posting is the runtime's write, not the agent's.** A step's `posts-to:`
  tells the runtime where the step's output artifact lands. The agents
  return data; nothing in their loadout can write to the forge.

One harness caveat, stated honestly: on Claude Code, `tools.allow` bounds
the built-in tool set and selected MCP servers project beside it, so the
read-only lockdown composes as written. On pi, the tool allowlist is a hard
ceiling across all tool categories, which today also gates adapter-provided
MCP tools — until that projection gap closes upstream, run these two agents
on Claude Code or widen the allowlist deliberately.

## The workflows

`agent-workflow/v1` is a flat sequence of steps. Each step is either an
`agent` invocation, a deterministic `run` command, or an `emit` that ends the
run with the workflow's typed output. Steps share one workspace and run in
order; `if:` conditions are enum-equality checks over prior step outputs, and
a `runs-on:` that references a decision step's enum selects an execution
backend per run.

- `feature-request` — assigned issue → draft PR → posted plan → routed
  implementation (local / copilot / kube-agent / actions) → adversarial
  review → ready-for-human-review with reviewers assigned, or a terminal
  `revision-requested` / `blocked-prerequisites` record.
- `vulnerability-fix` — vulnerability-labeled issue → affected/not-affected
  assessment → patch → review → ready-for-human-review, or a terminal
  `not-affected` / `revision-requested` record.

The decision-step convention: `bin/rank-implementers` prints JSON conforming
to the step's output schema. Because the contract is the schema, a shell
script and an LLM one-shot are interchangeable behind it, and every routing
decision is recorded output — evaluable later.

Steps hand artifacts to each other through `with:` — named inputs bound by
typed reference (`with: {plan: ${{ steps.plan.output }}}`). The handoff is
contract, not prose: what the implementer receives is exactly what the
planner's output schema promised.

## The work graph

`work-graph/v1` (`spec/work-graph.v1.schema.json`) is the one artifact
schema every handoff shares. The observation behind it: a milestone, an
issue, an exploration report, an implementation plan, and a review are all
the same shape — typed work nodes anchored to code locations, with typed
edges between them.

The graph is accretive. Each stage receives it and returns it with its own
nodes appended, so node ids stay stable across the pipeline:

| Stage | Adds | Consumes |
| --- | --- | --- |
| explorer | `question` + `evidence` nodes, `answers` edges | the question it was spawned with |
| planner | `feature`/`change` nodes ordered by `depends-on`, anchored with roles `edit`/`create`/`delete`/`test` | issue + merged evidence |
| implementer | commits (outside the graph) | the `change` anchors as its worklist |
| reviewer | `finding` nodes with `verifies`/`refutes` edges to the `change` nodes they judge | the plan graph + the diff |

Routing decisions (`approved`/`changes-requested`, `affected`/`not-affected`)
stay beside the graph at the step-output level — see
`workflows/schemas/*.schema.json` — so `if:` routing remains enum equality.
Node-id uniqueness and edge-endpoint resolution are linker checks, like
route exclusivity. A validated example lifecycle snapshot lives at
`spec/examples/feature-request.work-graph.json`.

## Reference environments

The same workflow step must run on a laptop, a CI runner, and a pod, and
`agent: sdlc-planner` must mean the same agent in all three. What differs per
place is bindings, not agents — and that difference is expressed with
machinery outfitter already has, not a new resource kind. An environment is a
deployment-owned catalog layer, listed last in that deployment's
`settings.yml`: its `mcp.json` rebinds server ids per-id over the catalog
default, its `models.json` routes to that place's provider, and its deny
rules subtract tools (deny always wins, so an environment can restrict an
agent but a wider allow cannot re-grant what the agent never had).

`environments/` ships three templates to copy — never to pin directly:

| Template | The binding difference |
| --- | --- |
| `github-actions` | `github-read` credential is the job's `GITHUB_TOKEN`, scoped by the workflow's `permissions:` block |
| `kube` | no Docker daemon in a pod — `github-mcp-server` runs as a binary, token from a mounted Secret |
| `kube-api` | `kube` plus `kube-read`: `kubernetes-mcp-server --read-only` on the agent-operator's RBAC-bounded ServiceAccount |

Copies are flat and self-contained; there is no inheritance between
environments. Template improvements reach a deployment by diffing the copy
against the template — review, not resolution. The guard that matters:
layer precedence lets a deployment layer shadow a catalog agent wholesale,
so governance should pin which layer the `sdlc-*` agents resolve from, the
same way a project layer must not weaken org policy.

## The governance policy

`git-forge-governance/v1` declares what must be true of a repository for
agent workflows to be meaningful there: branch protection, capability caps on
agent identities, reviewer team requirements, evidence gates. It ships in
`warn` mode — runs proceed, non-conformance is recorded — and organizations
ratchet cohorts to `strict` as conformance holds. Policies resolve from the
org/enterprise catalog layer only; a project layer must not be able to weaken
them.

## Adoption

1. Add this catalog as a pinned source and `outfitter sync`.
2. Run an agent: `outfitter run sdlc-planner` — value with zero new
   machinery.
3. Point `sdlc-report` at your org with `governance/sdlc-baseline.yaml` as
   the baseline; treat its gaps as the backlog.
4. Copy a workflow into your org catalog under the same id and edit the
   data. Same-id layer precedence does the rest.

## Deliberately excluded

- **Deployed environment layers** — the templates under `environments/`
  are here to be copied; the copies (with their model routing, secret
  names, placement, and capture profiles) are deployment state and live
  with the deployment, never in a community catalog.
- **Control resources** — obligation semantics belong to the Outfitter
  governance RFC and are not settled enough to freeze here.
- **Baked graphs** — build artifacts, not authored resources.
