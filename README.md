# swap

TOON Protocol multi-chain swap node — @toon-protocol/swap (issues signed target-chain payment-channel claims; EVM/Solana/Mina).

In the TOON stack this is the **maker** side of a rolling swap: an HTTP app behind a [Rust connector](https://github.com/toon-protocol/connector) route termination. The connector verifies the taker's leg-A payment on chain and delivers each paid fill to the maker with `X-TOON-Payer`/`X-TOON-Amount`/`X-TOON-Chain`; the maker answers with a signed leg-B payment-channel claim on the target chain, which the connector seals into the FULFILL. The wire is `rolling/2` — see [`docs/rust-connector-migration.md`](docs/rust-connector-migration.md) for the design and [`packages/swap/tests/e2e`](packages/swap/tests/e2e) for a complete taker and the cross-chain proof (EVM↔Solana, redeemed on chain). toon-meta [`docs/rolling-swap.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/rolling-swap.md) is the protocol's history (`rolling/1`).

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
