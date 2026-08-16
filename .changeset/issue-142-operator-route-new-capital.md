---
'@toon-protocol/swap': minor
---

Operator route for genuinely new capital: `POST /admin/inventory/deposit`.

#140's `/admin/inventory/credit` applies only what an on-chain **redemption**
corroborates, which is right for recycling and leaves an operator who actually
**adds** capital — funds a new channel, tops up a deposit — with no route at
all (`SwapInventory.credit` had no caller, and raising config inventory does
not reliably take: the persisted snapshot wins for keys it has already seen,
issue #130).

The new route corroborates against the pool's on-chain channel funding, Σ
`cumulativePaid + deposit`, and credits only the excess of that over the pool's
own `total`. `deposit` alone is unusable — it is the *remaining un-paid-out*
balance and falls on every redemption — while the sum is invariant under
redemption and rises only when capital actually enters a channel. Because
crediting raises `total`, and `total` is what the next read is compared
against, a repeated call measures a gap that has already closed: double
crediting is structurally impossible, with no new persisted ledger.

Also adds the optional `getFundingPosition` capability to the
`ChannelOnChainReader` seam (implemented for EVM as one `eth_call` returning
both words, so they can never straddle a redemption). Readers without it cause
the route to refuse (503), never to guess. `SWAP_ADMIN_TOKEN` still gates the
write and an unset token still disables it (503); no new config key.
