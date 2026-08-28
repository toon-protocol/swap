---
'@toon-protocol/swap': minor
---

The maker no longer accepts the legacy claim-in-FULFILL swap protocol (swap#154, toon-meta#411 Stage 5).

By the time this lands, no client in the fleet emits legacy (toon-client#598), the removal gate has a real zero reading behind it (swap#152), and the cross-chain E2E harness no longer depends on the legacy path (swap#153). This is the second and last removal on the wire.

**Behaviour change:** a zero-condition kind:1059 gift wrap whose inner rumor is not kind:20033 — overwhelmingly the retired legacy kind:20032 request — is now refused with a named, machine-readable reason (`legacy_protocol_refused` in the base64-JSON reject `data`, or `unreadable_request` if the payload does not even unwrap). Previously it was dispatched to the SDK's `createSwapHandler` and, if valid, fulfilled with a signed balance-proof claim. A kind:20033 RFQ still establishes a rolling session exactly as before — the RFQ sniff this reject sits behind is untouched.

`rfqIntake.handle()` is now terminal: it always returns an accept or a reject, never `null`, so there is no more legacy fall-through in `swap-node.ts`. The `rolling.rfq.enabled` config knob is removed — it had become a switch whose only function was disabling the maker's sole remaining protocol.

`createSwapHandler` and `withMaxRateAge` remain exported from this package (Stage 6, a major bump, retires them from the public API) but are no longer wired into `startSwapNode()`. `MultiChainClaimIssuer` and `SwapInventory` are unaffected — they are the rolling path's leg-B claim signer and capital, and stay exactly as they were.
