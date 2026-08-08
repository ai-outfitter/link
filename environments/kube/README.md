# Environment: kube

For workflow steps that run in a Kubernetes pod.

The `github-read` rebinding is the honest difference from the catalog
default: a pod has no Docker daemon, so the Docker stdio form does not work
in-cluster. This layer runs the `github-mcp-server` binary directly —
bake it into the agent runtime image — with the same read-only pin and
toolsets. `GITHUB_PERSONAL_ACCESS_TOKEN` comes from the pod's environment,
mounted from a Secret by the deployment; it is deliberately absent from this
file.

When you copy this layer, add your cluster's `models.json` (in-cluster
gateway or provider account) and any deny rules for the fleet.

For pods that should also read the Kubernetes API, start from
[`../kube-api/`](../kube-api/) instead — the two templates are alternatives,
not a chain.
