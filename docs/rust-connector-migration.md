# The maker is an app behind a Rust connector

**Status:** decided and built in this repository (swap 3.0.0). Written because
nothing upstream records a target shape for the maker on the Rust fleet:
toon-meta's [ADR 0003](https://github.com/toon-protocol/toon-meta/blob/main/docs/adr/0003-the-rolling-swap-is-the-only-swap.md)
and `docs/rolling-swap.md` describe a TypeScript maker with an embedded
`ConnectorNode`, and connector [ADR 0017](https://github.com/toon-protocol/connector/blob/main/docs/adr/0017-the-typescript-connector-is-a-prototype.md)
retired that `ConnectorNode` ("every existing client is rewritten … `swap` … is
not optional") without saying what the maker becomes. This document says.

## The decision

**`@toon-protocol/swap` no longer embeds, dials or configures a connector.** The
maker is a plain HTTP app that a Rust connector terminates two routes at:

```toml
# the maker operator's connector.toml
[[routes]]
prefix      = "g.toon.swap.maker.rfq"          # free: ask for a quote
handler_url = "http://swap-node:8080/swap/rfq"
price       = 0

[[routes]]
prefix      = "g.toon.swap.maker"              # priced: one fill = one packet
handler_url = "http://swap-node:8080/swap/fill"
price       = 1000000                          # δ, in the settlement asset's base units

[settlement.evm]    # … the chain(s) the maker accepts leg A on
[settlement.solana] # … both may be live at once
#   ONE KEY: these settlement keys are the maker's own index-2 keys, so the
#   channel a taker pays leg A into is the channel the maker pays leg B from.
```

- **Leg A** is an ordinary paid packet to the fill route. The taker's claim
  travels with it (connector ADR 0042); the connector verifies it against the
  chain, advances the channel watermark, and delivers the request to
  `/swap/fill` with `X-TOON-Payer` / `X-TOON-Amount` / `X-TOON-Chain`
  (ADR 0040). The maker reads three headers and never sees a packet, a claim
  or a key that is not its own.
- **Leg B** is the maker's signed, cumulative balance proof on the target chain,
  returned in the HTTP response body. The connector seals it into the FULFILL
  and derives the fulfilment itself (ADR 0019). The taker verifies the claim
  before sending the next fill and redeems the last one on chain whenever it
  likes.

The two exchanges are the `rolling/2` wire, defined in
[`packages/swap/src/wire.ts`](../packages/swap/src/wire.ts) and exported from
the package for takers to import.

## Why the coupled legs could not survive

`rolling/1` coupled each fill's two legs under one sender-minted condition: the
maker originated a leg-B PREPARE back at the sender under the same `C_i`, and
could only FULFILL leg A by relaying the preimage the sender revealed. Every
piece of that rests on the retired TypeScript connector, and the Rust
connector rules each of them out — not incidentally, but as law:

| rolling/1 needed | Rust connector says |
| --- | --- |
| a zero-condition gift-wrapped RFQ on the local-delivery seam | **PF-01**: a packet MUST carry a real condition; there is no zero-condition path |
| the maker to hold the leg-A preimage and withhold the FULFILL | **ADR 0019 / PF-22**: a terminating connector *derives* the fulfilment from the sealed secret; the app supplies nothing |
| the maker to originate a conditioned leg-B PREPARE to the sender | the embedded node's `sendPacket`/`POST /admin/ilp/send` are gone; `POST /packets` is an *operator* act, and a client destination is delivered **unpaid** |
| a parent/child peer relation for the leg-B return route | none exists (`docs/operators/swap-node-bringup.md`) |

What replaces the coupling is the connector's own money model: **a packet
carries its claim, and exposure is bounded by sizing packets** (ADR 0042,
`CONTEXT.md` › *Path*). The taker's worst case is one fill it paid for and did
not get a claim for — exactly the `δ·W` (W = 1) residual exposure rolling/1's
own §3.1 already accepted, since a leg-A claim attached at forward time there
too. The maker's worst case is nothing: it is paid before it is asked.

Nothing about the *chain* side changed. `MultiChainClaimIssuer`,
`SwapInventory`, `SwapChannelState`, the reservation → commit accounting, the
v2 EIP-712 `RollingSwapChannel` digest, the chain-truth reconciler and the
persisted state are the same code the deployed maker ran.

## The wire, end to end

```
taker                     maker's Rust connector                  maker app
  │  POST /ilp  PREPARE(g.toon.swap.maker.rfq, amount 0)              │
  │  sealed envelope: POST / {proto:"rolling/2",type:"rfq",…}         │
  ├────────────────────────────▶│ route: price 0 → no claim needed    │
  │                             ├── HTTP POST /swap/rfq ─────────────▶│
  │                             │◀─ 200 {type:"quote", rate, fill:{…},│
  │                             │        legB:{signer, contract|program}}
  │◀── FULFILL (sealed quote) ──┤                                     │
  │                                                                   │
  │  POST /ilp  PREPARE(g.toon.swap.maker, amount δ)                  │
  │  ILP-Payment-Channel-Claim: {nonce i, cumulative i·δ}  (leg A)    │
  │  sealed envelope: POST / {type:"fill", streamNonce, seq: i}       │
  ├────────────────────────────▶│ verify claim vs chain, watermark++  │
  │                             ├── POST /swap/fill ─────────────────▶│
  │                             │   X-TOON-Payer: evm:0x… | solana:…  │ reserve, sign
  │                             │   X-TOON-Amount: δ  X-TOON-Chain    │ leg-B claim,
  │                             │◀─ 200 {type:"advance", claim,        │ commit
  │                             │        cumulativeAmount: Σ⌊δ·R⌋, …} │
  │◀── FULFILL (sealed advance) ┤                                     │
  │  verify leg-B claim (R5) → next seq, or stop                      │
  │                                                                   │
  │  redeem last claim on chain B:                                    │
  │    EVM    RollingSwapChannel.updateBalance(channelId, Σ, nonce, recipient, sig)
  │    Solana ClaimFromChannel (ed25519 ix at 0) → CloseChannel → SettleChannel
```

Refusals are HTTP statuses **inside** the sealed response, never ILP rejects
(PF-23 — an app's answer rides home on a FULFILL whatever its status). A
refused-but-paid fill is remembered as `credited` on the session and folded
into the next accepted fill's `sourceAmount`. Replays of the last `seq` return
the same advance (the connector treats a byte-identical claim as idempotent, so
the taker was not charged twice).

### Session binding

A quote opens a session keyed by `streamNonce`. The first paid fill binds the
session to the connector-stated leg-A channel key (`X-TOON-Payer`); a
different payer on the same session is refused `payer_mismatch` and not
credited. Fills are strictly sequential per session (`seq_gap` otherwise).

### Leg-B channels: the normal ones, one per taker, opened on demand

Leg B rides the **same kind of channel leg A does** — the fleet's `TokenNetwork`
on EVM, the `payment_channel` program on Solana — never a swap-specific
contract. A channel there has two declared participants, a deposit per
participant, and a nonce/cumulative watermark **per participant**:

- a later claim from the maker can only pay the taker *more*; the maker cannot
  retroactively void a claim it signed;
- the taker's collateral is its own and readable on chain
  (`participants(channelId, maker).deposit`, the maker's slot of the PDA), and
  `claimFromChannel` / `ClaimFromChannel` refuse a claim the deposit cannot cover;
- redemption is incremental (`claimFromChannel` pays the delta and leaves the
  channel open; Solana records the claim and pays at settlement).

**One key.** The maker's connector settles with the maker's own index-2 keys.
On each chain there is therefore exactly one channel between a taker and the
maker — derived from the pair (`keccak256(min, max, epoch)` on EVM, the
`["channel", min, max, mint]` PDA on Solana, ADR 0059). The taker opens it to
pay leg A; at the taker's first *paid* fill the maker deposits its own side
(`chainProviders[].channelDeposit`, from its index-2 key's balance) and tops it
up whenever a claim would exceed what it holds (`evm-leg-b-channel.ts`,
`solana-leg-b-channel.ts`). Nothing is pre-opened for leg B, and an RFQ cannot
make the maker lock capital: provisioning happens after payment. A channel the
maker has already been redeemed on seeds the maker's watermark from chain, so a
restart with lost state cannot sign a claim below the on-chain nonce.

**Why not `RollingSwapChannel`.** The 2.x leg-B contract kept one
nonce/cumulative watermark **per channel** and let the signer name any
`recipient` per claim. That let a maker sign nonce 4 to another address (or
itself) and redeem it, voiding a taker's nonce-3 claim — a claim the taker could
not have known was at risk, since other recipients' claims are off chain. The
"exposure is one fill" property therefore held only against a maker that kept
its own binding discipline. The normal channel's per-participant watermark
gives the property by construction, so the maker no longer signs on
`RollingSwapChannel` at all (`chainProviders[].channelAddress` is accepted and
ignored). The capital-efficiency argument for a pooled contract is real but
belongs to a future program with per-recipient tabs *and* reserved collateral;
see toon-protocol/connector#1247's thread.

Claims sign the chain's standard message: the EIP-712 `TokenNetwork`/`1`
`BalanceProof` on EVM (`TokenNetworkBalanceProofSigner`) and the 96-byte
`TOON-BALPROOF-V2` message binding the program id on Solana (ADR 0053). A taker
verifies leg B with the very code it uses to *pay* leg A.

## What changed in this package

| Area | 2.x | 3.0.0 |
| --- | --- | --- |
| dependency | `@toon-protocol/connector ^3.30.0` (embedded `ConnectorNode`) | none |
| intake | kind:1059 gift wrap on a BTP listener; RFQ kind:20033 | `POST /swap/rfq`, `POST /swap/fill` (JSON) |
| leg B | maker-originated coupled PREPARE (`rolling/1`) | claim in the paid response (`rolling/2`) |
| leg-B contract | `RollingSwapChannel` (recipient per claim, one watermark per channel) | the normal `TokenNetwork` / Solana program channel between maker and taker, opened and funded by the maker on demand |
| discovery | kind:10032 announce (retired upstream, ADR 0046) | the connector's self-description + the quote |
| config | `btpServerPort`, `btpEndpoint`, `relayUrls`, `connectorUrl`, `peerInfo*`, `rolling.*`, `settlementPrivateKey`, `chainProviders[].channelAddress` | **accepted and ignored with a warning** — a 2.x config boots; new: `ilpAddress` (existing), `fillAmount`, `quote.*`, `appPort` (alias `blsPort`), `chainProviders[].channelDeposit` (+ `settlementTimeoutSeconds` / `challengeDurationSeconds`); EVM entries need `tokenNetworkAddress`, Solana entries `programId` + `tokenMint`; `channels` may be empty when `channelDeposit` is set |
| Solana proof | 48 bytes | 96 bytes, program-bound |
| inventory | persisted snapshot always won over config (swap#130) | a configured `total` *above* the snapshot raises the pool (new capital); below is left alone |
| `/health` | — | `+ ilpAddress, rfqDestination, fillDestination, legB, sessions` |

## Operating it

1. Run a Rust connector whose `[settlement.evm.key]` / `[settlement.solana.key]`
   are the maker's **index-2 keys** (`toon-swap` prints them at boot), with
   `[settlement.*]` for every chain the maker trades on, and the two `[[routes]]`
   above. The route price is the fill size; set the maker's `fillAmount` to the
   same figure (the maker uses `X-TOON-Amount` as the truth either way).
2. Point the maker's `chainProviders` at the same chains: EVM
   `tokenNetworkAddress` (the fleet's `TokenNetwork`) + `channelDeposit`, Solana
   `programId` + `tokenMint` + `channelDeposit`.
3. Fund the index-2 keys: gas on each chain, and the token the maker pays leg B
   in (an SPL ATA on Solana). Every taker's first fill draws `channelDeposit`
   from that balance; top-ups draw more. `inventory` is the ceiling the maker is
   willing to issue against — keep it at or below what the keys hold.
4. `GET /health` names the two ILP destinations to hand takers; the connector's
   `GET /ilp` names the sealing key and the settlement facts takers open leg-A
   channels against — which are now also the leg-B facts.

The deployed devnet maker (`connector/infra/linode-relay/`) still runs the 2.x
sidecar with its own dead connector. Moving it means a maker-side Rust
connector on the relay box settling with the maker's keys —
toon-protocol/connector#1247.

## What is still open

- **Refunds.** A refused-but-paid fill is credited, not refunded; if the maker
  never accepts another fill on that session the credit is stranded. The RFQ
  states `maxAmount` so a taker can avoid the common case (over-running
  liquidity), and a rate-staleness refusal is the only other benign path.
- **Capital is per taker.** Each taker's channel holds `channelDeposit` (plus
  top-ups) of the maker's capital until that channel settles; the maker's
  wallet is the pool. A pooled contract with per-recipient tabs *and* reserved
  collateral would recover the efficiency without reintroducing the
  `RollingSwapChannel` weakness — a future program, on both chains.
- **The connector must redeem leg A before a channel it shares settles.** With
  one channel per pair, a taker closing the Solana channel to cash out leg B
  also starts the challenge window on the leg-A claims the maker's connector
  holds; redeeming those within the window is the connector's job
  (`POST /channels/:id/redeem-latest`).
- **Discovery.** ADR 0046 removed the announce and named no replacement. A taker
  is handed the maker's connector URL out of band today.
- **toon-client** still speaks `rolling/1`; `packages/swap/tests/e2e/helpers`
  is the reference taker until the daemon is ported.
- **Mina** cannot be a leg-A chain (the Rust connector dropped it, ADR 0002);
  it remains a leg-B target only.
