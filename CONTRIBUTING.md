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
node dist/cli.js review ai-outfitter          # scan, then serve
node dist/cli.js report                       # the registered-source sweep
node dist/cli.js report ai-outfitter          # one org, scoped
node dist/cli.js report add <org-or-path>     # register a source
```

`review` is `report` followed by `web`, and stops if the scan fails: serving
the previous report under a fresh org's name is worse than reporting the
failure. It is the container's default command, so one `docker run` scans
and serves.

Named targets replace the source registry for that run rather than adding to
it. That is deliberate: a report gets filed into one organization's `.agents`
catalog, so `link report acme` must not carry every org the machine has ever
registered.

A target resolves to a folder if it exists on disk, otherwise `owner/repo` if
it matches that shape, otherwise an org. Disk wins so a directory named like
a slug is never mistaken for a forge coordinate. Repository targets are
fetched with `gh repo view` — `gh repo list` cannot address a single
repository — and join the unit for their owner, so scan units stay
one-per-owner whatever mix of orgs, repositories, and folders was passed.

Keep `source_type` honest when touching this. It is how a reader tells
whether a level describes an organization or only the repositories that were
named, and `evidence_limits` says the same thing in words.

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
npm --prefix code/web run dev     # http://localhost:4321, with hot reload
```

`link web` resolves in this order: the prebuilt site at `dist-web/` if one
exists, then the Astro dev server if `code/web` is a checkout with its
dependencies installed. In a checkout, run `npm run build:web` to test what
users actually get, and delete `dist-web/` to go back to the dev server.

### How the prebuilt site is made

`npm run build:web` (`scripts/build-web.mjs`) runs `astro build`, bundles the
adapter's `dist/server/entry.mjs` with esbuild into a single file with no
bare imports, and copies `dist/client` beside it. Astro's node adapter emits
an entry that needs `node_modules` at run time; bundling is what lets the
published package serve the site without shipping Astro.

Two details that will bite if you touch that script:

- **`client/` must stay beside `server/`.** The adapter resolves static
  assets relative to the entry's own URL, so flattening the layout serves
  pages and 404s every asset.
- **The esbuild banner aliases `createRequire`.** Bundled CJS dependencies
  call `require`, which an ESM output has no binding for — but the generated
  bundle already imports `createRequire` under that name, so a plain import
  is a redeclaration `SyntaxError` at load.

`build:web` runs from `prepack`, not `prepare`. `prepare` fires on every
`npm ci` — including the Docker build and every contributor's first install
— and would drag the site's ~90 MB of dev dependencies into all of them.
`prepack` fires on `npm pack` and `npm publish`, exactly when the site has to
exist, and CI's consumer test already runs `npm pack`.

`dist-web/` is gitignored and listed in `files`; `files` wins for packing.

## Docker

```sh
docker build -t link:dev .
docker run --rm -e GH_TOKEN="$(gh auth token)" -v "$PWD:/work" link:dev report <org>
docker run --rm -e LINK_HOST=0.0.0.0 -e LINK_ACCESS_TOKEN="$(openssl rand -hex 24)" \
  -v "$PWD:/work" -p 4321:4321 link:dev web
```

The image carries `gh` and `git` because the scanner shells out to both; node
alone is not enough. `/work` is the working directory, so mount over it to
keep the report.

It also carries the prebuilt site, because the container is the no-toolchain
path: someone who chose it to avoid installing node has no other way to see
what they generated. Two consequences worth knowing:

- **Remote binding is explicit.** The site binds to loopback by default.
  Containers set `LINK_HOST=0.0.0.0` and an access token at run time; the image
  does not silently expose a mutation-capable control surface.
- **The site reads the working directory as well as XDG.** A container's XDG
  copy dies with the container, so after `docker run … report` the mounted
  `/work/report.json` is the only copy the next `docker run … web` can see.
  That is also why the scanner writes `workflows.json` beside the report
  rather than only to XDG.

The image builds from source rather than installing the published tarball, so
it works for unreleased versions and in CI before a publish. Both artifacts
come from the same commit, and their `dist/` and payload files hash
identically — but nothing enforces that, so treat it as a property to check
rather than a guarantee.

## Validate changes before opening a PR

```sh
npm run typecheck
npm run build
npm run test:evidence                          # evidence-backend fixtures
npm run test:reviews                           # reviewed-evidence contract and scoring
npm pack                                       # inspect the tarball contents
docker build -t link:dev .
```

### Adding an evidence-gate backend

`code/report/src/evidence.ts` holds the registry. A backend takes the
repository tree and the effective branch rules — both already fetched — and
returns a finding, or `null` when nothing of its shape is present. Three rules:

- **`met` comes from a required check, never from a file.** A workflow or a
  `rulesets/*.json` in the tree is an import source; the effective branch rules
  are the only proof that a check is required. A gate the branch can omit is
  not a gate.
- **Wired is not enough; exercised is the bar.** A required check that never
  reports gates nothing, so the last ten merged pull requests are sampled for
  a passing check. Add an obligation by pushing to `gaps`, never by widening
  the status directly — a finding is `met` exactly when `gaps` is empty, which
  is what stops an obligation being added without being reported.
- **Unreadable is `unknown`, not `unmet`.** Rules that cannot be read, and a
  bypass list behind org admin, are both unknown. Never invent an empty list.
- **Verification is out of scope.** Whether evidence records exist needs a
  store credential and belongs to `pensieve verify`. This scan reports whether
  the gate is wired and exercised, never whether it fired. Reads are limited to
  the forge; a backend must not reach an evidence store.

Add fixtures to `scripts/test-evidence.mjs` in the same change. That file
exists because `session-capture` was a hardcoded `unmet` for months, which
told everyone who did the work correctly that they had failed.

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
