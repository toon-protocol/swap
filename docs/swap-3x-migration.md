# `@toon-protocol/swap` 2.1.0 → 3.0.0 migration

**Status:** written ahead of the 3.0.0 cut, from the `major` changesets queued on `main`
(`issue-101`, `issue-133`, `issue-136`, `issue-164`, `rust-connector-maker`). **Read this before
upgrading a running maker, and before pointing a released client at a 3.0.0 maker.**

> **§0 supersedes much of what follows.** The maker no longer embeds a connector at all: it is an
> HTTP app behind a Rust connector's route termination, speaking the `rolling/2` wire. See
> [`rust-connector-migration.md`](./rust-connector-migration.md) for the decision and the wire.
> The sections below still describe real 2.x → 3.0.0 breaks on the chain side (§1, §3) and the
> announce (§2) — but there is no announce any more, and a released `toon-client` does not speak
> `rolling/2` yet.

## 0. The maker is an app behind a Rust connector

- `@toon-protocol/connector` is no longer a dependency; `ConnectorNode`, the BTP listener, the
  kind:1059/kind:20033 intake and the kind:10032 publish are gone.
- Leg A is verified by the **connector in front of the maker**, from its own `[settlement.*]`;
  the maker reads `X-TOON-Payer` / `X-TOON-Amount` / `X-TOON-Chain`. Leg B rides in the paid
  response. Refusals are HTTP statuses inside the sealed FULFILL.
- Config keys that configured the embedded connector or the announce (`btpServerPort`,
  `btpEndpoint`, `relayUrls`, `connectorUrl`, `parent*`, `nodeId`, `peerInfo*`, `rolling.*`,
  `settlementPrivateKey`, `knownPeers`, `transport`, `advertisedAsset`) are **accepted and ignored
  with a boot warning**, so the fleet's committed 2.x config still boots. New: `fillAmount`,
  `quote.{ttlMs,sessionTtlMs,maxSessions}`, `appPort` (alias of `blsPort`), and Solana
  `chainProviders[]` now require `programId` **and** `tokenMint`.
- The Solana balance proof is the 96-byte `TOON-BALPROOF-V2` message (connector ADR 0053), not
  the 48 bytes §3 below describes — §3's Solana paragraph is itself superseded.
- A configured inventory `total` above the persisted snapshot now raises the pool (swap#130).


This is a genuine major on four independent axes. A config that boots today stops booting; claims
are signed over different bytes on both chain families; an announce field keeps its name and
changes its meaning; and refusals move to different ILP error classes. Nothing here is a rename.

## Who is affected

| You are | Affected |
|---|---|
| An operator running a `toon-swap` maker | **Yes** — §1 blocks boot, §2 changes what you advertise |
| A client that opens a payment channel to a maker | **Yes** — §2, and §3 if you verify claims |
| A counterparty that redeems maker claims on chain | **Yes** — §3, EVM *and* Solana |
| Anything that reacts programmatically to a swap refusal | **Yes** — §4 |
| A client on `@toon-protocol/client@0.29.8` or earlier | **Yes, silently** — see §5 |

---

## 1. `chainProviders` gains two required fields — a working config stops booting

Two per-chain addresses that were previously absent (or conflated) are now **required with no
default**, and an EVM chain that a `swapPairs` entry targets refuses to boot without them:

| Field | What it is | Introduced by |
|---|---|---|
| `chainProviders[].channelAddress` | The deployed `RollingSwapChannel` — the EIP-712 `verifyingContract` **leg B** claims are signed under | `issue-101` |
| `chainProviders[].tokenNetworkAddress` | The deployed `TokenNetwork` a client opens its **leg A** payment channel on | `issue-133` |

Neither defaults to the other on purpose. `tokenNetworkAddress` silently defaulting to
`channelAddress` is precisely the bug §2 describes, and issuing claims against a missing
`channelAddress` produced unverifiable claims — so both fail closed at boot instead.

**Symptom if you skip this:** the node exits at start-up naming the chain and the missing field.
That is the intended behaviour, but note the deployment hazard: `swap:release` is auto-on-green
and the relay box's Watchtower recreates `swap-node` within ~60 s, so **place the config before
the image moves**, or the live maker crash-loops (this is how swap#134 took the maker down).

```diff
 "chainProviders": [
   {
     "chain": "evm:84532",
     "rpcUrl": "…",
+    "tokenNetworkAddress": "0x…",   // leg A — clients open channels here
+    "channelAddress": "0x…",        // leg B — RollingSwapChannel, EIP-712 verifyingContract
   }
 ]
```

---

## 2. `tokenNetworks` in the kind:10032 announce changed meaning

**The field kept its name and changed what it points at.** This is the break most likely to be
missed by reading a diff.

| Announce key | 2.x | 3.0.0 |
|---|---|---|
| `tokenNetworks[chain]` | the maker's `RollingSwapChannel` (leg B) | the **`TokenNetwork`** a client opens leg A on |
| `swapVerifyingContracts[chain]` | — (new) | the maker's `RollingSwapChannel` (leg B), the EIP-712 `verifyingContract` |

`tokenNetworks` is the field a stock client reads to open its payment channel. In 2.x it carried
the `RollingSwapChannel`, whose ABI is `openChannel(bytes32,address,uint256)` — a different
signature from the `TokenNetwork`'s `openChannel(address,uint256)` — so the client's lazy
`ensureChannel` reverted and the swap threw before a single packet went out, with no diagnostic.
That is why this is a major and not a fix: correct 2.x-era *reader* code is now reading the wrong
contract's address out of that key.

**Action:** a client that reconstructs the EIP-712 domain must read `swapVerifyingContracts`, not
`tokenNetworks`. A client that opens leg A must read `tokenNetworks` — and that is now the value
it always should have had.

---

## 3. Claims are signed over different bytes — on both chain families

A 2.x claim and a 3.0.0 claim are not interchangeable. Verifiers must move.

**EVM (`issue-101`).** The node now signs the **v2 EIP-712 domain-separated** balance-proof digest
via `@toon-protocol/settlement-digest`, replacing the v1 raw-packed digest. Claims recover
correctly against the v2 verifiers across client, sdk, connector and the on-chain
`RollingSwapChannel`. **Any verifier still on the v1 raw-packed digest will not recover these
claims** — including the `@toon-protocol/sdk` 2.x pinned by 2.x builds. Those repos migrate
separately.

**Solana (`issue-164`).** The 2.x signer signed `balanceProofHashSolana`
(`sha256(utf8(channelId) || cumulativeAmount(32BE) || nonce(32BE) || utf8(recipient))`), which
**no deployed TOON program has ever verified** — so every Solana claim this package ever issued
was unredeemable. Nothing caught it because nothing verifies a Solana claim's signature: both
Solana E2E suites run `verifySignatures: false` and the rolling driver only checks claim-byte
length. 3.0.0 signs the raw 48 bytes the connector's `solana-program` actually verifies through
the Ed25519 precompile:

```
channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)
```

**Consequent behaviour change:** a Solana `channelId` *is* its channel PDA, so the signer now
**refuses** a `channelId` that is not 32 base58 bytes rather than signing a proof no chain could
resolve. **Synthetic Solana channel ids in your tests must become real PDAs.**

---

## 4. Refusals moved off the blanket `T00` — a retrying counterparty now gives up

2.x collapsed everything except `INSUFFICIENT_INVENTORY` into `ctx.reject('T00', 'Internal
error')`. `T00` is **transient**, so a released counterparty retries it. 3.0.0 classifies the
refusal, and two of those classes are **permanent**:

| Condition | 2.x | 3.0.0 | Class change |
|---|---|---|---|
| Maker's channel has unredeemed units | `T00` | **`T04`** `insufficient_funds` / `channel_unredeemed` | still transient, now actionable |
| No channel provisioned for the sender | `T00` | **`F99`** `application_error` / `no_channel_available` | **transient → permanent** |
| Malformed/checksummed chain-recipient (via sdk 3.1.8) | `T00` | **`F01`** | **transient → permanent** |
| Persist / signing / encrypt failure | `T00` | stays T-class, but named | — |

Every refusal now carries base64-JSON reject `data` whose **`reason`** field is the machine
discriminator (matching the `stale_rate` and rolling-engine reject contracts). The rolling
coupled-leg path had the same silent-`T00` collapse and gets the same treatment.

**This is the axis most likely to surprise a third party:** a counterparty that used to retry its
way through a transient blip will now stop on the first refusal. That is correct — those
conditions were never going to clear by retrying — but it is a visible behaviour change in
someone else's process, not just ours.

---

## 5. The residual risk this document exists to mitigate

Maker-side telemetry cannot see third parties still running
`@toon-protocol/client@0.29.8` or earlier. They will not appear in the maker's intake ledger
until they send, and by then they will already have hit §2 or §4. **This note is the whole
mitigation** — see ADR 0003 (`toon-meta/docs/adr/0003-the-rolling-swap-is-the-only-swap.md`),
which states the same gap honestly for the legacy-path removal.

## Upgrade order

1. **Place the config first** — add `tokenNetworkAddress` and `channelAddress` for every EVM chain
   a `swapPairs` entry targets (§1). Do this before the image moves; Watchtower gives you ~60 s.
2. **Move the image**, and confirm the maker booted rather than crash-looped.
3. **Check the announce** — `tokenNetworks` should now be the `TokenNetwork` and
   `swapVerifyingContracts` the `RollingSwapChannel` (§2).
4. **Verify a live swap end to end** and settle the claim on chain — this is what proves §3 on the
   chain family you actually run. Leaving a claim unredeemed jams the maker (§4's `T04`).
5. **Then** update counterparties' verifiers and any code branching on refusal codes (§3, §4).
