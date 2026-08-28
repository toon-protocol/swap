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

### Leg-B channels

- **EVM**: the operator pre-opens channels on the `RollingSwapChannel`
  (`openChannel(channelId, signer, deposit)`); the maker binds one per payer
  ("first unbound" policy, chain-truth rebind when fully redeemed).
- **Solana**: the channel between the maker and a recipient is the ONE PDA
  `find_program_address(["channel", min, max, mint], program)` (ADR 0059).
  The maker derives it from the RFQ's `chainRecipient` and serves that channel
  or refuses `no_channel_available` naming the PDA to open and fund.
- Claims sign the **96-byte** `TOON-BALPROOF-V2` message binding the program
  id (ADR 0053). Every 48-byte claim swap 2.x issued is unredeemable on the
  current program — this alone makes 3.0.0 a major on Solana.

## What changed in this package

| Area | 2.x | 3.0.0 |
| --- | --- | --- |
| dependency | `@toon-protocol/connector ^3.30.0` (embedded `ConnectorNode`) | none |
| intake | kind:1059 gift wrap on a BTP listener; RFQ kind:20033 | `POST /swap/rfq`, `POST /swap/fill` (JSON) |
| leg B | maker-originated coupled PREPARE (`rolling/1`) | claim in the paid response (`rolling/2`) |
| discovery | kind:10032 announce (retired upstream, ADR 0046) | the connector's self-description + the quote |
| config | `btpServerPort`, `btpEndpoint`, `relayUrls`, `connectorUrl`, `peerInfo*`, `rolling.*`, `settlementPrivateKey` | **accepted and ignored with a warning** — a 2.x config boots; new: `ilpAddress` (existing), `fillAmount`, `quote.*`, `appPort` (alias `blsPort`); Solana `chainProviders` need `programId` + `tokenMint` |
| Solana proof | 48 bytes | 96 bytes, program-bound |
| inventory | persisted snapshot always won over config (swap#130) | a configured `total` *above* the snapshot raises the pool (new capital); below is left alone |
| `/health` | — | `+ ilpAddress, rfqDestination, fillDestination, legB, sessions` |

## Operating it

1. Run a Rust connector with `[settlement.*]` for every chain the maker accepts
   leg A on, and the two `[[routes]]` above. The route price is the fill size;
   set the maker's `fillAmount` to the same figure so quotes can say it (the
   maker uses `X-TOON-Amount` as the truth either way).
2. Point the maker's `chainProviders` at the chains it pays leg B on:
   EVM `channelAddress` (the `RollingSwapChannel`), Solana `programId` + `tokenMint`.
3. Open and fund leg-B channels: EVM from the maker's index-2 key; Solana one
   PDA per recipient (the maker's index-2 Solana key is the depositor).
4. Fund the connector's settlement keys with gas.
5. `GET /health` names the two ILP destinations to hand takers; the connector's
   `GET /ilp` names the sealing key and the settlement facts takers open leg-A
   channels against.

The deployed devnet maker (`connector/infra/linode-relay/`) still runs the 2.x
sidecar with its own dead connector. Moving it means a maker-side Rust
connector on the relay box (compose + toml + nginx) — tracked in
toon-protocol/connector, see the PR that landed this document.

## What is still open

- **Refunds.** A refused-but-paid fill is credited, not refunded; if the maker
  never accepts another fill on that session the credit is stranded. The RFQ
  states `maxAmount` so a taker can avoid the common case (over-running
  liquidity), and a rate-staleness refusal is the only other benign path.
- **Solana leg-B channels are pre-provisioned**, one PDA per recipient. Opening
  them on demand needs the maker to submit `InitializeChannel` + `Deposit`
  itself (or ask its connector's operator surface to); not built.
- **Discovery.** ADR 0046 removed the announce and named no replacement. A taker
  is handed the maker's connector URL out of band today.
- **toon-client** still speaks `rolling/1`; `packages/swap/tests/e2e/helpers`
  is the reference taker until the daemon is ported.
- **Mina** cannot be a leg-A chain (the Rust connector dropped it, ADR 0002);
  it remains a leg-B target only.
