# Environment: github-actions

For workflow steps that run on GitHub Actions runners.

The `github-read` binding is the same Docker stdio form as the catalog
default — runners have Docker, so the transport carries over. It is restated
here so a copied layer is self-contained and so the credential provenance is
explicit: in this environment `GITHUB_PERSONAL_ACCESS_TOKEN` comes from the
job, scoped by the workflow's `permissions:` block, not from a personal
token.

```yaml
# in the job that runs the agent step
env:
  GITHUB_PERSONAL_ACCESS_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

When you copy this layer, add what your CI deployment owns: a `models.json`
routing to your provider account, and deny rules for anything a headless
runner should never do (interactive prompts, local browser tools).
