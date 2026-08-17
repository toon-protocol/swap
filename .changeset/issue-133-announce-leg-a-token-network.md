---
'@toon-protocol/swap': major
---

The swap node's kind:10032 `tokenNetworks` map now advertises **leg A** — the deployed `TokenNetwork` a client calls `openChannel(address participant2, uint256 settlementTimeout)` on to open the payment channel it pays this maker over — sourced from a new required `chainProviders[].tokenNetworkAddress`. The maker's own `RollingSwapChannel` (`chainProviders[].channelAddress`) moves to its own announce key, `swapVerifyingContracts`, which is **leg B**: the EIP-712 `verifyingContract` its v2 balance-proof claims are signed under.

Previously `tokenNetworks` carried the `RollingSwapChannel`. `tokenNetworks` is the field a stock client reads to open leg A, and `RollingSwapChannel.openChannel(bytes32,address,uint256)` is a different ABI, so the client's lazy `ensureChannel` reverted and the swap threw before a packet was ever sent — with no diagnostic. `tokenNetworkAddress` is required with no default (an EVM chain a `swapPair` targets refuses to boot without it) rather than silently defaulting to `channelAddress` and reintroducing the invisible failure.
