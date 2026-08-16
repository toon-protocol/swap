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
