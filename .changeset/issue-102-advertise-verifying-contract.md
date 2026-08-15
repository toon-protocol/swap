---
---

The swap node's kind:10032 peer-info now advertises `tokenNetworks[chain]` (the deployed `RollingSwapChannel` address, the EIP-712 `verifyingContract`) and `settlementAddresses[chain]` (the swap node's own payout address) for every chain a swap pair targets. Without this, a stock client that receives a v2-signed leg-B claim (#101) has no way to reconstruct the EIP-712 domain and rejects it with `MISSING_CHAIN_CONFIG`. Both maps are derived from the same per-chain walk that constructs the EVM signers, so the advertised chain key and contract address can never drift from the ones a claim is actually signed under.
