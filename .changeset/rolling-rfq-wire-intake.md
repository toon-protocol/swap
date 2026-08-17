---
'@toon-protocol/swap': minor
---

The maker now accepts a rolling-swap session **from the wire**: an inbound kind:20033 RFQ (NIP-59 gift wrap, rolling-swap spec §2.2) registers the session and is answered with a gift-wrapped kind:20034 quote carrying `R₀`, `rateTimestamp`, quote expiry, `spread`, `maxRateAge`, `minAmount`/`maxAmount` and the leg-B `swapSignerAddress`.

Previously the rolling protocol shipped in the released image but was unreachable: the only way to put a session in the `RollingSessionStore` was the in-process `SwapNodeInstance.registerRollingSession`, which `cli.ts` — what the container runs — never calls. Every rolling fill reaching a deployed maker therefore rejected F06 `unknown_session`, and every real swap fell through to the legacy SDK gift-wrap handler.

Intake sits in `startSwapNode`'s existing `setPacketHandler` callback, ahead of the legacy branch, and is identified purely by the inner rumor kind — anything it cannot positively identify as an RFQ (including any unwrap failure) falls through to the legacy path byte-for-byte unchanged. Knobs are `rolling.rfq.{enabled,quoteTtlMs,spreadBps}`, all optional and defaulted (intake defaults ON); the CLI now also forwards the whole optional `rolling` config block. No new required config key. No announce change: per spec §10.3 step 2, rolling capability is discovered by probing the RFQ, not by an advertised flag.
