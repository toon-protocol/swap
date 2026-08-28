# swap

TOON Protocol multi-chain swap node — @toon-protocol/swap (issues signed target-chain payment-channel claims; EVM/Solana/Mina).

In the TOON stack this is both sides of a **relay-mediated rolling swap**. A maker publishes an order on a TOON relay; a taker accepts it and streams fills — each fill a NIP-59 gift wrap carrying the taker's cumulative leg-A payment-channel claim, answered by one carrying the maker's cumulative leg-B claim on the target chain. Each party verifies the other's claim itself; the relay's [Rust connector](https://github.com/toon-protocol/connector) only charges carriage for the writes. The wire is `rolling/3` — see [`docs/relay-swap.md`](docs/relay-swap.md) for the design, `toon-swap make|orders|take|resume|redeem` for the CLI, and [`packages/swap/tests/e2e`](packages/swap/tests/e2e) for the cross-chain proof through a real relay (EVM↔Solana, redeemed on chain). toon-meta [`docs/rolling-swap.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/rolling-swap.md) is the protocol's history (`rolling/1`).

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
forge --version     # foundry (anvil-gated integration/e2e suites)
anvil --version

# Build and test
devbox run build    # pnpm install --no-frozen-lockfile && pnpm build
devbox run test     # pnpm test
devbox run lint     # pnpm lint
```
