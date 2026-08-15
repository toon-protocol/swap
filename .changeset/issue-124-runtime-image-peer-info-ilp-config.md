---
---

The `toon-swap` CLI now accepts `peerInfoIlpDestination` / `peerInfoPricePerByte` in the JSON config file, closing the last gap in the CLI's config surface versus the proven standalone-maker wiring (`scratchpad/t6/maker.mjs`) — these fields were already supported by `startSwapNode()` but never forwarded from `packages/swap/src/cli.ts`. Also adds a runtime container image (`deploy/swap/Dockerfile`, published to `ghcr.io/toon-protocol/swap` by `.github/workflows/publish-swap-image.yml`) that boots the maker via `toon-swap --config`; see `deploy/swap/README.md` for the full config-surface reference.
