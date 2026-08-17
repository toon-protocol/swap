# swap runtime image (issue #124)

Runtime container for the TS rolling-swap **maker** node. Built from
`deploy/swap/Dockerfile` (repo-root build context); entrypoint is the
`toon-swap` CLI (`packages/swap/src/cli.ts`).

```
docker build -f deploy/swap/Dockerfile -t swap .
docker run --rm -p 3400:3400 \
  -v "$(pwd)/swap.config.json:/app/config/swap.config.json:ro" \
  -e SWAP_MNEMONIC="$(cat mnemonic.txt)" \
  swap
```

This does **not** deploy anything to a box — it only produces a pullable
image. On-box provisioning (identity generation, DNS/TLS, gas funding, the
connector-side compose service) is a separate, human-gated ticket
(toon-meta#402).

## Config file (`/app/config/swap.config.json` by default)

Mounted read-only at the path the `CMD` passes to `--config` (override with
a different `--config <path>` in the container's command). JSON, same shape
`startSwapNode()` consumes. Fields relevant to the proven standalone-maker
wiring (`scratchpad/t6/maker.mjs` — a driving-session scratch file, not
checked into this repo):

| Field | Required | Notes |
| --- | --- | --- |
| `swapPairs` | yes | Non-empty array of `{ from, to, rate }` (`{ assetCode, assetScale, chain }` legs). |
| `chains` | yes | e.g. `["evm"]`. |
| `channels` | yes | Per-chain seed `ChannelEntry[]` (`channelId`, `cumulativeAmount`, `nonce`, `updatedAt`). |
| `inventory` | yes | Per-chain starting inventory (string/number, coerced to `bigint`). |
| `relayUrls` | yes | Nostr relay WS URLs (legacy fallback publish path — see `peerInfoIlpDestination` below). |
| `windowBudget` | no | Issue #49 per-chain in-flight window ceiling. |
| `blsPort` | no | `/health` HTTP port. |
| `btpServerPort` | no | **Required for the proven standalone-maker wiring** — no `connectorUrl`/`connector` set + this present = auto-created embedded `ConnectorNode` with no parent, self-routed. |
| `statePath` | no | Durable state snapshot path (issue #46) — mount a volume here to persist inventory/watermarks/bindings across restarts. The image pre-creates `/app/state`, owned by the runtime `swap` user (uid `10001`), as the intended mount point — see "Runtime user & filesystem" below. |
| `intakeLedgerPath` | no | **Issue #171.** Durable per-class intake-ledger path (ADR 0003's removal gate — see "ADR 0003 removal gate" below). Defaults to `intake-ledger.json` beside `statePath`; without either, counts are in-memory only and reset on restart. |
| `chainProviders` | yes for EVM settlement | Array of `{ chainType: "evm", chainId, rpcUrl, registryAddress, tokenAddress, tokenNetworkAddress, channelAddress, keyId? }` (or the `solana`/`mina` variants — see `SwapNodeChainProvider` in `swap-node.ts`). **Two different contracts, both required** for any EVM chain a `swapPair` targets — boot refuses otherwise: `tokenNetworkAddress` is **leg A**, the deployed `TokenNetwork` a *client* calls `openChannel(address,uint256)` on to open the channel it pays this maker over (this is what the kind:10032 `tokenNetworks` entry advertises, and it must be the same fleet-wide `TokenNetwork` deployment the relay/store/apex announce for this chain+token); `channelAddress` is **leg B**, the deployed `RollingSwapChannel` this maker signs v2 EIP-712 balance-proof claims against (advertised separately as `swapVerifyingContracts`). Never set them to the same address — see issue #133. `keyId` defaults to `settlementPrivateKey` (or the identity secret key) when omitted. |
| `settlementPrivateKey` | no | Hex EVM private key for the claim signer / `chainProviders[].keyId` default. In the proven wiring this is the **same BIP-44 account-index-2 key** used as the connector `keyId`. **Issue #126:** when the identity is a mnemonic and this is unset (or a `0xdead…`-style placeholder), the CLI auto-derives it via `deriveSwapNodeKeys` (index-2) — a committed skeleton can ship a placeholder here and rely on the CLI to fill in the real key, whether or not `identityAutogen` is used. |
| `identityAutogen` | no | **Issue #126.** When `true` (or `SWAP_AUTOGEN_IDENTITY=1`) and no identity is otherwise provided, self-generates a BIP-39 mnemonic and persists it to an identity file (mode 600, default beside `statePath`) so restarts reuse the same identity. No-op if `mnemonic`/`secretKey` is set. |
| `ilpAddress` | no | Advertised ILP address + self-route prefix. Default `g.toon.swap.<pubkey16>`. |
| `btpEndpoint` | no | **Public** `wss://host:port` BTP endpoint advertised in kind:10032 — the "direct-dial" reachability path a client uses to reach a deployed maker with no parent connector (toon-meta#402). |
| `advertisedAsset` | no | `{ assetCode, assetScale }` for kind:10032. Default `{ USD, 6 }`. |
| `peerInfoIlpDestination` | no | **Issue #124.** ILP address of a relay that stores events, e.g. the apex `g.townhouse` — routes the paid kind:10032 announce over ILP through the connector instead of the (pay-to-write-rejected) unpaid Nostr WS publish. Requires a connector (`btpServerPort` standalone mode, or `connectorUrl`). |
| `peerInfoPricePerByte` | no | Price-per-byte (string/number → `bigint`) for the `peerInfoIlpDestination` ILP PREPARE `amount`. Default `0`. |
| `passphrase` | no | BIP-39 passphrase. |
| `knownPeers`, `transport`, `connectorUrl`, `parentPeerId`, `parentAuthToken`, `nodeId`, `parentEvmAddress`, `maxRateAge` | no | See `packages/swap/src/cli.ts` header + `SwapNodeConfig` — not part of the proven standalone wiring, only needed for the embedded-with-parent / rate-feed / privacy-overlay variants. |

Exactly one identity is required: `mnemonic` (BIP-39) or `secretKey` (64-char
hex, 32 bytes) in the config file, or their env equivalents `SWAP_MNEMONIC` /
`SWAP_SECRET_KEY_HEX` (below) — env always wins and is the preferred way to
inject the secret from a mount rather than baking it into the config file.

## Environment variables (override the config file)

| Var | Purpose |
| --- | --- |
| `SWAP_MNEMONIC` | BIP-39 mnemonic — identity + (unless `settlementPrivateKey`/`chainProviders[].keyId` override it) the claim signer. |
| `SWAP_SECRET_KEY_HEX` | 64-char hex secret key, alternative to a mnemonic. |
| `SWAP_BLS_PORT` | Overrides `blsPort`. |
| `SWAP_RELAYS` | Comma-separated relay WS URLs, overrides `relayUrls`. |
| `SWAP_STATE_PATH` | Overrides `statePath`. |
| `SWAP_INTAKE_LEDGER_PATH` | **Issue #171.** Overrides `intakeLedgerPath`. |
| `TOON_CONNECTOR_URL` | Parent BTP URL — activates embedded-with-parent mode instead of standalone. |
| `TOON_PARENT_PEER_ID` | Parent peer id (default `apex`). |
| `TOON_PARENT_AUTH_TOKEN` | BTP auth token for the parent peer. |
| `TOON_ILP_ADDRESS` | Overrides `ilpAddress`. |
| `TOON_NODE_ID` | Overrides the embedded connector `nodeId`. |
| `SWAP_MAX_RATE_AGE_MS`, `SWAP_MAX_RATE_AGE` | Maker staleness bound(s) (issue #48) — require `SWAP_RATE_URL`. |
| `SWAP_RATE_URL`, `SWAP_RATE_TIMEOUT_MS` | HTTP JSON rate feed (issue #47 AC-3). |
| `SWAP_AUTOGEN_IDENTITY` | `1`/`true` (issue #126) — overlay for `identityAutogen`. |
| `SWAP_IDENTITY_FILE` | Overrides the self-generated identity file path (default: beside `statePath`, or the cwd when `statePath` is unset). |
| `SWAP_LOG_LEVEL` | swap#136 — verbosity of the JSON-line logger the CLI installs: `debug`\|`info`\|`warn`\|`error`\|`silent` (default `info`). Optional; an unrecognised value degrades to the default. |
| `SWAP_ADMIN_TOKEN` | **Issue #138.** Operator token for the `/admin/inventory/*` **write** routes. Optional — unset means the writes are refused with 503, never left open. |
| `SWAP_RECONCILE_INTERVAL_MS` | **Issue #138.** Cadence of the chain-truth inventory reconcile (default `60000`; `0` disables the periodic pass — the boot pass and the admin routes still work). |

Refusals show up in `docker logs` as one JSON object per line — grep
`swap.claim.refused` for a swap the maker turned away, and `reason` for why
(e.g. `channel_unredeemed`). Before swap#136 the container logged nothing at
all for a refused swap.

`peerInfoIlpDestination` / `peerInfoPricePerByte` are config-file-only (no
env override), matching `btpEndpoint`. (`ilpAddress` is the exception among
the kind:10032 fields — it *does* have an override, `TOON_ILP_ADDRESS`.)

## Ports

- `btpServerPort` (config field, no default in standalone mode — the
  maker.mjs wiring uses `3400`): BTP WebSocket server. The image declares no
  `EXPOSE`; publish it with `-p` to make the maker directly dialable.
- `blsPort`: `/health` + `/admin/inventory*` HTTP.

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
| `GET /admin/intake` | none | **Issue #171.** Per-class intake counts backing ADR 0003's removal gate — see below. |

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
curl -sX POST http://127.0.0.1:<blsPort>/admin/inventory/deposit \
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
   (`curl http://127.0.0.1:<blsPort>/admin/inventory`) or over the private
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

## ADR 0003 removal gate (issue #171)

ADR 0003's removal gate is *"no legacy intake observed on the deployed maker
for N consecutive days"*. **Do not read this from `docker logs`.**
`swap:release` is auto-on-green and Watchtower recreates the `swap-node`
container on every merge to `main`; `docker logs` only ever holds the
CURRENT container's stdout, so every recreate silently resets the
observation window to zero and any `docker logs | grep swap.intake.arrival`
count is a lie about how long legacy has actually been silent.

Read the durable ledger instead — it survives a recreate because it lives
beside `statePath` on the same persistent volume:

```sh
curl -s http://127.0.0.1:<blsPort>/admin/intake | jq .
```

```json
{
  "generatedAt": 1755450000000,
  "since": 1754845200000,
  "classes": [
    { "class": "legacy", "count": 0 },
    { "class": "rolling-rfq", "count": 812, "firstSeenAt": 1754845201000, "lastSeenAt": 1755449999000 },
    { "class": "rolling-fill", "count": 799, "firstSeenAt": 1754845202000, "lastSeenAt": 1755449999500 },
    { "class": "refused", "count": 3, "firstSeenAt": 1754900000000, "lastSeenAt": 1755000000000 }
  ]
}
```

The gate is satisfied only when **both** hold: `legacy.count === 0` (or, for
a maker with prior legacy traffic, `Date.now() - legacy.lastSeenAt >= N
days`) **and** `Date.now() - since >= N days`. The second check is what a
`docker logs` grep could never give: without `since`, a ledger that just
started reads identically to one that has genuinely observed N days of
silence — a freshly-recreated container's `count: 0` is not evidence of
anything yet. A class that has never fired at all omits `firstSeenAt`/
`lastSeenAt` rather than reporting `0`, which would be indistinguishable
from a real epoch-0 timestamp.

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
