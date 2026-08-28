---
'@toon-protocol/swap': patch
---

The README is now a guide (what this is, try it on the devnet in 60 seconds, run a maker,
choose δ, CLI reference, what is verified, state & resume), and `docs/how-it-works.md`
explains the swap sequence and the δ lever in plain language, with the devnet measurements.
A maker config may now omit `channels` for a chain whose `chainProviders[].channelDeposit`
opens channels on demand (previously that was refused as `INVALID_CONFIG`).
