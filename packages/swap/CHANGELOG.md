# @toon-protocol/swap

## 1.0.0

### Major Changes

- e4a0608: BREAKING (local API + env): retire the legacy "mill" vocabulary entirely — hard cut, no aliases, no fallback env reads (matches the org's dvm→store precedent; the sdk 2.x wire rename `millSignerAddress`→`swapSignerAddress` already shipped separately).
  - Env vars: `MILL_MNEMONIC`→`SWAP_MNEMONIC`, `MILL_SECRET_KEY_HEX`→`SWAP_SECRET_KEY_HEX`, `MILL_BLS_PORT`→`SWAP_BLS_PORT`, `MILL_RELAYS`→`SWAP_RELAYS`
  - Public API: `startMill()`→`startSwapNode()`, `MillConfig`→`SwapNodeConfig`, `MillInstance`→`SwapNodeInstance` (`.millKeys`→`.swapNodeKeys`), `MillLogger`→`SwapNodeLogger`, `MillHealthResponse`→`SwapNodeHealthResponse`, `MillStartError(Code)`→`SwapNodeStartError(Code)`, `Mill*ChainProvider`→`SwapNode*ChainProvider`, `MillKeys`→`SwapNodeKeys`, `MillChainKind`→`SwapNodeChainKind`, `deriveMillKeys`→`deriveSwapNodeKeys`, `DeriveMillKeysInput`→`DeriveSwapNodeKeysInput`, `MillInventory*`→`SwapInventory*`, `MillChannelState*`→`SwapChannelState*`, `MillWalletError(Code)`→`SwapWalletError(Code)`
  - Error-code string: `MILL_REQUIRES_MNEMONIC`→`SWAP_REQUIRES_MNEMONIC`
  - Files/CLI: `src/mill.ts`→`src/swap-node.ts`, default config path `./mill.config.json`→`./swap.config.json`
  - Default ILP address prefix: `g.toon.mill.<pubkey16>`→`g.toon.swap.<pubkey16>` (self-declared via kind:10032; nothing deployed)
  - Log event names: `mill.*`→`swap.*`

  See `docs/sdk-2x-migration.md` for the full mapping table.

- e4a0608: Migrate to `@toon-protocol/sdk` ^2.0.0 / `@toon-protocol/core` ^2.0.0 / `@toon-protocol/connector` ^3.20.1 and adopt the mill→swap wire vocabulary (toon#48, swap#45; rolling-swap prerequisite P4 for toon-meta#145).

  BREAKING (wire): FULFILL accept-metadata now emits `swapSignerAddress` / `swapEphemeralPubkey` instead of `millSignerAddress` / `millEphemeralPubkey`, with no back-compat alias. sdk 0.5.x clients silently drop the renamed fields at `decodeFulfillMetadata` and fail much later at settlement with `MISSING_SETTLEMENT_METADATA` — deploys MUST be coordinated with the toon-client sdk-2.x migration (toon-client#349). See `docs/sdk-2x-migration.md` for the deploy-ordering rule and mixed-fleet symptom.

  Connector stays at ^3.20.1 (highest published; the connector npm publish pipeline is broken past 3.20.1 — bump to ^3.28 when fixed). The embedded child-connector boot (`relation: 'parent'` skip + `setPacketHandler` seam) is re-verified against the installed connector by a new boot smoke test.

### Minor Changes

- 9917dc0: Persist swap node state across restarts (issue #46, rolling-swap prerequisite P2): inventory, channel nonce/cumulative watermarks, sticky sender→channel bindings, and replay reservations survive a crash or restart. New `SwapNodeConfig.statePath` / `stateStore` (CLI: `statePath`, env `SWAP_STATE_PATH`) enables a JSON-file snapshot written atomically (temp file + fsync + rename) with write-ahead ordering: the watermark is persisted BEFORE a signed claim can leave the process, so a handed-out claim is never ahead of the stored watermark. `startSwapNode` rehydrates the snapshot at boot (persisted values win over config notionals; corrupt snapshots fail boot loudly with `STATE_LOAD_FAILED` instead of silently resetting watermarks). Adds `JsonFileSwapStateStore`, `SwapStatePersister`, `PersistentSeenPacketIds`, `SwapChannelState.snapshot()`/binding rehydration, and `MultiChainClaimIssuer.persistState` (write-ahead failure → `PERSISTENCE_FAILED`, claim refused, state rolled back). Without `statePath`/`stateStore` the swap node runs in-memory exactly as before.
- 9c384b7: Maker staleness-reject (`maxRateAge`) prototype — toon-protocol/swap#48, rolling-swap epic toon-meta#145 (spec §4).

  New maker-owned per-chain/per-pair freshness bound: when configured, any kind:1059 fill packet whose pair's rate feed has not ticked within the bound is rejected BENIGNLY — before the replay reservation, pricing, and leg-B claim issuance — with a machine-distinguishable contract the sender treats as "re-quote and retry":
  - handler-level code `T99`, `message: 'stale_rate'`, base64-JSON `data` `{"reason":"stale_rate","maxRateAgeMs":…,"lastRateAt":…,"pair":…}` (`StaleRateRejectData`)
  - `rejectReason.code: 'timeout'` → wire T00 (T-class, retryable) on connector <=3.20.1, whose `REJECT_CODE_MAP` has no `stale_rate`/T99 entry yet; senders MUST discriminate on `data.reason === 'stale_rate'` (fallback `message`), not the wire code

  Config: `SwapNodeConfig.maxRateAge` (`{ defaultMs?, perChain?, perPair? }`; perPair > min(perChain across both legs, exact id or family) > defaultMs), env `SWAP_MAX_RATE_AGE` (JSON) / `SWAP_MAX_RATE_AGE_MS`. Requires a `rateProvider`; `SwapNodeConfig.rateProvider` is widened to return timestamped quotes `{ rate, at }` (bare strings still accepted — but leave the guard inert). `maxRateAge` without a `rateProvider` fails boot with `INVALID_CONFIG`.

  Calibrated per-chain-class starting points exported as `RECOMMENDED_MAX_RATE_AGE_MS` (`evm: 1500`, `solana: 3000`, `mina: 15000`) — derived and pinned by the seeded simulation harness in `max-rate-age.calibration.test.ts` (rule of thumb: ~4-6× the feed's median tick interval, ≈ its p99 gap). Unconfigured swap nodes are behavior-identical.
