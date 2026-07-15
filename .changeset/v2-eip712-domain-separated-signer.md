---
"@toon-protocol/swap": major
---

Migrate the EVM payment-channel signer to the v2 EIP-712 domain-separated balance-proof digest (connector#324 finding #1).

`EvmPaymentChannelSigner.signBalanceProof` and `PaymentChannelSignParams` now **require** `chainId` and `verifyingContract`, folding both into the signed EIP-712 domain so a signature is valid on exactly one `(chainId, contract)` pair (fail-closed `version="2"`). This closes a cross-chain/cross-deployment claim-replay vector where one EVM signing key served every chain. Adds `signCooperativeClose` + `cooperativeCloseDigestEvmV2`, and threads a per-chain `settlementContracts` map (`SwapNodeEvmChainProvider.settlementAddress`) through `MultiChainClaimIssuer`. Solana/Mina signers are unchanged. Breaking: callers must supply the deployed `RollingSwapChannel` address per chain or EVM claim signing fails closed.
