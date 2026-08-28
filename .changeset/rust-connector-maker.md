---
'@toon-protocol/swap': major
---

**The swap is a relay-mediated client.** `@toon-protocol/swap` no longer embeds, dials, or sits
behind a connector at all. Both parties are plain TOON clients: the maker publishes a public
**order** (kind `30032`) on the relay; accept, quote, fill, advance, refusal and done are NIP-59
gift-wrapped rumors (kind `20036`) each carrying one side's **cumulative** payment-channel claim.
The relay stores them, so either party can go offline and resume from the last `seq`. Every
write is an ordinary paid packet to the relay's connector (`g.toon.relay`); the connector never
opens a wrap. This is the `rolling/3` wire (`src/wire.ts`). `rolling/1`'s coupled legs and
`rolling/2`'s HTTP route terminations are gone; see `docs/relay-swap.md`.

- **Each party verifies the other's claim itself** (`verifyInboundClaim`, `src/received-claim.ts`):
  signature before any chain read, channel id re-derived from the participants (ADR 0059),
  monotonic against a persisted inbound watermark seeded from chain, delta within the order's
  `fill: {min, max}`, on-chain deposit cover. Chain reads are cached and budgeted per
  counterparty (`maxChainReadsPerMin`).
- **A swap is a stream of micro-claims.** δ is taker-chosen per fill within the order's bounds;
  the maker prices the delta that arrived. One on-chain redeem per stream.
- **Maker:** `startSwapNode()` now takes `relay: { readUrl, connectorUrl, payChain?, deposit?, … }`,
  `order: { fill: {min, max}, ttlMs?, refreshMs? }`, `maxChainReadsPerMin?`; `chainProviders`
  must cover every `from.chain` as well as every `to.chain` (leg A needs the maker's facts there).
  `ilpAddress`, `fillAmount` and the `/swap/*` HTTP routes are gone; `GET /health` and `/admin/*`
  stay, on `node:http` (`hono` is no longer a dependency). Health gains `nostrPubkey`, `legA`,
  `relay`. Without `relay` the maker boots **offline** (engine, health, admin) and warns.
- **Taker:** new — `SwapTaker` (`listOrders`, `accept`, `run`, `resume`, `redeem`),
  `createTakerRuntime`, `JsonFileTakerStateStore`, `createRedeemer` (EVM `claimFromChannel`;
  Solana claim/close/settle), and the CLI subcommands `toon-swap orders|take|resume|redeem|close|settle|sessions`.
- **Relay plane:** `deriveNostrIdentity` (NIP-06 at the swap's account index), `wrapGiftWrap` /
  `unwrapGiftWrap` (NIP-59 with NIP-40 expiration and a real `created_at` on the wrap),
  `RelaySubscription` (NIP-01 reads with EOSE), `createRelayWriter` / `createRelayClient`
  (paid writes via `@toon-protocol/client` 2.1.0, now a runtime dependency).
- **State:** schema v3 adds `sessions`, `inbound`, `relayCursor`, `orders` and renames
  `seenPacketIds` → `seenEventIds`; v1/v2 snapshots load.
- **Config aliases so a committed fleet config boots:** `relayUrls[0]` → `relay.readUrl`,
  `connectorUrl` → `relay.connectorUrl`, `fillAmount` → `order.fill.min`. Remaining 2.x keys are
  accepted and ignored with a warning; `ilpAddress` joins them. New env:
  `SWAP_RELAY_READ_URL`, `SWAP_RELAY_CONNECTOR_URL`, `SWAP_RELAY_DESTINATION`,
  `SWAP_RELAY_PAY_CHAIN`, `SWAP_FILL_MIN` / `SWAP_FILL_MAX` (`SWAP_FILL_AMOUNT` → min).
- **Chain side, unchanged from the previous 3.0.0 changesets:** leg B on the fleet's
  `TokenNetwork` / Solana program channel opened by the maker on demand; the 96-byte
  `TOON-BALPROOF-V2` Solana proof; PDA-resolved Solana channels; inventory raised from config.
- **API removed:** `registerMakerRoutes`, `MAKER_RFQ_PATH`, `MAKER_FILL_PATH`, `MakerAnswer`,
  `SwapRfqRequest`, `SwapFillRequest`, `parseSwapRfqRequest`, `parseSwapFillRequest`,
  `readPaymentAttribution`, `SWAP_REFUSAL_STATUS`, `PAYMENT_HEADER_*`, `registerAdminRoutes`
  (→ `handleAdminRequest`), `SwapNodeInstance.ilpAddress/rfqDestination/fillDestination`.
- **Tests:** `tests/e2e/relay-swap.e2e.test.ts` drives EVM→Solana and Solana→EVM swaps through a
  real relay, its Rust connector, anvil and `solana-test-validator`, redeems every leg-B claim on
  chain, and proves taker resume and maker restart; `src/maker.test.ts` does the same over an
  in-memory relay.
- **Gasless redemption is not available yet** — the gas station excludes claims
  (toon-protocol/gas-station#18).
