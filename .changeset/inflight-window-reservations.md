---
'@toon-protocol/swap': major
---

Rolling path: inventory → in-flight window reservation model (swap#49, rolling-swap spec §8, toon-meta#145).

The rolling coupled-leg flow no longer permanently debits a notional pre-fund. Each fill takes a TTL'd **window reservation** for its leg-B amount (durable, write-ahead, before the leg-B advance is externalized), which is **committed** to unsettled channel liability on fulfill (shrunk later by on-chain settlement confirmations) or **released** on reject/rollback/TTL expiry. Capacity is gated by `min(windowBudget, available) − inFlight − unsettled` — the maker's honeypot is sized to δ×W of open packets plus the unsettled balance, not to notional volume; a capacity shortage rejects with the same benign T04 `insufficient_liquidity` vocabulary as before. Reservation TTLs align with the engine's leg-B expiry budget (+`rolling.reservationGraceMs`, default 5s), so a crashed/stalled packet frees its slot; crash recovery is expire-and-release (state-store crash rule 6) — no leaked capacity, no double-spend. The legacy zero-condition gift-wrap path keeps permanent debit/credit unchanged.

Part of the same major train as the rolling engine (swap#47). Major because:

- `SwapNodeInstance` gains a required `recordSettlement(event)` member and `SwapNodeHealthResponse` a required `inventoryWindow` three-bucket record (`budget`/`inFlight`/`unsettled`/`free`) — breaking for structural implementations/doubles.
- `SwapInventoryBalance` gains a required `unsettled` field; `SwapInventory` snapshots and the persisted state schema change shape (`PersistedSwapState.version` 1 → 2, new `reservations`/`settledWatermarks` sections; v1 snapshots still load with defaults).
- `MultiChainClaimIssuer.rollbackClaim()` (introduced unreleased in swap#47) is replaced by the reservation-keyed `issueRollingClaim()`/`commitRollingClaim()`/`rollbackRollingClaim()` triple; the rolling engine no longer calls `issueClaim()`.

Also new: `SwapNodeConfig.windowBudget` (per-chain in-flight ceiling, CLI `windowBudget` config key), `SwapInventory.reserve/commitReservation/releaseReservation/recordSettlement/windowSnapshot`, and the `resolveChannel` doc comment corrected to the actual first-unbound-channel policy (binding is not capacity-aware; the window budget bounds exposure one level up).
