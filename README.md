# swap

TOON Protocol multi-chain swap node — @toon-protocol/swap (issues signed target-chain payment-channel claims; EVM/Solana/Mina). NB: npm package keeps the name @toon-protocol/swap this pass; mill->swap package rename is a follow-up.

> Extracted from the TOON monorepo with full git history preserved. npm publishing is done by CI (changesets + `pnpm`, authed by the org `NPM_TOKEN` secret). Docker image-publish workflows (where applicable) are a follow-up carved from the monorepo `publish-townhouse-images.yml`.

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
