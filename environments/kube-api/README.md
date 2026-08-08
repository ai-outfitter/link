# Environment: kube-api

For workflow steps that run in a Kubernetes pod and also need to read the
cluster — an agent that inspects its own namespace, checks workload status,
or watches the runs the operator schedules.

It is the [`kube`](../kube/) template plus one server: `kube-read` runs
[`kubernetes-mcp-server`](https://github.com/containers/kubernetes-mcp-server)
over stdio with `--read-only` (no create, update, or delete) and
`--cluster-provider in-cluster`, so it authenticates as the pod's
ServiceAccount — no kubeconfig in the image.

The credential story is the
[agent-operator](https://github.com/ai-outfitter/agent-operator)'s bounded
workspace: the operator provisions the ServiceAccount, and its RBAC — not
this file — is what caps the API surface to the agent's namespace. The
`--read-only` flag and the RBAC bound compose; either alone is a weaker
guarantee. An agent gets the capability only by selecting it
(`mcp: [kube-read]` in frontmatter); none of the `sdlc-*` reference agents
do.

Copy this layer into your fleet's deployment repository and add its
`models.json` and deny rules, as with `kube`.
