# =============================================================================
# swap — runtime container image for the TS rolling-swap MAKER node (issue #124)
#
# Builds @toon-protocol/swap FROM SOURCE (this repo has never published to
# npm — see CLAUDE.md "Publishing"). @toon-protocol/connector and
# @toon-protocol/sdk are already regular npm `dependencies` of
# @toon-protocol/swap (packages/swap/package.json), so `pnpm install` fetches
# both from the registry like any other package — no special-casing needed.
#
# CLI config-surface check (per the issue): the proven `scratchpad/t6/
# maker.mjs` wiring — operator-supplied standalone `btpServerPort` mode (no
# parent), `chainProviders` with a `channelAddress`, `settlementPrivateKey`
# for the claim signer, and a paid kind:10032 announce — is fully expressible
# through `toon-swap --config` (packages/swap/src/cli.ts): chainProviders/
# settlementPrivateKey/btpServerPort were already forwarded; this issue added
# the two fields that were missing (`peerInfoIlpDestination` +
# `peerInfoPricePerByte`, cli.ts). No thin entrypoint shim was needed — see
# deploy/swap/README.md for the full config-surface reference.
#
# Runtime dependency footprint (issue #124 note, not addressed here): the
# built image is large — @toon-protocol/core's own `dependencies` pull in
# @ardrive/turbo-sdk -> x402 -> wagmi/@solana-kit, none of which the swap
# node's own code path touches. Slimming that is upstream (core), out of
# scope for "produce a pullable image".
#
# Build (from the repository root, so the build context includes
# pnpm-workspace.yaml + packages/swap):
#   docker build -f deploy/swap/Dockerfile -t swap .
#
# Run (config + identity mounted/injected by the operator):
#   docker run --rm -p 3400:3400 \
#     -v "$(pwd)/swap.config.json:/app/config/swap.config.json:ro" \
#     -e SWAP_MNEMONIC="$(cat mnemonic.txt)" \
#     swap
# =============================================================================

FROM node:22-bookworm-slim AS deps

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@8.15.9 --activate

# Workspace manifests only — this layer (and the `pnpm install` it gates) is
# reused whenever a commit touches package *source* without touching a
# manifest or the lockfile. `packages/swap` is the only workspace member
# (pnpm-workspace.yaml: `packages/*`) — its package.json is enough for pnpm
# to resolve and install the full dependency graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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

# `/app/config` is the documented config-file mount point (see
# deploy/swap/README.md); created + owned here so a bind mount onto it
# doesn't surprise the non-root `swap` user with a root-owned path.
RUN mkdir -p /app/config && chown swap:swap /app/config

USER swap

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--config", "/app/config/swap.config.json"]
