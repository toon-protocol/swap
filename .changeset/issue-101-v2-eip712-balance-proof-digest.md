---
---

The swap node now signs the v2 EIP-712 domain-separated balance-proof digest (via `@toon-protocol/settlement-digest`) instead of the v1 raw-packed digest, so claims recover correctly against the v2 verifiers across the ecosystem (client, sdk, connector and the on-chain `RollingSwapChannel`). Verifiers still on the v1 raw-packed digest — including the `@toon-protocol/sdk` 2.x pinned here — will NOT recover these claims; those repos migrate separately. `SwapNodeEvmChainProvider` gains a required `channelAddress` field (the deployed `RollingSwapChannel` address); a swap pair targeting an EVM chain with no matching `chainProviders` entry now refuses to boot instead of issuing unverifiable claims.
