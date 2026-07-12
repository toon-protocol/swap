---
'@toon-protocol/swap': major
---

Migrate to `@toon-protocol/sdk` ^2.0.0 / `@toon-protocol/core` ^2.0.0 / `@toon-protocol/connector` ^3.20.1 and adopt the mill→swap wire vocabulary (toon#48, swap#45; rolling-swap prerequisite P4 for toon-meta#145).

BREAKING (wire): FULFILL accept-metadata now emits `swapSignerAddress` / `swapEphemeralPubkey` instead of `millSignerAddress` / `millEphemeralPubkey`, with no back-compat alias. sdk 0.5.x clients silently drop the renamed fields at `decodeFulfillMetadata` and fail much later at settlement with `MISSING_SETTLEMENT_METADATA` — deploys MUST be coordinated with the toon-client sdk-2.x migration (toon-client#349). See `docs/sdk-2x-migration.md` for the deploy-ordering rule and mixed-fleet symptom.

Connector stays at ^3.20.1 (highest published; the connector npm publish pipeline is broken past 3.20.1 — bump to ^3.28 when fixed). The embedded child-connector boot (`relation: 'parent'` skip + `setPacketHandler` seam) is re-verified against the installed connector by a new boot smoke test.
