---
'@toon-protocol/swap': patch
---

Fix `relay.payChain: "solana"`, which could not open its channel with the relay's connector.

Both the maker (`startSwapNode`) and the taker (`createTakerRuntime`) handed the relay client
only the Solana key when paying on Solana. The client's on-chain channel client is the EVM
transaction signer as well, so it refused to build, with a message telling the operator to
supply a `mnemonic` instead of a bare `solanaSecretKey` — advice the swap cannot act on, since it
derives its own keys by design. Both call sites now pass the EVM key whatever the pay chain is;
`chain` still decides which chain the money moves on. A Solana-paying node now proceeds to the
real, actionable error when it is short of SOL for channel rent.
