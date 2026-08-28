# @toon-protocol/swap

**Swap USDC across chains through a relay, with no server in between.** A maker publishes an
order; a taker streams it small fills. Each fill is a pair of signed payment-channel claims —
the taker's on chain A, the maker's on chain B — passed through a TOON relay that stores
messages but never opens them. Each side verifies the other's claim itself. Nothing touches a
chain until the end, when the newest claim is redeemed once.

Both roles live in this package: `toon-swap make` runs a maker, `toon-swap take` runs a taker.

- **How it works** (the sequence, and the one number you turn) →
  [docs/how-it-works.md](https://github.com/toon-protocol/swap/blob/main/docs/how-it-works.md)
- Design record → [docs/relay-swap.md](https://github.com/toon-protocol/swap/blob/main/docs/relay-swap.md)
- Operator & config reference → [deploy/swap/README.md](https://github.com/toon-protocol/swap/blob/main/deploy/swap/README.md)
- Changelog → [packages/swap/CHANGELOG.md](https://github.com/toon-protocol/swap/blob/main/packages/swap/CHANGELOG.md)

## Try it in 60 seconds (taker, TOON devnet)

You need: **USDC on Base Sepolia and Solana devnet** (the
[devnet faucet](https://faucet.devnet.toonprotocol.dev) drips it), and a little **native gas**
on each chain (ETH on Base Sepolia, SOL on Solana devnet — the faucet does not drip gas).

```sh
npm i -g @toon-protocol/swap        # or: npx @toon-protocol/swap …
```

`swap.config.json`:

```json
{
  "chains": ["evm", "solana"],
  "chainProviders": [
    {
      "chainType": "evm",
      "chainId": "evm:84532",
      "rpcUrl": "https://base-sepolia-rpc.publicnode.com",
      "registryAddress": "0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5",
      "tokenAddress": "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce",
      "tokenNetworkAddress": "0xe9E05dfecfe165266C88d73e61D483612651952a"
    },
    {
      "chainType": "solana",
      "chainId": "solana:devnet",
      "rpcUrl": "https://api.devnet.solana.com",
      "programId": "2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip",
      "tokenMint": "34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU"
    }
  ],
  "relay": {
    "readUrl": "wss://relay-ws.devnet.toonprotocol.dev",
    "connectorUrl": "https://proxy.relay.devnet.toonprotocol.dev/ilp",
    "transport": "btp",
    "payChain": "evm",
    "deposit": "1000000"
  },
  "gasStation": {
    "destination": "g.toon.relay.gas",
    "connectorUrl": "https://proxy.gas.devnet.toonprotocol.dev/ilp"
  },
  "statePath": "./state/swap-state.json"
}
```

Then:

```sh
# 1. Make an identity (written beside statePath, mode 600) and see the addresses to fund.
SWAP_AUTOGEN_IDENTITY=1 toon-swap orders --config swap.config.json

# 2. Pick an order from the list (printed as <makerPubkey>:<orderId>) and swap 1 USDC
#    in fills of 0.005 USDC (amounts are base units: USDC has 6 decimals).
SWAP_AUTOGEN_IDENTITY=1 toon-swap take --config swap.config.json \
  --order <makerPubkey>:<orderId> --size 1000000 --delta 5000

# 3. Take the newest claim to the target chain.
SWAP_AUTOGEN_IDENTITY=1 toon-swap redeem --config swap.config.json --stream <streamNonce>
```

`take` prints the three numbers your δ implies before it starts — exposure, relay cost, ETA —
and streams the fills. `redeem` pays out on EVM immediately; on Solana it records the claim,
then `close` and (after the challenge window) `settle` pay out.

> Instead of `SWAP_AUTOGEN_IDENTITY`, put `"mnemonic": "…"` in the config or set
> `SWAP_MNEMONIC`. The same mnemonic yields the Nostr key that seals messages and the chain keys
> that sign claims and pay for writes.

## Run a maker

A maker is the same program with an order to publish and capital to back it:

```json
{
  "chains": ["evm", "solana"],
  "swapPairs": [
    {
      "from": { "assetCode": "USDC", "assetScale": 6, "chain": "evm:84532" },
      "to": { "assetCode": "USDC", "assetScale": 6, "chain": "solana:devnet" },
      "rate": "0.99"
    }
  ],
  "inventory": { "solana:devnet": "500000000" },
  "channels": {},
  "chainProviders": [ "…as above, plus \"channelDeposit\": \"50000000\" on each entry…" ],
  "relay": { "…as above…" },
  "order": { "fill": { "min": "1000", "max": "10000000" } },
  "statePath": "./state/swap-state.json"
}
```

```sh
SWAP_AUTOGEN_IDENTITY=1 toon-swap make --config swap.config.json
```

| Key | What it does |
| --- | --- |
| `swapPairs`, `inventory` | What you sell, at what indicative rate, and how much target-chain capital you will issue against. |
| `chainProviders[].channelDeposit` | Lets the maker open and fund its side of a channel with each taker **on demand**, at the taker's first verified fill, and top it up as needed. Without it, channels must be pre-opened under `channels`. |
| `order.fill.min` / `max` | The smallest and largest fill a taker may send. The floor stops anyone making you sign thousands of near-zero claims. |
| `relay` | Where orders and messages go. Without `relay.connectorUrl` the maker boots **offline** (health and admin only) and says so. |
| `statePath` | Everything that must survive a restart: inventory, channel watermarks, sessions, orders. |

`GET /health` on `appPort` (default 8080) shows the relay loop, published orders and per-taker
watermarks. Full key list: [deploy/swap/README.md](https://github.com/toon-protocol/swap/blob/main/deploy/swap/README.md).

## Choose δ (the lever)

δ is the size of one fill. It sets three things at once. Small δ: safe, expensive, slow. Large
δ: risky, cheap, fast.

| | For a swap of size S with N = ⌈S/δ⌉ fills |
| --- | --- |
| **Exposure** | δ — the most you can lose if the maker stops: one fill. |
| **Relay cost** | (2N + 3) µUSDC — two writes per fill, three per swap, 1 µUSDC each. |
| **Time** | ≈ N × 0.37 s — ~350 ms per fill on the devnet, whatever δ is. |

Sweet spot on the devnet: **δ = 1 000 – 10 000 µUSDC** (0.001 – 0.01 USDC): under 0.25 %
relay cost and a 1 USDC swap in 40 s – 6 min. Measurements and the reasoning:
[docs/how-it-works.md](https://github.com/toon-protocol/swap/blob/main/docs/how-it-works.md#the-lever-δ).

## CLI

Every command takes `--config <path>` (default `./swap.config.json`).

| Command | Does |
| --- | --- |
| `toon-swap make` | Run a maker: publish orders, answer fills. (Also the default when no command is given.) |
| `toon-swap orders [--json]` | List live orders on the relay. |
| `toon-swap take --order <maker>:<orderId> --size <units> [--delta <units>] [--recipient <addr>] [--json]` | Accept an order and stream the fills. |
| `toon-swap resume --stream <streamNonce> [--json]` | Continue a session from disk after a stop, crash, or lost answer. |
| `toon-swap redeem --stream <streamNonce> [--via own\|gas-station] [--no-fallback]` | Redeem the newest claim on chain. `--via gas-station` asks the gas station to pay the fee; it falls back to your own gas unless `--no-fallback`. |
| `toon-swap close --stream <streamNonce>` | Solana: start the channel's challenge window. |
| `toon-swap settle --stream <streamNonce>` | Solana: pay out after the window. |
| `toon-swap sessions [--json]` | Your sessions and channel watermarks. |

Environment overrides: `SWAP_MNEMONIC`, `SWAP_AUTOGEN_IDENTITY`, `SWAP_IDENTITY_FILE`,
`SWAP_STATE_PATH`, `SWAP_RELAY_READ_URL`, `SWAP_RELAY_CONNECTOR_URL`, `SWAP_FILL_MIN`,
`SWAP_FILL_MAX`, `SWAP_LOG_LEVEL`.

## What is verified

Nobody verifies for you. Before a claim counts, the party receiving it checks:

- **the signature**, against the counterparty bound when the session opened — before any chain read;
- **the channel**, re-derived from the two participants, never taken from the message;
- **the money**: the claim's total is above the last accepted total by at least the fill, and the
  counterparty's on-chain deposit covers it. Chain reads are cached and budgeted per counterparty.

The relay's connector only checks that each write was paid for. It never sees a swap claim.

## State & resume

The taker keeps `<statePath minus .json>.taker.json`: every session, and one watermark per
channel so it never signs a claim below one it already sent. A fill is written to disk **before**
it is published. The maker keeps `statePath`: inventory, channel watermarks, sessions, per-taker
inbound watermarks, the relay cursor and its published orders.

After any stop, `toon-swap resume --stream <nonce>` re-quotes, reads what the relay kept, and
continues. A re-sent fill gets the same answer; a lost state file is re-synced from the maker's
refusal. Your money is never in a message that can be replayed — only in the newest claim, which
you redeem once.

## Develop

```sh
pnpm --filter @toon-protocol/swap test        # unit (in-memory relay, real signatures)
pnpm --filter @toon-protocol/swap test:e2e    # real relay + connector + anvil + solana-test-validator
```

The e2e suite swaps EVM→Solana and Solana→EVM through a real relay and redeems every claim on
chain; `tests/e2e/devnet-swap.e2e.test.ts` (opt-in) does the same against the live devnet.
