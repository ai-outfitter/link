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

Two rules keep a copied environment honest:

- **An environment binds and restricts; it must not widen.** Deny rules and
  rebindings are its job. Shipping a same-id copy of a catalog agent with
  more tools is shadowing — governance should pin which layer the `sdlc-*`
  agents resolve from, the same way a project layer must not weaken org
  policy.
- **Credentials are never content.** These files name environment variables
  and mounted secrets; the backend materializes them.
