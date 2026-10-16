---
'@toon-protocol/swap': patch
---

Point the devnet examples and defaults at the consolidated devnet (2026-10-16): relay reads at `wss://relay.toonprotocol.dev`, paid writes at `https://toonprotocol.dev/ilp`. The old `proxy.relay.devnet` / `relay-ws.devnet` hosts are retired. The gas station's `g.toon.relay.gas` route is now terminated by that same connector, so `gasStation.connectorUrl` is no longer needed on the devnet — set it only where the route is forwarded to a separate connector.
