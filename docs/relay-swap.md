# The swap is a relay-mediated client

**Status:** decided and built in this repository (swap 3.0.0, 2026-08-28). New here? Read
[How it works](./how-it-works.md) first, then the [guide](../packages/swap/README.md). Supersedes
[`rust-connector-migration.md`](./rust-connector-migration.md) (the maker as an HTTP app behind a
Rust connector), which never shipped.

## The decision

**`@toon-protocol/swap` is a swap client, not an app behind a connector.** Both parties of a swap
are plain TOON clients. Neither runs a connector, terminates a route, or is reachable by anyone.
They talk through a relay:

- An **order** is a public, addressable Nostr event (kind `30032`, `d` = the pair) the maker
  publishes: the pair, an indicative rate, the bounds on one fill, and every on-chain fact a
  taker needs to pay leg A and verify leg B. Discovery is the order.
- Everything after it — **accept**, **quote**, **fill**, **advance**, **refusal**, **done** — is
  a rumor (kind `20036`) NIP-59 gift-wrapped to the counterparty (`src/nip59.ts`). The relay
  stores the wraps; a party that goes away drains them when it comes back.
- Every write is a paid packet to the relay's own connector (`g.toon.relay`, price 1 on the
  devnet). The connector never opens a wrap (payload opacity, connector ADR 0016); it charges
  carriage and nothing else. No connector law is touched.

The wire is `rolling/3` (`packages/swap/src/wire.ts`, exported).

## A swap is a stream of micro-claims

This is the rolling swap (toon-meta ADR 0003) on a new transport. A swap of size S is ⌈S/δ⌉
**fills**; fill *i* is one wrap from the taker carrying its **cumulative** leg-A claim, answered
by one wrap from the maker carrying its cumulative leg-B claim, re-priced at the maker's current
rate. δ is small and **taker-chosen per fill** within the order's `fill: {min, max}` — the maker
prices whatever delta arrived. Exposure at any moment is one δ, never S. Claims are cumulative
and monotonic, so a party redeems **once** on chain for the whole stream.

What this transport costs: two paid relay writes and one relay round trip per fill. Measured on
the devnet (`packages/swap/scripts/bench-fills.ts`, 2026-08-28, 10 fills per δ, EVM→Solana):

| δ (µUSDC) | per fill (mean / p50) | fills/s | carriage `(2N+3)` writes | % of notional |
|---|---|---|---|---|
| 2 | 368 / 334 ms | 2.7 | 23 µUSDC | 115 % |
| 100 | 483 / 393 ms | 2.1 | 23 | 2.3 % |
| 1 000 | 356 / 350 ms | 2.8 | 23 | 0.23 % |
| 10 000 | 821 / 984 ms* | 1.2 | 23 | 0.023 % |
| 100 000 | 331 / 313 ms | 3.0 | 23 | 0.002 % |

\* a maker deposit top-up landed on that fill path — a chain transaction, not relay cost.

**The lever is δ, and it is the swap's slippage:** exposure per fill = δ; carriage = `(2 + 3/N)/δ`
(break-even at δ ≈ 2.3 µUSDC, 1 % at ≈ 230, 0.1 % at ≈ 2 300); time ≈ `S/δ × 0.37 s` (a paid BTP
write is ~70–90 ms each way; the rest is maker verify+sign and relay fan-out, flat in δ). δ = 1 is
refused (`⌊1·0.99⌋ = 0`); nothing below ~100 µUSDC makes sense; **1 000–10 000 µUSDC is the
sweet spot** — one fill of exposure at ≤ 0.23 % carriage, 1 USDC in 40 s–6 min. `toon-swap take`
prints exposure, carriage and ETA for the δ it is about to use; makers set the floor with
`order.fill.min` (keep it ≥ ~100/rate so nobody can make you sign µUSDC claims at two writes each).

## Claims and channels — unchanged

- EVM: the fleet's `TokenNetwork`/`1` EIP-712 `BalanceProof` (`TokenNetworkBalanceProofSigner`).
- Solana: the 96-byte `TOON-BALPROOF-V2` message binding the program id (connector ADR 0053).
- One ordinary channel per (party, party, chain), derived from the participants (ADR 0059). The
  taker funds its side to pay leg A (`defaultChannelFunder`); the maker funds its side on demand
  at the taker's first verified fill (`chainProviders[].channelDeposit`) and tops up.

**Each party verifies the other's claim itself** — `src/received-claim.ts`, one ladder for both
roles, over the same digests the parties sign with: shape → chain → signer bound at accept →
**signature, before any chain read** → channel id re-derived from the participants → nonce and
cumulative above my inbound watermark (seeded from the counterparty's on-chain slot, so an
already-redeemed claim is not new value) → delta within bounds → the counterparty's on-chain
deposit covers the cumulative and the channel is open. Chain reads are cached on the watermark
and budgeted per counterparty; over budget is a refusal, never a wait.

`PaymentAttribution` — "who paid, how much, on which chain" — is still the maker engine's one
input about money. On `rolling/2` a connector stated it in three headers; on `rolling/3` the
maker fills it in from its own verification. The engine did not change.

## The wire, end to end

```
maker                         relay (+ its connector)                       taker
  │ order  kind:30032 (paid write) ──▶ stored, replaced by `d` ──▶ REQ {kinds:[30032]} │
  │                                                                                  │
  │ ◀── 1059{accept: orderId, streamNonce, chainRecipient, payer} ── (paid write) ───┤
  ├── 1059{quote: rate, fill{min,max}, lastSeq, legA, legB} ───────────────────────▶ │
  │                                                                                  │
  │ ◀── 1059{fill i: claim{nonce i, cumulative Σδ}} ──────────── sign leg A, persist ─┤
  │ verify leg A, persist inbound watermark (write-ahead), engine.fill → sign leg B  │
  ├── 1059{advance i: claim{nonce, cumulative Σ⌊δ·R⌋}, targetAmount} ──▶ verify leg B │
  │                                                                                  │
  │ ◀── 1059{done} (optional)                                                        │
  │                            taker redeems the last leg-B claim on chain B once.   │
```

Refusals are messages (`type:'refusal'`, `reason`, `retry`, `credited`). A verified-but-refused
fill (stale rate, no liquidity) is **credited**: the maker holds the value and folds it into the
next accepted fill. A stranger's fill, another taker's pubkey, an unknown session or a wrap older
than the session TTL is **dropped, not refused** — a refusal is a paid write, and paying to say
no to someone who has not paid is the one way a maker can be made to bleed.

## Sessions, persistence, resume

- **Maker** (`src/swap-maker.ts`, state schema v3 in `src/state-store.ts`): sessions, inbound
  watermarks, the relay cursor and published orders persist with the inventory and channel
  watermarks. A restarted maker replays its inbox from `relayCursor − 60 s`, republishes its
  orders after EOSE, answers a retransmitted fill (same seq, same claim) with the **same** advance,
  and recovers a fill it verified but never answered as "already paid".
- **Taker** (`src/swap-taker.ts`, `src/taker-state.ts`): `lastFill` is written **before** the
  wrap is published, and the outbound watermark is shared by every session on a channel — a
  taker never signs a lower nonce than one it handed out. `resume()` re-quotes (`resume:true`;
  the quote's `lastSeq` says where the maker stands), drains the inbox from the relay's history,
  and resends the same claim for an unanswered seq. Re-quote on every resume is mandatory: a rate
  from before a pause is a free option.

## Redemption

`toon-swap redeem` — EVM `claimFromChannel` pays the taker the delta immediately; Solana
`ClaimFromChannel` records the proof (`toon-swap close` → challenge window → `toon-swap settle`
pays out). By default on the taker's own keys and gas (`src/redeem.ts`).

`toon-swap redeem --via gas-station` asks the gas station to pay instead
(`src/gas-station-redeem.ts`): kind:5096 on Solana builds `[Ed25519SigVerify, ClaimFromChannel]`
with the station as fee payer — the taker signs nothing, the claimer is a non-signer — and
kind:5098 on EVM signs an ERC-2771 `ForwardRequest` for `claimFromChannel` against the
forwarder's `eip712Domain()`. Both jobs ride the taker's relay client to `g.toon.relay.gas`.
Config: `gasStation: { destination, connectorUrl }` — the relay's `g.toon.relay.gas` route is
**forwarded** to the gas station's own connector, so jobs are sealed to that node's key (resolved
from its `GET /ilp`). **The station refuses claims today** — proven live on devnet 2026-08-28:
quote ok, execute `program_not_whitelisted — instruction 0 invokes Ed25519SigVerify…` —
its whitelist is deposit/close/settle, and close/settle carry no balance proof so they cannot
substitute. [toon-protocol/gas-station#18](https://github.com/toon-protocol/gas-station/issues/18)
asks for the entry; until then the CLI falls back to own gas (`--no-fallback` to refuse instead).

## What does not change, so nobody rebuilds it

- Exposure per fill is δ in every transport: a claim is money the moment the other side holds
  it; no hash condition takes it back. Coupling the legs would be theatre.
- An offline party must still redeem inside the channel's challenge window if the counterparty
  closes on chain. Long timeouts, check on wake; a watchtower is a later concern.
- Deniability is against third parties only: the relay's connector records which channel paid
  for each write (ADR 0040) and the swap channel is public on chain.
- Capital is per taker channel until a pooled program with per-recipient tabs exists.

## Kinds

`30032` (order, addressable) and `20036` (rumor) are provisional; re-run toon-meta
`docs/mesh-compute-job-protocol.md` §1.1's allocation checks before registering them. `20032–20034`
are retired (`rolling/1`), `20035` is the maker's internal fill-context rumor.

## Operating it

- **Maker:** `toon-swap make --config swap.config.json` — `relay.readUrl` + `relay.connectorUrl`,
  `chainProviders` for every chain a pair touches (leg A needs the maker's facts there too),
  `order.fill`, `inventory`, `channelDeposit`. `GET /health` reports the relay loop, orders and
  inbound watermarks. Without `relay.connectorUrl` the maker boots **offline** and says so.
- **Taker:** `toon-swap orders`, `toon-swap take --order <maker>:<orderId> --size <n> [--delta <n>]`,
  `toon-swap resume --stream <nonce>`, `toon-swap redeem|close|settle --stream <nonce>`,
  `toon-swap sessions`. State lives in `<statePath>.taker.json`.
- **Devnet:** relay `wss://relay-ws.devnet.toonprotocol.dev`, connector
  `https://proxy.relay.devnet.toonprotocol.dev/ilp`, Base Sepolia + Solana devnet; the faucet
  drips USDC only — native gas comes from elsewhere.
