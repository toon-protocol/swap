# =============================================================================
# swap — runtime container image for the rolling-swap MAKER
#
# Builds @toon-protocol/swap FROM SOURCE. The maker is an HTTP app behind a
# Rust connector's route termination (docs/rust-connector-migration.md): it
# embeds no connector, so the only port is the app port (default 8080) the
# connector's `handler_url`s and `/health` live on. Never publish it beyond
# the box.
#
# Build (from the repository root, so the build context includes
# pnpm-workspace.yaml + packages/swap):
#   docker build -f deploy/swap/Dockerfile -t swap .
#
# Run (config mounted, identity self-generated on the state volume):
#   docker run --rm -p 127.0.0.1:8080:8080 \
#     -v "$(pwd)/swap.config.json:/app/config/swap.config.json:ro" \
#     -v swap_node_state:/app/state -e SWAP_AUTOGEN_IDENTITY=1 \
#     swap
# =============================================================================

FROM node:22-bookworm-slim AS deps

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@8.15.9 --activate

# Workspace manifests only — this layer (and the `pnpm install` it gates) is
# reused whenever a commit touches package *source* without touching a
# manifest or the lockfile. `packages/swap` is the only workspace member
# (pnpm-workspace.yaml: `packages/*`) — its package.json is enough for pnpm
# to resolve and install the full dependency graph. `.npmrc` (auto-install-
# peers=false) must come along too — the lockfile records that setting, and
# `--frozen-lockfile` refuses to install without it (ERR_PNPM_LOCKFILE_
# CONFIG_MISMATCH).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/swap/package.json packages/swap/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json ./
COPY packages/swap packages/swap

RUN pnpm --filter @toon-protocol/swap build

# `pnpm deploy --prod` (pnpm-workspace deploy, not `npm publish`) produces a
# self-contained directory: @toon-protocol/swap's own `dist/` (its
# package.json `files` field) plus a PRODUCTION-only node_modules — devDeps
# like tsup/vitest/typescript/viem/@toon-protocol/client are pruned. Its
# node_modules symlinks are relative (pnpm's virtual store layout), so the
# directory survives being copied to a different path in the runtime stage.
RUN pnpm deploy --filter @toon-protocol/swap --prod /app/deploy

FROM node:22-bookworm-slim AS runtime

RUN groupadd -g 10001 swap && \
    useradd -u 10001 -g swap -m -d /home/swap -s /usr/sbin/nologin swap

WORKDIR /app

COPY --from=build /app/deploy ./

# `/app/config` is the documented config-file mount point and `/app/state`
# is the documented `statePath` volume mount point (see deploy/swap/
# README.md); both are created + owned here so a bind/named-volume mount
# onto them doesn't surprise the non-root `swap` user with a root-owned
# path. Docker only inherits an image path's ownership into a fresh named
# volume when that path already exists in the image — connector#983's
# compose mounts `swap_node_state` at `/app/state`, so without this the
# maker's boot-time state snapshot write hits EACCES.
RUN mkdir -p /app/config /app/state && chown swap:swap /app/config /app/state

USER swap

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--config", "/app/config/swap.config.json"]
