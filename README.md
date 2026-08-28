# swap

`@toon-protocol/swap` — swap USDC across chains through a TOON relay, with no server in
between. A maker publishes an order; a taker streams it small fills; each side verifies the
other's signed payment-channel claim; the newest claim is redeemed on chain once.

| Start here | |
| --- | --- |
| **Guide** — install, try it on the devnet, run a maker, the CLI | [packages/swap/README.md](packages/swap/README.md) |
| **How it works** — the sequence, and the one number you turn (δ) | [docs/how-it-works.md](docs/how-it-works.md) |
| Design record — why the swap is relay-mediated, what does not change | [docs/relay-swap.md](docs/relay-swap.md) |
| Operator & config reference | [deploy/swap/README.md](deploy/swap/README.md) |
| The proof — EVM↔Solana through a real relay, redeemed on chain | [packages/swap/tests/e2e](packages/swap/tests/e2e) |
| History — `rolling/1`, the protocol's first shape | toon-meta [docs/rolling-swap.md](https://github.com/toon-protocol/toon-meta/blob/main/docs/rolling-swap.md) |

Published on npm as [`@toon-protocol/swap`](https://www.npmjs.com/package/@toon-protocol/swap)
by CI (changesets + `pnpm`, authed by the org `NPM_TOKEN` secret). The relay's
[Rust connector](https://github.com/toon-protocol/connector) charges for each write and never
opens a message.

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
