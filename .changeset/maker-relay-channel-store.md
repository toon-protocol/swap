---
'@toon-protocol/swap': patch
---

The maker now defaults its relay channel-watermark file beside `statePath`, as the taker
already did and as `SwapNodeRelayConfig.channelStorePath` has always documented
("default beside `statePath`").

Without `relay.channelStorePath` set explicitly, `startSwapNode` passed no `channelStore` at
all, so the client held the watermark in memory and warned: a restart then re-signs at nonces
the relay's connector has already banked, the connector refuses every one of them, and the
channel's collateral stays locked. The maker is the party that runs for weeks, so it is the
one that could least afford the in-memory default.
