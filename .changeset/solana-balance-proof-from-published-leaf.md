---
'@toon-protocol/swap': minor
---

The Solana balance-proof bytes now come from the published shared leaf, not a
local copy (completes swap#165 / toon#214).

swap#165 had to implement the 48-byte program message
(`channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)`) locally, in
`src/solana-balance-proof.ts`, because this package pinned
`@toon-protocol/sdk@^3.2.0` — a range that predated the canonical export. That
release has landed: `@toon-protocol/settlement-digest@1.1.0` publishes
`balanceProofMessageSolana`, re-exported by `@toon-protocol/core@3.5.0` and
`@toon-protocol/sdk@3.3.0`.

Ranges bumped accordingly (`settlement-digest ^1.0.0 → ^1.1.0`,
`sdk ^3.2.0 → ^3.3.0`, `core ^2.1.0 → ^3.5.0` — the last of which retires a
second, two-major-old copy of core from the dependency tree, since the sdk
already pulled core 3.x transitively). The Solana balance proof and the EVM
EIP-712 digest are now sourced from the SAME shared leaf, so the maker cannot
drift from the on-chain verifier or from the client's off-chain one.

`src/solana-balance-proof.ts` is deleted. What survives is
`solanaBalanceProofMessage` in `src/payment-channel-signer.ts`, next to its only
caller — an adapter that is explicitly NOT a second implementation of the layout:
it base58-decodes the `channelId` into the 32-byte PDA, refuses one that cannot
name a channel on chain, and raises `SwapWalletError`s that NAME the offending
u64 field (the shared leaf throws plain `Error`s whose text `signBalanceProof`
would bury in `cause`). The bytes themselves are the published function's.

Before the local copy was removed it was proven byte-identical to the published
one over 524 vectors (the pinned ones plus 512 pseudo-random PDA/u64 triples) and
over every one of the 64 bit positions in both u64 slots, through all three import
paths (`settlement-digest` direct, and the `core` and `sdk` re-exports), with
matching rejection behaviour for a non-32-byte PDA and for out-of-u64 values. The
pinned vectors in `src/solana-balance-proof.test.ts` — derived from connector
`processor.rs:900-910`, not from any TypeScript implementation — are kept and now
guard the published bytes, with one test added asserting the adapter delegates
rather than recomputes.
