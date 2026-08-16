---
'@toon-protocol/swap': minor
---

**Adopt `@toon-protocol/sdk@3.2.0`'s `onFailure` seam and delete the workaround that stood in for it.**

swap#137 had to reclaim the SDK swap handler's swallowed diagnoses from the outside, because `createSwapHandler` collapsed every non-`INSUFFICIENT_INVENTORY` failure into an opaque `T00 Internal error` and discarded the error object. SDK 3.2.0 (toon#204/#205) adds `CreateSwapHandlerConfig.onFailure`: a synchronous classifier called before the handler rejects on any *thrown* failure, handed the thrown value verbatim, the packet context, and the `defaultRejection` it would otherwise emit.

`claim-refusal.ts` is now that classifier and nothing else. Deleted with the workaround:

- the `AsyncLocalStorage` per-packet capture slot;
- `instrument()`, which wrapped the claim issuer purely to observe its throws;
- `wrap()`, which wrapped the whole handler and sniffed its response for the literal `T00` / `Internal error` to know when to rewrite it;
- the inference that named the `encrypt` stage from the *absence* of an issuer throw.

**The encrypt path is now observed, not inferred.** The SDK reports `stage: 'encrypt'` with `context.claimIssued: true`, `context.claimId`, and the thrown value, so the refusal carries the real encryption error (`claim_encrypt_failed: … : <error>`, plus `err` and `claimId` in the reject `data`) instead of a deduction with an empty payload.

**No behaviour change on the wire.** An unredeemed channel still refuses with `T04` / `insufficient_funds`, the same `channel_unredeemed: …` message naming the channel and the unredeemed amount, and the same base64-JSON `data`. `INSUFFICIENT_INVENTORY` — and anything else the SDK already classified, signalled by `defaultRejection.code !== 'T00'` — is still left entirely to the SDK. `rate_provider` and `rate_conversion` are untouched; `RateFreshnessGuard` still owns staleness upstream. No new configuration key.

`swap-node.claim-refusal.test.ts`, the end-to-end proof of the live-verified swap#137 contract, passes unchanged.

Package surface: `createClaimRefusalDiagnostics` and the `ClaimRefusalDiagnostics` type are gone (they existed only to carry the workaround); `createClaimRefusalMapper` replaces them. `classifyClaimIssuerError`, `buildClaimRefusalReject`, `CLAIM_REFUSAL_REASONS`, `ClaimRefusal`, `ClaimRefusalReason` and `ClaimRefusalReject` are unchanged — `rolling-engine.ts` is a live caller of the classifier.
