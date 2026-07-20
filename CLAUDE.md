# swap

The TOON Protocol **multi-chain swap node**: `@toon-protocol/swap` — receives a paid swap request and returns a **signed target-chain payment-channel claim** (pay asset A → get a claim redeemable for asset B), across EVM / Solana / Mina. (Renamed from `@toon-protocol/mill`; bin `toon-swap`. The legacy "mill" vocabulary is fully retired — public API (`startSwapNode`/`SwapNodeConfig`), env vars (`SWAP_MNEMONIC`, …), files, and docs are all swap-named; do not reintroduce mill-named identifiers.)

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos. The swap node runs an embedded connector as a child of the apex and publishes its swap pairs as kind:10032 peer-info.

## Build & test
```
pnpm install
pnpm -r build
pnpm -r test
```

## Shared skills, docs & project context → toon-protocol/toon-meta
Cross-cutting agent skills, docs, and the canonical project context live in **[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**. Load the shared skills:
```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```
Canonical rules/decisions: `toon-meta` → `context/decisions.md` and `context/context.md`.

## Cross-repo dependencies
- Consumes `@toon-protocol/{core,sdk}` from **npm** (pinned semver).
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo. **Payment-claim validation lives ONLY in the connector.** The swap node's own signature work (`settlement/build-settlement-tx`) is *target-chain* claim issuance/verification — a different concern from inbound payment gating.
- Image-publish workflow (the `swap` Docker image) is a follow-up.

## Publishing
CI publishes via **changesets + `pnpm`** using the org `NPM_TOKEN` secret. **Never run `npm publish`**. This will be `swap`'s first-ever npm publish.
