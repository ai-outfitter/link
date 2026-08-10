# Contributor Guide

## Prerequisites

- Node 24 or later. `.node-version` pins the version CI uses; see
  [Commit and release workflow](#commit-and-release-workflow) for why the
  major matters.
- An authenticated `gh` CLI. The scanner shells out to `gh` and `git`, so both
  must be on `PATH`.
- Docker, only if you are changing the image.
- [Bun](https://bun.sh) is optional and speeds up the edit loop.

## Repository structure

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

The root `package.json` is the published `@ai-outfitter/link` package. It
builds `code/report/src` into `dist/` and ships the catalog payload
(`agents`, `environments`, `governance`, `spec`, `workflows`) alongside it,
because the scanner resolves its governance baseline by walking up from
`dist/` to `governance/sdlc-baseline.yaml`. A payload directory missing from
the `files` list becomes a runtime error on somebody else's `npx`, not a
build failure here.

## Install dependencies

```sh
npm install
npm run build          # tsc → dist/
```

## Run the scanner

```sh
node dist/cli.js report                       # the registered-source sweep
node dist/cli.js report ai-outfitter          # one org, scoped
node dist/cli.js report add <org-or-path>     # register a source
```

Named targets replace the source registry for that run rather than adding to
it. That is deliberate: a report gets filed into one organization's `.agents`
catalog, so `link report acme` must not carry every org the machine has ever
registered.

In a checkout the report also lands in `code/web/src/data/report.json`, which
the site imports statically — regenerating the report and reloading the page
is the whole feedback loop.

## Node is the contract

The scanner targets plain node so `npx @ai-outfitter/link` works with no other
toolchain. Keep `code/report/src` free of Bun-only globals — no `Bun.file`,
`Bun.spawn`, `Bun.YAML`, `Bun.env`, `Bun.argv`, or `import.meta.dir`.

Bun runs node APIs, so the fast edit loop stays available:

```sh
bun run code/report/src/index.ts report ai-outfitter
```

If that works but `node dist/cli.js` does not, a Bun-only global has crept
back in.

## Run the site

```sh
npm --prefix code/web install
npm --prefix code/web run dev     # http://localhost:4321
```

The site is not part of the published package; `link web` needs a checkout.

## Docker

```sh
docker build -t link:dev .
docker run --rm -e GH_TOKEN="$(gh auth token)" -v "$PWD:/work" link:dev report <org>
```

The image carries `gh` and `git` because the scanner shells out to both; node
alone is not enough. `/work` is the working directory, so mount over it to
keep the report.

The image builds from source rather than installing the published tarball, so
it works for unreleased versions and in CI before a publish. Both artifacts
come from the same commit, and their `dist/` and payload files hash
identically — but nothing enforces that, so treat it as a property to check
rather than a guarantee.

## Validate changes before opening a PR

```sh
npm run typecheck
npm run build
npm pack                                       # inspect the tarball contents
docker build -t link:dev .
```

CI runs the same steps on every pull request, plus a consumer check: it
installs the packed tarball into a clean directory, runs the binary from it,
and asserts the catalog payload shipped. Run `npm pack` and read the file list
when you change `files`, `dist` layout, or anything the scanner reads at
runtime.

## Commit and release workflow

Use Conventional Commits for every commit and PR title that will be
squash-merged. Supported types are `feat`, `fix`, `chore`, and `refactor`.
Each commit should represent one logical change.

Release automation is split across two workflows:

1. `.github/workflows/release-please.yml` runs on pushes to `main`. It opens
   or updates a release PR when releasable Conventional Commits are present.
2. Merge the release-please PR to publish the GitHub release and tag.
3. `.github/workflows/release.yml` runs when that release is published. It
   publishes `@ai-outfitter/link` to npm and pushes the image to
   `ghcr.io/ai-outfitter/link`, tagged with the exact version, the major, and
   `latest`.

`feat` commits normally create a minor release and `fix` commits a patch.
Maintenance-only `chore` and `refactor` commits do not create a release by
themselves.

A release is one coherent snapshot: the catalog payload and the tooling that
audits against it move together.

### Release gotchas, each learned the hard way

- **npm auth is trusted publishing over OIDC, not a token.** `id-token: write`
  and the `npm-publish` environment are the mechanism; there is no
  `NPM_TOKEN`. A publish step that sets `NODE_AUTH_TOKEN` fails `ENEEDAUTH`.
- **Trusted publishing needs npm >= 11.5.1.** Node 22.19.0 ships npm 10.9.3,
  which sends no credential and makes the registry answer `404 Not Found` on
  the scoped `PUT` — an error that reads like a missing package. This is why
  `.node-version` pins 24.
- **Re-running a failed release job does not pick up a workflow fix.** GitHub
  runs release workflows from the commit the tag points at, so a fix on `main`
  applies to the *next* release. Cut a patch release instead.
- **A trusted publisher cannot be attached to a name that does not exist.**
  The first version of a new package has to be published by hand with 2FA
  (`npm publish --access public --otp=<code>`), after which the publisher can
  be registered and CI takes over.
- **Provenance requires a public source repository.** While this repo is
  private, releases publish without provenance and log a warning saying so.
  The workflow branches on visibility, so making the repo public turns
  attestation on with no further change.
