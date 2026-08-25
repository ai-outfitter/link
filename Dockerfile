# @ai-outfitter/link — the SDLC report scanner.
#
# The scanner shells out to `gh` and `git`, so both must exist in the runtime
# layer; node alone is not enough. Authenticate by passing a token:
#
#   docker run --rm -e GH_TOKEN -v "$PWD:/work" ghcr.io/ai-outfitter/link report <org>
#
# The report lands in /work, which is the working directory.
#
# The image also serves the report, because it is the no-toolchain path: a
# user who chose the container to avoid installing node has no other way to
# look at what they just generated.
#
#   docker run --rm -e GH_TOKEN -e LINK_HOST=0.0.0.0 -e LINK_ACCESS_TOKEN \
#     -v "$PWD:/work" -p 4321:4321 \
#     ghcr.io/ai-outfitter/link web

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.build.json ./
COPY code/report ./code/report
COPY code/web ./code/web
COPY scripts ./scripts
RUN npm ci
RUN npm run build
# Bundles the site into dist-web/, and needs esbuild, so it must run before
# the prune below.
RUN npm run build:web
# Re-resolve to production dependencies only; the image ships no toolchain.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ARG GH_VERSION=2.63.2
ARG TARGETARCH=amd64

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
     | tar -xz -C /tmp \
  && mv "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
  && rm -rf "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# The prebuilt site: a bundled server with no dependencies of its own, and
# its client assets, which must stay beside it.
COPY --from=build /src/dist-web ./dist-web
COPY package.json ./
# The catalog payload: the scanner resolves its governance baseline by
# walking up to governance/sdlc-baseline.yaml, so this is not optional.
COPY governance ./governance
COPY workflows ./workflows
COPY spec ./spec
COPY agents ./agents
COPY environments ./environments

RUN ln -s /app/dist/cli.js /usr/local/bin/link && chmod +x /app/dist/cli.js

# The Astro node adapter binds to localhost unless told otherwise, which
# inside a container means nothing outside it can connect. 0.0.0.0 is the
# only useful default here; it is the container's own network namespace, not
# the host's.
ENV PORT=4321
EXPOSE 4321

# Reports are written to the working directory; mount a volume over it.
WORKDIR /work

ENTRYPOINT ["link"]
# Scan, then serve. Someone running this image wants to look at the result,
# and splitting that across two `docker run` invocations against the same
# mount is friction with no upside. `report` and `web` stay callable on
# their own for automation that wants one or the other.
CMD ["review"]
