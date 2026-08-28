# swap

The TOON Protocol **multi-chain swap node**: `@toon-protocol/swap` — receives a paid swap request and returns a **signed target-chain payment-channel claim** (pay asset A → get a claim redeemable for asset B), across EVM / Solana / Mina. (Renamed from `@toon-protocol/mill`; bin `toon-swap`. The legacy "mill" vocabulary is fully retired — public API (`startSwapNode`/`SwapNodeConfig`), env vars (`SWAP_MNEMONIC`, …), files, and docs are all swap-named; do not reintroduce mill-named identifiers.)

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos. The swap node is an **HTTP app behind a Rust connector's route termination** (`docs/rust-connector-migration.md`): the connector verifies leg A and delivers paid fills with `X-TOON-*` headers; the maker answers with the leg-B claim. It embeds no connector and publishes no kind:10032.

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
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo (Rust). **Payment-claim validation lives ONLY in the connector.** The swap node's own signature work is *target-chain* leg-B claim issuance — a different concern from inbound payment gating. `@toon-protocol/connector` on npm (4.x) is a thin client shim and is **not** a dependency here.
- The e2e suite needs a connector: `SWAP_E2E_CONNECTOR_BIN` (a built `connector` binary) or `SWAP_E2E_CONNECTOR_IMAGE` (`ghcr.io/toon-protocol/connector:rust-sha-…`). `tests/e2e/helpers/rust-connector.ts` refuses a port something else already answers on — a stale `docker run` from an aborted run is the usual cause of an `F02 no route` surprise.
- Image-publish workflow (the `swap` Docker image) is a follow-up.

### Config first, code second

The maker's runtime config is **not in this repo and not in the image**. The relay box bind-mounts `infra/linode-relay/swap.config.json` from **connector**, so a change here that makes a new config key *required* is only half a change:

1. Add the key to `infra/linode-relay/swap.config.json` in **`toon-protocol/connector`**, and **merge that first**.
2. Then merge the code that requires it here.

Backwards: `:release` cannot move (connector [ADR 0041](https://github.com/toon-protocol/connector/blob/main/docs/adr/0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md)), and until it does, the live maker keeps running the previous build. #139 and #140 both hit this on 2026-08-16 — two failed publishes and a manual re-run.

CI enforces the ordering on the PR (`swap runtime image build` → *"This build must still boot the fleet's committed maker config"*, inside the required `CI OK`), so you find out before the merge rather than after. The publish-time gate in `publish-swap-image.yml` re-asks the same question on `main` and is the authoritative one; neither is skippable.

**The cheaper answer is usually to make the setting optional with a safe default** — then there is no ordering constraint at all.

## Publishing
CI publishes via **changesets + `pnpm`** using the org `NPM_TOKEN` secret. **Never run `npm publish`**. This will be `swap`'s first-ever npm publish.
