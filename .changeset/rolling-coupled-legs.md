---
'@toon-protocol/swap': major
---

Rolling swap engine: coupled shared-condition packet legs (swap#47, rolling-swap spec §3, toon-meta#145).

Each fill packet's two legs now share ONE sender-minted execution condition `C_i = sha256(P_i)`: the connector delivers `C_i` to the swap node (local-delivery fulfillment contract, connector 3.29.x), the engine issues the chain-B cumulative claim as an outbound leg-B PREPARE under the SAME `C_i`, and can only FULFILL leg A by relaying the preimage the sender reveals after verifying that claim — value-atomic per packet, replacing claim-in-FULFILL on the rolling path. Legacy zero-condition gift-wrap fills keep the pre-existing claim-in-FULFILL behavior byte-for-byte.

Major because:

- `SwapNodeInstance` gains a required `registerRollingSession()` member (breaking for structural implementations/test doubles).
- Packets carrying a sender-chosen (non-zero) execution condition with a legacy gift-wrap payload are now rejected F99 up front instead of being dispatched (the legacy handler cannot mint the preimage; dispatching would debit inventory only for the connector to F99 the FULFILL with nothing recorded).
- `STALE_RATE_SEMANTIC_REASON` flips `'timeout'` → `'stale_rate'` (native wire T99), which requires `@toon-protocol/connector` >= 3.29.0 — the dependency floors move to connector ^3.29.1 / sdk ^2.1.0 / core ^2.1.0.

Also new: `RollingSwapEngine`/`RollingSessionStore` + wire payload types (`rolling/1` fill/advance/accept), `MultiChainClaimIssuer.rollbackClaim()` full-unwind for failed coupled packets, `createHttpRateProvider` + `SWAP_RATE_URL`/`SWAP_RATE_TIMEOUT_MS` CLI wiring so deployed makers finally price per packet via `rateProvider` instead of the config-frozen `pair.rate`.
