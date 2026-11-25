---
'@toon-protocol/swap': minor
---

swap owns its claim digests and signer recovery (`claim-digest.ts`) and no longer depends on `@toon-protocol/settlement-digest`. Exports that said "balance proof" are renamed after claims (`TokenNetworkClaimSigner`, `tokenNetworkClaimDigest`, `solanaClaimMessage`, `TOKEN_NETWORK_CLAIM_TYPES`, `SOLANA_CLAIM_DOMAIN_TAG`, `SOLANA_CLAIM_MESSAGE_SIZE`); the old names remain as deprecated aliases for one release. The signed bytes are unchanged.
