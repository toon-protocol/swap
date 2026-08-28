---
'@toon-protocol/swap': major
---

`@toon-protocol/swap` drops the legacy claim-in-FULFILL public API (toon-meta#411 Stage 6). The
maker itself already stopped serving this protocol (swap#154); this removes the now-dead exports
so a published 3.0.0 no longer promises them.

Removed from the public API:

- `createSwapHandler` / `CreateSwapHandlerConfig` (the `@toon-protocol/sdk` re-export)
- `withMaxRateAge` / `WithMaxRateAgeOptions` (the legacy handler's staleness-gate decorator)
- `MultiChainClaimIssuer.issueClaim` (the legacy gift-wrap issuance entrypoint)
- `SwapInventory.debit` / `.refundDebit` (the permanent-debit accounting the legacy path used —
  a honeypot sized to notional with no refill loop, per swap#138/#141). `SwapInventory.credit`
  goes `private` in the same move: it is now reachable only through
  `creditCorroboratedFunding()`, so no caller can raise `total` without chain corroboration.

No throwing compatibility shim replaces any of these — a caller gets a missing export (or, for
the removed methods, a type error) at build time, not a runtime surprise later.

**What survives, unchanged in shape:** `MultiChainClaimIssuer` remains the leg-B claim signer
(`issueRollingClaim` / `commitRollingClaim` / `rollbackRollingClaim`, its per-chain signers and
wallet) and `SwapInventory` remains the rolling window's capital (`reserve` / `commitReservation`
/ `releaseReservation` / `recordChainRedemption` / `creditCorroboratedFunding`). Neither class nor
its rolling-path methods changed.

**Migration:** `createSwapHandler` had exactly one job — issue a claim from pre-funded inventory
on receipt of a legacy gift-wrap — and there is no rolling equivalent to point a caller at, because
rolling is not a handler you install onto a connector; it is a maker you run. The supported way to
run a maker, on any protocol this package still serves, is `startSwapNode()`.
