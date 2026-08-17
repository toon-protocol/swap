---
'@toon-protocol/swap': major
---

**A swap refusal is now logged and actionable, and a failed swap no longer leaks inventory.**

Two defects that together turned a mundane live condition into a multi-hour outage diagnosis.

**1 — the rejection that logged nothing.** After one successful swap the maker refused every subsequent swap with `T00 Internal error` and wrote not a single line. Two causes, both fixed:

- `cli.ts` — the entrypoint the published image runs — never supplied `config.logger`, so `startSwapNode()` installed its no-op default and *every* log statement in the swap node **and** in the SDK swap handler was a no-op. The CLI now installs a JSON-line console logger (`createConsoleLogger()`), verbosity via the optional `SWAP_LOG_LEVEL` env var (`debug|info|warn|error|silent`, default `info`). No new config key, and no new *required* anything.
- The SDK swap handler collapses everything except `INSUFFICIENT_INVENTORY` into `ctx.reject('T00', 'Internal error')`, discarding a perfectly good diagnosis. `claim-refusal.ts` now classifies what the claim issuer threw, logs it at warn/error, and replaces that blanket T00 on the wire:
  - unredeemed channel → **T04** / `insufficient_funds`, `channel_unredeemed: the maker's payment channel <id> on <chain> still has <n> unredeemed unit(s); redeem or settle the previous claim before swapping again`
  - no channel provisioned for the sender → **F99** / `application_error`, `no_channel_available: …`
  - persist / signing / encrypt failures stay T-class but say which one they are.

  Every refusal also carries base64-JSON reject `data` whose `reason` field is the machine discriminator, matching the `stale_rate` and rolling-engine reject contracts. The rolling coupled-leg path had the same silent-`T00` collapse and gets the same treatment.

**2 — a failed swap leaked inventory.** `issueClaim()`'s rollback called `SwapInventory.credit()`, the operator-refill primitive (`available += n` **and** `total += n`), to undo a `debit()` (`available -= n`). So `total` — what the maker advertises in kind:10032 and reports on `/health` — ratcheted upward on every failure (observed live: 15 001 000 against a configured 15 000 000). The unwind now uses a new `SwapInventory.refundDebit()`, the exact inverse of `debit`. A failed issuance is byte-identical on both buckets.

Still owed upstream: the SDK's `swap_handler.encrypt_failed` branch discards its error object entirely, so this package can only *infer* that path (claim issued, then a blanket T00) and name it. Surfacing the real error belongs in `@toon-protocol/sdk`'s `swap-handler.ts`.
