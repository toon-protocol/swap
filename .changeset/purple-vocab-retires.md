---
'@toon-protocol/swap': major
---

BREAKING (local API + env): retire the legacy "mill" vocabulary entirely — hard cut, no aliases, no fallback env reads (matches the org's dvm→store precedent; the sdk 2.x wire rename `millSignerAddress`→`swapSignerAddress` already shipped separately).

- Env vars: `MILL_MNEMONIC`→`SWAP_MNEMONIC`, `MILL_SECRET_KEY_HEX`→`SWAP_SECRET_KEY_HEX`, `MILL_BLS_PORT`→`SWAP_BLS_PORT`, `MILL_RELAYS`→`SWAP_RELAYS`
- Public API: `startMill()`→`startSwapNode()`, `MillConfig`→`SwapNodeConfig`, `MillInstance`→`SwapNodeInstance` (`.millKeys`→`.swapNodeKeys`), `MillLogger`→`SwapNodeLogger`, `MillHealthResponse`→`SwapNodeHealthResponse`, `MillStartError(Code)`→`SwapNodeStartError(Code)`, `Mill*ChainProvider`→`SwapNode*ChainProvider`, `MillKeys`→`SwapNodeKeys`, `MillChainKind`→`SwapNodeChainKind`, `deriveMillKeys`→`deriveSwapNodeKeys`, `DeriveMillKeysInput`→`DeriveSwapNodeKeysInput`, `MillInventory*`→`SwapInventory*`, `MillChannelState*`→`SwapChannelState*`, `MillWalletError(Code)`→`SwapWalletError(Code)`
- Error-code string: `MILL_REQUIRES_MNEMONIC`→`SWAP_REQUIRES_MNEMONIC`
- Files/CLI: `src/mill.ts`→`src/swap-node.ts`, default config path `./mill.config.json`→`./swap.config.json`
- Default ILP address prefix: `g.toon.mill.<pubkey16>`→`g.toon.swap.<pubkey16>` (self-declared via kind:10032; nothing deployed)
- Log event names: `mill.*`→`swap.*`

See `docs/sdk-2x-migration.md` for the full mapping table.
