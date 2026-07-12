---
'@toon-protocol/swap': minor
---

Maker staleness-reject (`maxRateAge`) prototype — toon-protocol/swap#48, rolling-swap epic toon-meta#145 (spec §4).

New maker-owned per-chain/per-pair freshness bound: when configured, any kind:1059 fill packet whose pair's rate feed has not ticked within the bound is rejected BENIGNLY — before the replay reservation, pricing, and leg-B claim issuance — with a machine-distinguishable contract the sender treats as "re-quote and retry":

- handler-level code `T99`, `message: 'stale_rate'`, base64-JSON `data` `{"reason":"stale_rate","maxRateAgeMs":…,"lastRateAt":…,"pair":…}` (`StaleRateRejectData`)
- `rejectReason.code: 'timeout'` → wire T00 (T-class, retryable) on connector <=3.20.1, whose `REJECT_CODE_MAP` has no `stale_rate`/T99 entry yet; senders MUST discriminate on `data.reason === 'stale_rate'` (fallback `message`), not the wire code

Config: `SwapNodeConfig.maxRateAge` (`{ defaultMs?, perChain?, perPair? }`; perPair > min(perChain across both legs, exact id or family) > defaultMs), env `SWAP_MAX_RATE_AGE` (JSON) / `SWAP_MAX_RATE_AGE_MS`. Requires a `rateProvider`; `SwapNodeConfig.rateProvider` is widened to return timestamped quotes `{ rate, at }` (bare strings still accepted — but leave the guard inert). `maxRateAge` without a `rateProvider` fails boot with `INVALID_CONFIG`.

Calibrated per-chain-class starting points exported as `RECOMMENDED_MAX_RATE_AGE_MS` (`evm: 1500`, `solana: 3000`, `mina: 15000`) — derived and pinned by the seeded simulation harness in `max-rate-age.calibration.test.ts` (rule of thumb: ~4-6× the feed's median tick interval, ≈ its p99 gap). Unconfigured swap nodes are behavior-identical.
