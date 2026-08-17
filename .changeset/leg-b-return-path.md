---
'@toon-protocol/swap': minor
---

**A rolling fill can now actually be delivered: leg B goes back over the BTP session its RFQ arrived on.**

A live devnet swap negotiated a rolling session end to end for the first time — and then delivered nothing. The maker quoted, opened the session, and F02'd its own leg-B PREPARE:

```
maker:  REJECT destination=g.toon.client errorCode=F02 "no route found"
maker:  swap.rolling.fill_unwound streamNonce=1007de73… seq=1 cause=F02
client: F99 "leg B failed; fill not executed"  packetsAccepted 0, valueReceived 0
```

The address was right. The maker simply had no way to reach it, and — because auto-probe is the default and this maker now answers the RFQ — **every** default swap against it failed. Only an explicit `rolling: "off"` still worked.

**Two layers, both maker-side, neither of which any existing test could see** (every rolling test injects `rollingLegBSender` or drives a fake connector, so leg B never touched a routing table):

1. **No route.** A client that direct-dials the maker's BTP server is an inbound *session*, bound in `BTPServer.peers` under the `peerId` it declared on the auth greeting — never a routing-table entry. `ConnectorNode.sendPacket` resolves a destination only through `RoutingTable.getNextHop()`, so leg B was rejected before it left the maker. Requiring an operator to hand-configure a route for each client would make the direct-dial model (swap#105, `docker-compose.relay.swap.yml`) unusable.

2. **No settlement channel.** Even routed, `PacketHandler` demands a per-packet claim on every value-bearing forward to a non-`child` next hop, and a maker holds no payment channel toward the client it is *paying* — so a routed leg B answers `T00 "No payment channel available for peer"` instead. `'child'` is the ILP-correct relation, not a workaround: the connector's own comment for that skip is *"a parent settles DOWN to a child by letting the child accrue a balance owed up"*, which is exactly the rolling swap's netting (the sender pays on leg A; leg B's value is the signed chain-B claim inside the packet, never an ILP settlement over the link).

New `leg-b-return-path.ts` resolves the return path at RFQ intake, from the session the RFQ actually arrived on (`LocalDeliveryRequest.sourcePeer`) — so a **stock client works against a stock maker with no operator routing configuration**. It adds no config key.

Guards, because an RFQ payload is attacker-controlled:

- the route is only ever `prefix: X → nextHop: X` for the string the peer **authenticated under** — a stock client's `senderIlpAddress` is by construction the same expression as its BTP greeting `peerId`, and requiring the match stops an RFQ claiming `senderIlpAddress: "g.proxy"` from shadowing the maker's upstream route;
- a prefix that would shadow the maker's own `ilpAddress` is refused;
- an operator/static route for the same prefix always wins;
- bindings are capped and LRU-evicted, and withdrawn on `stop()`.

**When the maker cannot deliver, it now refuses at leg 0** (`F02` / `reason: "no_return_path"`) instead of minting a session every fill will fail. That is the only moment failing is free — nothing quoted, no inventory reserved, no leg A revealed — and a sender's existing RFQ-failure fallback quietly takes the legacy path, which works. No retry-after-failure was added: re-running a fill as legacy after a rolling attempt is exactly the shape that risks double-delivery, and the withhold property (spec R5/R8) is what made the original failure free.

Also: the standalone connector branch now sets `settlement: { connectorFeePercentage: 0 }`, mirroring the embedded-with-parent branch. Without it the default fee shaved the ILP `amount` of the one thing a standalone maker ever forwards — its own leg-B PREPARE — so the packet understated the claim it carried (3000 → 2997).

Withhold behaviour is unchanged, and is now also asserted on the real wire: a sender that answers leg B with a REJECT leaves leg A rejected with no preimage learned.

New tests boot a REAL `startSwapNode()` with a REAL `ConnectorNode` and drive it from a REAL `BtpRuntimeClient` over a socket — the same `onMessage` seam a stock client installs its leg-B router on. That is what caught defect 2; a unit test of address derivation would have caught neither.
