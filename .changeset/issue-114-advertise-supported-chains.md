---
---

The swap node's kind:10032 peer-info now advertises `supportedChains` (every chain a swap pair targets) and `preferredTokens[chain]` (the settlement-token address/mint/id, from the same `chainProviders` entry each chain's signer/`tokenNetworks` entry already reads). Without `supportedChains`, a stock client's apex onboarding hard-refuses the maker (`addApex`: "announced no supportedChains — cannot settle") — found during the toon-meta#394 T6 devnet proof (swap#105).
