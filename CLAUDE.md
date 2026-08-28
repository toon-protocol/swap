# swap

The TOON Protocol **multi-chain swap client**: `@toon-protocol/swap` — a maker publishes an order on a relay and a taker streams it fills; each fill exchanges **cumulative payment-channel claims** (pay asset A → hold a claim redeemable for asset B), across EVM / Solana. (Renamed from `@toon-protocol/mill`; bin `toon-swap`. The legacy "mill" vocabulary is fully retired — public API (`startSwapNode`/`SwapNodeConfig`), env vars (`SWAP_MNEMONIC`, …), files, and docs are all swap-named; do not reintroduce mill-named identifiers.)

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos. The swap is **relay-mediated** (`docs/relay-swap.md`): both parties are plain TOON clients; orders are public kind:30032 events, everything else is a NIP-59 gift wrap on the relay; every write is a paid packet to the relay's connector, which never opens a wrap. **Each party verifies the other's claim itself** (`src/received-claim.ts`). Nothing here runs or sits behind a connector, and nothing publishes kind:10032. A swap is a **stream of micro-claims** (δ per fill, taker-chosen within the order's bounds), never one claim.

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
- Consumes `@toon-protocol/client` (2.1.0+) from npm for paid relay writes only (`ToonClient`). Relay reads, NIP-59, Nostr keys and inbound-claim verification live here (`relay-subscription.ts`, `nip59.ts`, `nostr-keys.ts`, `received-claim.ts`) — the client is a pure payer and deleted its own copies in 2.0.
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo (Rust). It verifies the **carriage** claim on every relay write; it never sees a swap claim (payload opacity). Swap-claim verification is this repo's `verifyInboundClaim`, run by whichever party receives the claim.
- The e2e suite needs a relay (`@toon-protocol/relay`, a devDependency, or `SWAP_E2E_RELAY_BIN`) and a connector to front it: `SWAP_E2E_CONNECTOR_BIN` (a built `connector` binary) or `SWAP_E2E_CONNECTOR_IMAGE` (`ghcr.io/toon-protocol/connector:rust-sha-…`). `tests/e2e/helpers/rust-connector.ts` refuses a port something else already answers on — a stale `docker run` from an aborted run is the usual cause of an `F02 no route` surprise.
- The dev loop runs against the live **devnet** (`wss://relay-ws.devnet.toonprotocol.dev`, `https://proxy.relay.devnet.toonprotocol.dev/ilp`, Base Sepolia, Solana devnet); the local harness is the CI proof. The gas station cannot redeem swap claims yet (gas-station#18).
- Image-publish workflow (the `swap` Docker image) is a follow-up.

### Config first, code second

The maker's runtime config is **not in this repo and not in the image**. The relay box bind-mounts `infra/linode-relay/swap.config.json` from **connector**, so a change here that makes a new config key *required* is only half a change:

1. Add the key to `infra/linode-relay/swap.config.json` in **`toon-protocol/connector`**, and **merge that first**.
2. Then merge the code that requires it here.

Backwards: `:release` cannot move (connector [ADR 0041](https://github.com/toon-protocol/connector/blob/main/docs/adr/0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md)), and until it does, the live maker keeps running the previous build. #139 and #140 both hit this on 2026-08-16 — two failed publishes and a manual re-run.

CI enforces the ordering on the PR (`swap runtime image build` → *"This build must still boot the fleet's committed maker config"*, inside the required `CI OK`), so you find out before the merge rather than after. The publish-time gate in `publish-swap-image.yml` re-asks the same question on `main` and is the authoritative one; neither is skippable.

**The cheaper answer is usually to make the setting optional with a safe default** — then there is no ordering constraint at all. That is why a config with `relayUrls` but no `relay.connectorUrl` boots **offline** (engine, health, admin; no orders, no fills) with a loud warning instead of refusing: the fleet's committed file predates the relay-mediated swap. Add `relay.connectorUrl` there to make the maker trade.

## Publishing
CI publishes via **changesets + `pnpm`** using the org `NPM_TOKEN` secret. **Never run `npm publish`**. This will be `swap`'s first-ever npm publish.
