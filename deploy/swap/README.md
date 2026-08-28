# swap runtime image

Runtime container for the rolling-swap **maker**. Built from `deploy/swap/Dockerfile`
(repo-root build context); entrypoint is the `toon-swap` CLI (`packages/swap/src/cli.ts`).

The maker is a **relay-mediated swap client** — it embeds no connector, sits behind none, opens
no listener a taker could reach, and publishes no kind:10032. It publishes an **order** on the
relay and answers gift-wrapped fills from its inbox, paying the relay's connector for every write.
Read [`docs/relay-swap.md`](../../docs/relay-swap.md) first; this file is the config-surface
reference.

```
docker build -f deploy/swap/Dockerfile -t swap .
docker run --rm -p 127.0.0.1:8080:8080 \
  -v "$(pwd)/swap.config.json:/app/config/swap.config.json:ro" \
  -e SWAP_AUTOGEN_IDENTITY=1 \
  swap
```

## The relay it trades on

Two URLs: the relay's free NIP-01 read endpoint and the relay connector's client edge, where
writes are paid (`g.toon.relay`, 1 µUSDC on the devnet). The maker opens (or adopts) its own
channel with that connector on `relay.payChain` from its index-2 key — so that key needs native
gas and the settlement token there.

```json
"relay": {
  "readUrl": "wss://relay-ws.devnet.toonprotocol.dev",
  "connectorUrl": "https://proxy.relay.devnet.toonprotocol.dev/ilp",
  "payChain": "evm",
  "deposit": "1000000"
}
```

Without `relay.connectorUrl` the maker boots **offline** — `/health` and `/admin` answer, no
order is published, no fill is answered — and logs `swap.config.relay_offline`. A committed
fleet config that predates this key therefore still boots (CLAUDE.md › "Config first, code
second"); add the key to make it trade. `GET /health` reports `relay: { connected, eose, cursor }`,
the published orders and the inbound watermarks.

## Config file (`/app/config/swap.config.json` by default)

Mounted read-only at the path the `CMD` passes to `--config`. JSON, the shape `startSwapNode()`
consumes:

| Field | Required | Notes |
| --- | --- | --- |
| `swapPairs` | yes | Non-empty array of `{ from, to, rate }` (`{ assetCode, assetScale, chain }` legs). `from.chain` must be `evm:*` or `solana:*`. |
| `chains` | yes | Families the maker derives keys for: `["evm", "solana", "mina"]` subset, covering every `from.chain` **and** every `to.chain` (the maker is paid on `from.chain` and needs its address there). |
| `channels` | no, when `channelDeposit` is set | Per `to.chain`: pre-opened leg-B channels `[{ channelId, cumulativeAmount, nonce, updatedAt }]` — the (maker, taker) `TokenNetwork` channel id on EVM, the (maker, taker, mint) PDA on Solana. Leave empty and set `chainProviders[].channelDeposit` to let the maker open and fund them on demand. |
| `inventory` | yes | Per `to.chain`: leg-B capital in base units. A value **above** the persisted snapshot raises the pool on boot (new capital); below is left alone. |
| `windowBudget` | no | Per `to.chain`: in-flight ceiling. |
| `chainProviders` | yes | One entry per chain any pair touches. EVM: `{ chainType:"evm", chainId, rpcUrl, registryAddress, tokenAddress, tokenNetworkAddress, channelDeposit?, settlementTimeoutSeconds? }` — `tokenNetworkAddress` is the fleet's `TokenNetwork`, where channels live and the EIP-712 `verifyingContract` (`channelAddress`, the 2.x `RollingSwapChannel`, is accepted and ignored). Solana: `{ chainType:"solana", chainId, rpcUrl, programId, tokenMint, channelDeposit?, challengeDurationSeconds? }` — `programId` and `tokenMint` required. `channelDeposit` (base units) enables on-demand leg-B channels: at a taker's first verified fill the maker deposits this much into the (maker, taker) channel from its index-2 key and tops it up whenever a claim would exceed what it holds. The `rpcUrl` is also what the maker verifies a taker's leg-A claim against. Mina: `{ chainType:"mina", chainId, graphqlUrl, zkAppAddress }` (leg B only). |
| `relay` | for trading | `{ readUrl, connectorUrl, destination? ("g.toon.relay"), payChain? ("evm"\|"solana"), rpcUrl?, deposit?, channelStorePath?, transport? }`. Aliases from 2.x: `relayUrls[0]` → `readUrl`, top-level `connectorUrl` → `connectorUrl`. |
| `order` | no | `{ fill: { min, max }, ttlMs (10 min), refreshMs (8 min) }` — the per-fill delta bounds a taker may pick (source base units; default 1–100 USDC). Alias: `fillAmount` → `fill.min`. |
| `maxChainReadsPerMin` | no | Chain reads one taker may cause per minute while its claims are verified (default 30). |
| `gasStation` | no | `{ destination? ("g.toon.relay.gas"), connectorUrl? }` — for `toon-swap redeem --via gas-station`; `connectorUrl` is the station's own connector, whose key the job is sealed to (the relay route is forwarded). |
| `quote` | no | `{ ttlMs (60s), sessionTtlMs (1h), maxSessions (1024) }`. |
| `appPort` | no | Port for `/health` and `/admin/*` (default 8080; `blsPort` is an alias). |
| `statePath` | no | Snapshot file (inventory, channel watermarks, bindings, sessions, inbound watermarks, relay cursor, orders) — write-ahead of every claim. The taker subcommands keep theirs at `<statePath>.taker.json`. |
| `maxRateAge` | no | Staleness bound on the rate feed; needs `SWAP_RATE_URL`. |
| `adminToken`, `reconcileIntervalMs`, `identityAutogen` | no | See below. |
| `mnemonic` / `secretKey` | one | Identity — or `identityAutogen` / `SWAP_AUTOGEN_IDENTITY`. The BIP-44 index-2 keys derived from the mnemonic are the maker's addresses on both chains (they receive leg A, sign and fund leg B, and pay the relay's connector); the Nostr key at the same index signs orders and seals wraps. A mnemonic is required. |

**Retired (2.x) keys are accepted and ignored with a `swap.config.retired_key_ignored` warning:**
`ilpAddress`, `btpServerPort`, `btpEndpoint`, `knownPeers`, `transport`,
`parentPeerId`, `parentAuthToken`, `parentEvmAddress`, `nodeId`, `advertisedAsset`,
`peerInfoIlpDestination`, `peerInfoPricePerByte`, `peerInfoTtlSeconds`,
`peerInfoRefreshIntervalMs`, `rolling`, `rollingLegBSender`, `settlementPrivateKey`,
`chainProviders[].channelAddress`. A committed 2.x config boots.

## Environment variables (override the config file)

| Var | Meaning |
| --- | --- |
| `SWAP_MNEMONIC` | BIP-39 mnemonic (wins over the file). |
| `SWAP_SECRET_KEY_HEX` | 64-char hex secret key, alternative to a mnemonic (the maker still needs a mnemonic to derive leg-B keys). |
| `SWAP_APP_PORT` (alias `SWAP_BLS_PORT`) | Overrides `appPort`. |
| `SWAP_RELAY_READ_URL`, `SWAP_RELAY_CONNECTOR_URL` | Override `relay.readUrl` / `relay.connectorUrl`. |
| `SWAP_RELAY_DESTINATION`, `SWAP_RELAY_PAY_CHAIN` | Override `relay.destination` / `relay.payChain`. |
| `SWAP_FILL_MIN` (alias `SWAP_FILL_AMOUNT`), `SWAP_FILL_MAX` | Override `order.fill`. |
| `SWAP_STATE_PATH` | Overrides `statePath`. |
| `SWAP_MAX_RATE_AGE_MS`, `SWAP_MAX_RATE_AGE` | Maker staleness bound(s) — require `SWAP_RATE_URL`. |
| `SWAP_RATE_URL`, `SWAP_RATE_TIMEOUT_MS` | HTTP JSON rate feed. |
| `SWAP_AUTOGEN_IDENTITY` | `1`/`true` — generate + persist a mnemonic on first boot (`identity.json` beside `statePath`, mode 600); prints the index-0 pubkey and the index-2 EVM/Solana leg-B signers to fund. |
| `SWAP_IDENTITY_FILE` | Overrides the identity file path. |
| `SWAP_LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error`\|`silent` (default `info`). |
| `SWAP_ADMIN_TOKEN` | Operator token for the `/admin/inventory/*` **write** routes. Unset = writes refused (503). |
| `SWAP_RECONCILE_INTERVAL_MS` | Cadence of the chain-truth reconcile (default `60000`; `0` disables the periodic pass). |

Refusals show up in `docker logs` as one JSON object per line — `swap.fill.refused_paid` /
`swap.fill.claim_refused` with a `reason` (`insufficient_liquidity`, `channel_unredeemed`,
`no_channel_available` naming the Solana PDA to open, …), `swap.fill.accepted` for every fill.

## Ports

- `appPort` (default `8080`): `/health`, `/admin/inventory*`. Loopback / private network only —
  nothing a taker needs is here; takers talk to the relay.

## Inventory recycling & the operator surface (issue #138)

Every issued claim is booked as **unsettled channel liability**, not as a
permanent debit, and the capacity comes back when the CHAIN shows the claim
redeemed. The node reads its own channels' on-chain `cumulativePaid` at boot
and every `SWAP_RECONCILE_INTERVAL_MS` and recycles what it finds, so a maker
whose capacity is held by already-redeemed claims heals itself with no
operator action and no redeploy. Reconciliation needs an EVM **or Solana**
`chainProviders` entry (the same one the rebind check uses); without it the
node logs `swap.reconcile.disabled` and `GET /admin/inventory` reports
`reconciler.enabled: false`.

**Per chain family (issue #141).** No extra config: the family is taken from
the chain key of the `chainProviders` entry you already have.

| family | recycled? | source |
| --- | --- | --- |
| `evm:*` | yes | `RollingSwapChannel.channels(channelId).cumulativePaid` via `eth_call`. |
| `solana:*` | yes | The channel PDA's `transferred_amount_{a,b}` (our own participant slot) via `getAccountInfo`. The node picks the slot from its OWN derived Solana address — nothing to configure. |
| `mina:*` | **no** | Mina publishes no cumulative-paid: the balances live only inside a salted Poseidon `balanceCommitment`. Every readable substitute (`nonceField`, `depositTotal`, `channelState`) can overstate the watermark, which would over-recycle and would also approve a rebind that strips an unredeemed claim — so the node refuses to guess. A Mina pool's capacity stays blocked and `blockedReason` says why. |

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /admin/inventory` | none | Per-pool `available`/`total`/`unsettled`/`inFlight`/`free`, per-channel issued-vs-redeemed-on-chain, and a `blockedReason` naming what is holding the capacity when `free` is 0. |
| `POST /admin/inventory/reconcile` | token | Force a chain-truth pass now; returns what it recycled. |
| `POST /admin/inventory/credit` | token | `{ assetCode, chain, amount? }` — recycle burned capital. Applies **only** what an on-chain redemption corroborates: an uncorroborated request (or one larger than the chain backs) is refused `409` with nothing applied. |
| `POST /admin/inventory/deposit` | token | **swap#142.** `{ assetCode, chain, amount?, dryRun? }` — book genuinely NEW capital. Applies **only** what the pool's on-chain channel funding corroborates. |

### Adding capital (swap#142)

`credit` recycles capital the pool already counted — it can restore
`available`, never raise `total`. Genuinely *adding* capital (funding a new
channel, topping up a deposit) is `deposit`, and it is the only route that
raises `total`. Editing the configured inventory is not a substitute: the
persisted snapshot wins over config for pool keys the node has already seen
(issue #130), so a config bump silently does nothing.

Procedure — **fund the channel on chain first**, then tell the node:

```sh
# 1. Deposit into a channel this maker has provisioned (chain side).
# 2. See what the node will credit, without changing anything:
curl -sX POST http://127.0.0.1:<appPort>/admin/inventory/deposit \
  -H "authorization: Bearer $SWAP_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"assetCode":"USDC","chain":"evm:base:8453","dryRun":true}'
# 3. Same call without dryRun applies it (add "amount" to assert an exact figure).
```

What it corroborates against is Σ `cumulativePaid + deposit` over the pool's
channels — **not** the `deposit` field alone, which is the *remaining
un-paid-out* balance and falls on every redemption. The sum is invariant
under redemption and rises only when capital actually enters a channel. Only
the excess of that sum over the pool's `total` is credited, and crediting
raises `total` — so the gap a repeat call measures has already closed, and
double-crediting is impossible without any extra bookkeeping to lose.

Refusals, all with nothing applied:

| Status | Meaning |
| --- | --- |
| `409 uncorroborated` | the chain shows no more capital than the pool already booked — the deposit has not landed, or it went somewhere this node does not read |
| `409 exceeds_corroborated` | `amount` is larger than the chain backs |
| `503 chain_unreadable` | a channel read failed; the corroborated total would be incomplete |
| `503 funding_unreadable` | no on-chain reader, or one that cannot read funding positions (non-EVM until swap#141) |
| `404 unknown_pool` | no channel state for that pool |

Capital sitting in the payout wallet but not yet placed in a channel is **not**
creditable — the chain shows no channel holding it. Move it into a channel and
it becomes corroborable.

**Protection.** Two layers:

1. The routes live under `/admin`, which the fleet's box nginx already
   answers with 404 from the internet (`^~ /admin`), the same rule that
   covers the connector's admin surface. Reach them from the box itself
   (`curl http://127.0.0.1:<appPort>/admin/inventory`) or over the private
   network.
2. Writes require `SWAP_ADMIN_TOKEN` in `Authorization: Bearer <token>` or
   `X-Swap-Admin-Token`, compared in constant time. **No token configured =
   writes disabled (503)**, never open. The token is optional config on
   purpose: a newly *required* key crash-loops every `:release`-tracking
   maker on its next auto-deploy (issue #134).

`GET` is unauthenticated because it discloses strictly less than the
already-unauthenticated `GET /health`, and an operator diagnosing a stalled
maker should not be blocked on a secret they may not have set.

### Known: a small historical `total` inflation

Before swap#137, a *failed* swap unwound its inventory hold with `credit()`,
which raises `available` **and** `total`, so every failure left `total` one
swap-notional too high. #137 fixed the unwind and #140's reconciler restored
`available`; the live devnet maker therefore reads `available` 15 000 000
(correct) against `total` 15 003 500. The error is static — it cannot grow —
and it is deliberately **not** corrected by any live write path:

- `total` is what kind:10032 advertises, so the maker over-advertises by
  0.023 %. A counterparty sizing a swap against the inflated figure is refused
  at issuance with a benign `T04`; it is never handed a claim the maker cannot
  honor.
- A reconcile that recomputed `total` from configured inventory would be a
  *downward* write derived from figures the node does not durably own (config
  loses to the snapshot for seen keys, issue #130; the state file is the only
  ledger of additions and the documented reset deletes it). Firing wrongly, it
  would shrink `total` below capital the maker really holds — turning a
  bounded cosmetic error into an unbounded one, automatically, on a
  `:release` auto-deploy.
- It self-heals: `POST /admin/inventory/deposit` converges `total` onto chain
  truth **from below**, so the next genuine top-up credits the top-up minus
  the 3 500 and lands `total` exactly on the chain's figure. The residue moves
  into `available` being 3 500 low, which is the under-serving (safe)
  direction.

If it must be exact sooner, do it with the node **down** — stop the maker,
edit the persisted pool entry in `swap-node-state.json`, restart. That is a
deliberate human action, not a route that can be fired by accident.

## Runtime user & filesystem

The container runs as a non-root `swap` user, uid/gid `10001`. Two paths are
pre-created in the image and chowned to that uid so a bind mount or a fresh
named volume mounted onto them isn't root-owned (Docker only propagates an
image path's ownership into a *new* named volume when the path already
exists in the image):

- `/app/config` — read-only config file mount point (see above).
- `/app/state` — `statePath` mount point. connector#983's compose mounts a
  named `swap_node_state` volume here; without the pre-created/chowned
  directory the maker's state snapshot write fails with `EACCES`.

## Not covered by this image

DNS/TLS, gas funding, and the connector-side compose service that mounts
this image on a box are the sibling toon-meta#402 tickets. On-box identity
generation is now covered by `SWAP_AUTOGEN_IDENTITY`/`identityAutogen`
(issue #126) — with a `statePath` volume mounted and no `mnemonic`/
`secretKey` provided, the maker generates + persists its own identity and
derives its index-2 settlement key on first boot, and reuses it on every
restart. Without `SWAP_AUTOGEN_IDENTITY`, this image still only needs a
config file and (for identity) a mnemonic to boot standalone and start
advertising.

> The relay-box `swap.config.json` skeleton's `_settlementPrivateKey_comment`
> ("a human must compute that key") is stale as of issue #126 — the CLI now
> derives it automatically from the resolved identity. Trim/update that
> comment in the skeleton (connector#983) as a follow-up; not done here
> (out of repo).
