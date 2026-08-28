# How a swap works, and the one number you turn

Two people trade USDC across two chains without a server between them. They pass signed
claims through a mailbox, one small step at a time. This page shows the steps, and the one
number you turn: **δ**, the size of one fill.

> An interactive version of this page, with a slider for δ:
> <https://claude.ai/code/artifact/c89ba851-e4d7-40cf-ada1-90299577b7e0>

## The cast

| Who | Role | What they hold |
| --- | --- | --- |
| **Taker** | Wants to swap. Reads orders, picks one, and sends the first claim in every step. | USDC on chain A |
| **Maker** | Offers a price. Publishes an order. Answers each claim it receives with a claim of its own. | USDC on chain B |
| **Relay** | A mailbox. Stores messages. Never opens them. Each write costs 1 µUSDC, paid by whoever writes. | — |
| **Chain A · Chain B** | One payment channel each, between the two parties. A claim is a signed IOU against that channel. | the deposits |

Nobody runs a server. The maker and the taker are both ordinary clients. Either one can close
the laptop and come back later.

## The sequence

One swap of three fills. Every message after the order is sealed, so only the two parties can
read it. The relay stores each message and charges 1 µUSDC to write it. The chains are touched
only at the end.

```mermaid
sequenceDiagram
    participant T as Taker
    participant R as Relay (mailbox)
    participant M as Maker
    M->>R: 1 · order (public): pair, price, fill size min–max
    Note over R: stored; the taker reads it here
    T->>M: 2 · accept (sealed to the maker)
    M->>T: 3 · quote: live price, fill bounds, chain facts
    loop for fills 1, 2, 3 … (each fill is δ)
        T->>M: 4 · fill i: the taker's claim on chain A, total so far = i × δ
        Note over M: maker checks the claim itself
        M->>T: 5 · advance i: the maker's claim on chain B, total so far = i × δ × price
        Note over T: taker checks the claim itself
    end
    T->>M: 6 · done
    Note over T: 7 · redeem once, on chain B, with the newest advance
```

1. **Maker** publishes an **order**. It is public. It says: which pair, what price, and how
   small or large one fill may be.
2. **Taker** sends an **accept**. It names the order and the taker's addresses on both chains.
3. **Maker** answers with a **quote**: the live price and the facts the taker needs to check
   every later claim.
4. **Taker** sends **fill 1**: a signed claim on chain A for δ. The maker checks the signature,
   the channel, and the deposit behind it before it counts.
5. **Maker** answers with **advance 1**: a signed claim on chain B for δ × price. The taker
   checks it the same way.
6. Fill 2, advance 2, fill 3, advance 3 … Each claim is a **running total**, not a new amount.
   The newest claim replaces the last. Only the newest one matters.
7. When the total is reached, the taker sends **done** and takes its newest claim to chain B.
   One transaction. The maker does the same on chain A whenever it likes.

## What if someone stops?

| Case | What happens |
| --- | --- |
| **The maker goes silent** | The taker moves first in every fill. So the most it can have paid for and not received is one fill: **δ**. Never more. |
| **Someone goes offline** | The relay keeps every message. Either party can come back later, read what it missed, and continue from the last fill. |
| **An answer is lost** | The taker re-sends the same fill. The maker recognises it and returns the same advance. Nothing is paid twice. |
| **A state file is lost** | The taker's next claim is too low. The maker refuses it and says where the total stands. The taker adopts that and continues. |

## The lever: δ

δ is the size of one fill. It is the only number the taker turns. It sets three things at
once, and you cannot move one without the others.

For a swap of total size **S**, with **N = ⌈S / δ⌉** fills:

| | Formula | Why |
| --- | --- | --- |
| **Exposure** | δ | The most you can lose if the maker stops: one fill. |
| **Relay cost** | (2N + 3) µUSDC, i.e. ≈ (2 + 3/N) / δ of S | 2 writes per fill (fill, advance) + 3 per swap (accept, quote, done), 1 µUSDC each. |
| **Time** | ≈ N × 0.37 s | One fill takes about 0.35 s on the devnet, whatever δ is. |

**Small δ: safe, expensive, slow. Large δ: risky, cheap, fast.**

That is the swap's slippage. The taker picks it per swap with `toon-swap take --delta`. The
maker sets the floor in its order with `order.fill.min`, so nobody can make it sign thousands
of near-zero claims at two writes each.

### Measured on the TOON devnet

10 fills per δ, price 0.99, Base Sepolia → Solana devnet, through the live relay.

| δ (µUSDC) | per fill | fills / s | relay cost | cost as % of swap |
| --- | --- | --- | --- | --- |
| 2 | ~350 ms | 2.7 | 23 µUSDC | 115 % |
| 100 | ~400 ms | 2.1 | 23 µUSDC | 2.3 % |
| 1 000 | ~350 ms | 2.8 | 23 µUSDC | 0.23 % |
| 10 000 | ~350 ms | 2.5 | 23 µUSDC | 0.023 % |
| 100 000 | ~330 ms | 3.0 | 23 µUSDC | 0.002 % |

Speed does not change with δ. Only the count of fills changes. δ = 1 is refused: at price
0.99 it rounds to zero. Below about 100 µUSDC the relay cost is larger than the fill is worth.
**The sweet spot is 1 000 – 10 000 µUSDC** (0.001 – 0.01 USDC): one fill of exposure you can
afford to lose, under 0.25 % relay cost, and a 1 USDC swap in 40 seconds to 6 minutes.

## What δ does not change

Every claim is checked by the other party before it counts, at any δ. Only the newest claim is
redeemed on chain, once, for the whole swap. δ sets only how much value is in flight between
one fill and the next.

---

Under the hood: each sealed message is a NIP-59 gift wrap on a Nostr relay, and each write is
paid over TOON's connector. The design record is [`relay-swap.md`](./relay-swap.md); the
user guide is the [package README](../packages/swap/README.md).
