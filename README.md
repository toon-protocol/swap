# swap

TOON Protocol multi-chain swap node — @toon-protocol/swap (issues signed target-chain payment-channel claims; EVM/Solana/Mina). NB: npm package keeps the name @toon-protocol/swap this pass; mill->swap package rename is a follow-up.

> Extracted from the TOON monorepo with full git history preserved. npm publishing is done by CI (changesets + `pnpm`, authed by the org `NPM_TOKEN` secret). Docker image-publish workflows (where applicable) are a follow-up carved from the monorepo `publish-townhouse-images.yml`.

## Getting started with Devbox

[Devbox](https://github.com/jetify-com/devbox) pins the local toolchain so your environment matches CI exactly: Node 20, pnpm 8.15.0, Foundry (forge/cast/anvil), and jq.

**Install Devbox** (one-time):
```bash
curl -fsSL https://get.jetify.com/devbox | bash
```

**Enter the dev shell** (pins all tools):
```bash
devbox shell
```

Inside the shell, verify the toolchain:
```bash
node --version    # v20.x
pnpm --version    # 8.15.0
forge --version
anvil --version
jq --version
```

Then install dependencies and run the build/tests as normal:
```bash
pnpm install --no-frozen-lockfile
pnpm -r build
pnpm -r test
```

Or run a single command without entering the shell:
```bash
devbox run -- pnpm -r build
```
