# swap

TOON Protocol multi-chain swap node — @toon-protocol/swap (issues signed target-chain payment-channel claims; EVM/Solana/Mina).

In the TOON stack this is the **maker (mill)** side of a rolling swap: it runs beside the connector and signs the leg-B payment-channel claims on the target chain, while the connector handles the client-facing leg-A payments. See toon-meta [`docs/rolling-swap.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/rolling-swap.md) for the protocol and [`docs/rolling-swap-deploy.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/rolling-swap-deploy.md) for deployment; for the client side of a swap, start with the toon-client [rig README](https://github.com/toon-protocol/toon-client/blob/main/packages/rig/README.md).

> Extracted from the TOON monorepo with full git history preserved. npm publishing is done by CI (changesets + `pnpm`, authed by the org `NPM_TOKEN` secret).

## Getting started with Devbox

[Devbox](https://www.jetify.com/devbox) pins the exact toolchain (Node 22, pnpm 8.15.x, Foundry 1.7.1) so every contributor builds with the same environment.

```bash
# Install devbox (one-time)
curl -fsSL https://get.jetify.com/devbox | bash

# Enter the pinned shell
devbox shell

# Inside the devbox shell:
node --version      # v22.x
pnpm --version      # 8.15.x
forge --version     # foundry (used by test:integration:anvil)
anvil --version

# Build and test
devbox run build    # pnpm install --no-frozen-lockfile && pnpm build
devbox run test     # pnpm test
devbox run lint     # pnpm lint
```
