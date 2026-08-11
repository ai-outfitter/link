# Reference environments

An environment is a deployment-owned catalog layer: a directory with its own
`mcp.json` (and, as needed, `models.json` and settings deny rules) that a
deployment lists as the last source in its `settings.yml`. Layer precedence
does the rest — a server id defined here replaces the catalog default for
that id, per server, so the same abstract capability an agent selects
(`mcp: [github-read]`) binds to different credentials and transports in each
place it runs.

The directories here are **templates to copy, not layers to pin**. Copy one
into your deployment's own repository, edit the data, and pin that. There is
no inheritance between environments: each copied layer is flat and
self-contained, and improvements to these templates propagate by diffing your
copy against the template — review, not resolution.

| Template | For |
| --- | --- |
| [`github-actions/`](github-actions/) | CI runs; forge credential is the job's `GITHUB_TOKEN` |
| [`kube/`](kube/) | In-cluster runs; binaries over stdio, secrets from the pod |
| [`kube-api/`](kube-api/) | In-cluster runs that also read the Kubernetes API through the agent-operator's ServiceAccount |

## Which one to start with

**Choose per job, not per organization.** Put a job where its trigger and its
credential already live.

Start with `github-actions`, and stay there for **issue triage** and
**pull-request review** — the two jobs worth automating first. Their trigger is
a forge event the platform already delivers (`on: issues`, `on: pull_request`),
and their credential is the job's own `GITHUB_TOKEN`, scoped by a `permissions:`
block and expired when the job ends. There is no standing secret to rotate and
nothing to receive the webhook.

**This holds when you already run a cluster.** A cluster buys persistence
between runs, runtimes longer than a job, and scope across repositories.
Triaging one issue and reviewing one pull request are stateless, short, and
scoped to one repository, so the cluster's premium buys nothing for them while
still costing a webhook receiver, an ingress, and a long-lived credential.
Running these two in Actions is not a limitation you accept; it is cost you do
not pay.

Reach for `kube` or `kube-api` when a job needs what a workflow cannot give it:
an agent that is assignable and picks work up itself, memory between runs, work
spanning several repositories, or a run longer than a job allows. `kube-api`
additionally reads the Kubernetes API, so choose it only when the agent's task
is about the cluster.

Two rules keep a copied environment honest:

- **An environment binds and restricts; it must not widen.** Deny rules and
  rebindings are its job. Shipping a same-id copy of a catalog agent with
  more tools is shadowing — governance should pin which layer the `sdlc-*`
  agents resolve from, the same way a project layer must not weaken org
  policy.
- **Credentials are never content.** These files name environment variables
  and mounted secrets; the backend materializes them.
