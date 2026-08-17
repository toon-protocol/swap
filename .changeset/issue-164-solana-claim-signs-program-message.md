---
'@toon-protocol/swap': minor
---

The maker's Solana balance proofs are now REDEEMABLE (swap#164, toon#214).

`SolanaPaymentChannelSigner` signed `balanceProofHashSolana` —
`sha256(utf8(channelId) || cumulativeAmount(32BE) || nonce(32BE) || utf8(recipient))`
— which **no deployed TOON program has ever verified**. Connector's native
`packages/solana-program` verifies an Ed25519 signature over the RAW 48 bytes
`channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)`, compared
byte-for-byte through the Ed25519 precompile (`processor.rs:900-910`). Every
Solana claim this package has ever issued was therefore unredeemable, and nothing
noticed because nothing verifies a Solana claim's signature: both Solana E2E
suites pass `verifySignatures: false`, and the rolling driver checks the claim
bytes' length and never their content.

The signer now signs that 48-byte message, via a new local
`balanceProofMessageSolana` (`src/solana-balance-proof.ts`). The helper is local
only because this package pins the published `@toon-protocol/sdk@^3.2.0`, which
predates the canonical `balanceProofMessageSolana` export added in toon#214; its
header and pinned byte vectors exist so swapping it for the shared one on the next
sdk bump is provably byte-identical.

**Behaviour change worth knowing:** a Solana `channelId` IS its channel PDA, so the
signer now REFUSES a `channelId` that is not 32 base58 bytes rather than signing a
proof no chain could resolve. Synthetic Solana channel ids in callers' tests must
become real PDAs.

The Solana E2E suites keep `verifySignatures: false` and still do not broadcast:
the fix to the settlement BUILDER is upstream in toon#214 and unreleased, so the
sdk pinned here would both build an unexecutable transaction and verify against the
digest the maker no longer signs. Their stale docblocks and README claims — one of
which asserted the suite "submits the accumulated claim via raw Solana JSON-RPC and
asserts an on-chain effect", which it has never done — are corrected in the same
change.
