---
---

The swap node now signs the v2 EIP-712 domain-separated balance-proof digest (via `@toon-protocol/settlement-digest`) instead of the v1 raw-packed digest, so claims recover correctly against the client, sdk, connector and on-chain `RollingSwapChannel` verifiers. `SwapNodeEvmChainProvider` gains a required `channelAddress` field (the deployed `RollingSwapChannel` address); a swap pair targeting an EVM chain with no matching `chainProviders` entry now refuses to boot instead of issuing unverifiable claims.
