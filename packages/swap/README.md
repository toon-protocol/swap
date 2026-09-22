# @toon-protocol/swap

**Swap USDC across chains through a relay, with no server in between.**

One side (the **maker**) publishes an order. The other side (the **taker**) streams it small
fills. Each fill trades a pair of signed payment-channel claims — the taker's on chain A, the
maker's on chain B — carried by a TOON relay that stores messages but never opens them. Each
side checks the other's claim itself. **Nothing touches a chain until the end**, when you redeem
the newest claim once.

Both roles ship in this one package: `toon-swap make` runs a maker, `toon-swap take` runs a taker.

```
maker ──publishes order──▶  relay  ◀──reads orders── taker
                             │
      fill 1: taker's claim on chain A  ──▶  maker
              maker's claim on chain B  ◀──
      fill 2: … repeat until the size you asked for is filled …
                             │
            you redeem the NEWEST claim on chain — once
```

---

# Getting started

Follow the six steps below in order. They take you from an empty directory to USDC redeemed on
chain. The whole guide uses the **TOON devnet** (Base Sepolia + Solana devnet); no real money is
involved.

## Before you start

| You need | Notes |
| --- | --- |
| **Node.js 22+** | `node --version` |
| **USDC to swap** | On the chain you swap **from** — and on both chains if you also run your own maker (step 4). The [devnet faucet](https://faucet.devnet.toonprotocol.dev) drips it. |
| **Native gas on both chains** | ETH on Base Sepolia, SOL on Solana devnet. **The faucet does not drip gas** — get ETH from any Base Sepolia faucet and SOL with `solana airdrop 1 <address> --url devnet`. |

> [!IMPORTANT]
> **Two kinds of money on each chain.** USDC is what you swap; native gas is what pays for
> opening a channel and redeeming. Holding USDC alone is not enough, and it is the most common
> reason a first attempt stops.

> [!IMPORTANT]
> **Every amount is in base units — never decimals.** USDC has 6 decimals, so
> `1000000` = 1 USDC, `5000` = 0.005 USDC. There are no floats anywhere in this CLI.

## 1. Install

```sh
npm i -g @toon-protocol/swap
```

Or run it without installing: `npx @toon-protocol/swap <command>`.

## 2. Write the config

Make a directory, and save this as `swap.config.json`. It is the live devnet — copy it as is.

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
  "statePath": "./state/swap-state.json"
}
```

Three parts, and that is the whole of it:

- **`chainProviders`** — the two chains you can trade between, and the contracts on each.
- **`relay`** — where orders and messages go. `readUrl` is free; `connectorUrl` is what you pay
  for each write (1 µUSDC), on the chain named by `payChain`.
- **`statePath`** — the one file that must survive a restart.

## 3. Make an identity and fund it

```sh
SWAP_AUTOGEN_IDENTITY=1 toon-swap orders --config swap.config.json
```

This generates a mnemonic (written beside `statePath`, mode 600) and prints the addresses to
fund:

```
[swap-node] identity pubkey (Nostr, index-0): cac44de6…
[swap-node] settlement address (EVM, index-2): 0x43B9dD6395071C0B54BcdE82B3e3aE5085944AF2 — the leg-B signer
[swap-node] settlement address (Solana, index-2): 5YLcveQ3nxNwFvPnmyzZpm6Q21tj5bCUy6yThC62q1WN — the leg-B signer
```

**Send USDC and native gas to those two addresses now** (see the table above). One mnemonic
yields all of it: the Nostr key that seals messages, and the chain keys that sign claims and pay
for writes.

> Prefer your own key? Drop `SWAP_AUTOGEN_IDENTITY` and set `"mnemonic": "…"` in the config, or
> the `SWAP_MNEMONIC` environment variable. Re-running with the same mnemonic always gives the
> same addresses.

## 4. Find an order

The same command, once funded, lists what makers are offering:

```sh
SWAP_AUTOGEN_IDENTITY=1 toon-swap orders --config swap.config.json
```

Each live order prints as `<makerPubkey>:<orderId>`, with its direction, rate and fill bounds:

```
8b73806670885d68…:USDC:evm:84532->USDC:solana:devnet
  USDC@evm:84532 → USDC@solana:devnet  rate 0.99  fill [1000, 10000000]  max 500000000  expires 2026-09-22T18:41:25.000Z
```

**Now pick your path:**

| What you see | Do this |
| --- | --- |
| One or more orders | Copy the `<makerPubkey>:<orderId>` line and go to **step 5**. |
| `No live orders on wss://…` | Nobody is making a market right now. Run your own maker in a second terminal — see [Run a maker](#run-a-maker) — then come back and run this command again. |

> [!NOTE]
> `No live orders` is a normal answer, not an error. There is no guarantee a maker is running on
> the devnet at any given moment; being your own maker is a fully supported way to do your first
> swap, and it is the only way that does not depend on a stranger.

## 5. Take the order

Swap 1 USDC, in fills of 0.005 USDC:

```sh
SWAP_AUTOGEN_IDENTITY=1 toon-swap take --config swap.config.json \
  --order <makerPubkey>:<orderId> --size 1000000 --delta 5000
```

- `--size` — how much of the **source** asset to swap, in base units. `1000000` = 1 USDC.
- `--delta` — the size of **one fill** (δ), in base units. Optional; defaults to the order's
  `fill.min`. See [Choosing δ](#choosing-δ).
- `--recipient` — where the target-chain payout goes. Optional; defaults to your own address on
  that chain.

`take` opens and funds your channel with the maker on the source chain for you — that is the
one on-chain transaction at this step, and what the native gas is for. Then it prints what your δ
implies before any money moves, and streams the fills:

```
session b94f8173aeda8b82f8a641adc60b1f13: quoted at 0.99; 200 fills of 5000 — exposure 5000 base units per fill, ~403 relay writes (~0.040% of notional at 1 µUSDC each), ETA ~80 s
  fill 1: +4950 → cumulative 4950 on GrvnFJRwgoJ7…
  fill 2: +4950 → cumulative 9900 on GrvnFJRwgoJ7…
  …
done: received 990000 on GrvnFJRwgoJ7…; run 'toon-swap redeem --stream b94f8173aeda8b82f8a641adc60b1f13' to claim on chain
```

**Keep that `streamNonce`.** Every command after this one takes it. You can always get it back
with `toon-swap sessions`.

## 6. Redeem on chain

You now hold a signed claim. Redeeming turns it into tokens. How many commands that takes depends
on the **target** chain:

| Target chain | Commands | Why |
| --- | --- | --- |
| **EVM** (Base Sepolia) | `redeem` | Pays out immediately. |
| **Solana** (devnet) | `redeem` → `close` → `settle` | `redeem` records the claim, `close` starts the challenge window, `settle` pays out after it. |

```sh
# Both chains:
SWAP_AUTOGEN_IDENTITY=1 toon-swap redeem --config swap.config.json --stream <streamNonce>

# Solana only, after redeem:
SWAP_AUTOGEN_IDENTITY=1 toon-swap close  --config swap.config.json --stream <streamNonce>
# …wait out the challenge window, then:
SWAP_AUTOGEN_IDENTITY=1 toon-swap settle --config swap.config.json --stream <streamNonce>
```

You redeem **once**, at the end, with the newest claim — not once per fill. That is the whole
point of the design: 200 fills cost you one redemption.

That is a complete swap. 🎉

---

## If something goes wrong

Messages are verbatim. On a first run it is almost always one of the two "no gas" rows, or the
base-units row at the bottom.

| Message | What it means |
| --- | --- |
| `No live orders on wss://…` | No maker is publishing right now. Not an error — see step 4. |
| `Settlement wallet 0x… has no gas on evm:… to open a payment channel. Fund the wallet …` | Your EVM address holds no ETH. Opening the channel is an on-chain transaction; paying for a request afterwards never spends gas. A maker shows the same thing as `[swap-node] Startup error: ChannelFundingError: …`. |
| `Solana settlement wallet … holds 0 lamports, below the … needed here (rent for the channel + vault accounts, plus signature fees). Native SOL is separate from the settlement token …` | Your Solana address holds no SOL. `solana airdrop 1 <address> --url devnet`. |
| `config.relay.readUrl and config.relay.connectorUrl are required for taker commands` | The `relay` block is missing from your config. |
| `a mnemonic is required (config.mnemonic, SWAP_MNEMONIC, or SWAP_IDENTITY_FILE)` | No identity. Set `SWAP_AUTOGEN_IDENTITY=1` or supply a mnemonic. |
| `--order must be <makerPubkey>:<orderId>` | Pass the whole line `orders` printed, colons and all. |
| `order …: is not live on the relay` | The order expired or was withdrawn between your `orders` and your `take`. Re-run `orders`. |
| `delta … is outside the order's fill bounds [min, max]` | Your `--delta` is below the maker's floor or above its ceiling. Use a value inside the `fill [min, max]` the order printed. |
| `size … is below one fill of …` | `--size` must be at least one δ. |
| `INSUFFICIENT_INVENTORY` from the maker | The maker ran out of target-chain capital mid-stream. Your existing claim is still good — redeem it. |
| An amount came out 1 000 000× too small | You passed decimals. Amounts are base units: 1 USDC is `1000000`. |

Interrupted, crashed, or closed the terminal? Nothing is lost —
see [State, resume and safety](#state-resume-and-safety).

---

# Run a maker

A maker is the same program with an order to publish and capital to back it. This is also how you
do a first swap with no one else involved: run this in one terminal, and `take` in another.

`maker.config.json`:

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
  "chainProviders": [
    {
      "chainType": "evm",
      "chainId": "evm:84532",
      "rpcUrl": "https://base-sepolia-rpc.publicnode.com",
      "registryAddress": "0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5",
      "tokenAddress": "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce",
      "tokenNetworkAddress": "0xe9E05dfecfe165266C88d73e61D483612651952a",
      "channelDeposit": "50000000"
    },
    {
      "chainType": "solana",
      "chainId": "solana:devnet",
      "rpcUrl": "https://api.devnet.solana.com",
      "programId": "2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip",
      "tokenMint": "34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU",
      "channelDeposit": "50000000"
    }
  ],
  "relay": {
    "readUrl": "wss://relay-ws.devnet.toonprotocol.dev",
    "connectorUrl": "https://proxy.relay.devnet.toonprotocol.dev/ilp",
    "transport": "btp",
    "payChain": "evm",
    "deposit": "1000000"
  },
  "order": { "fill": { "min": "1000", "max": "10000000" } },
  "statePath": "./state/maker-state.json"
}
```

The maker in this example sells USDC on Base Sepolia for USDC on Solana devnet, so it needs
**Solana** USDC to pay out with (its `inventory`) and gas on both chains. Fund its addresses the
same way you funded the taker's — `toon-swap make` prints them at startup.

```sh
SWAP_AUTOGEN_IDENTITY=1 toon-swap make --config maker.config.json
```

> [!IMPORTANT]
> Give the maker its **own `statePath`** (and so its own identity). A maker and a taker sharing
> one state file are the same party, and a party cannot trade with itself.

| Key | What it does |
| --- | --- |
| `swapPairs` | What you sell, in which direction, at what indicative rate. |
| `inventory` | How much target-chain capital you will issue claims against, in base units. |
| `chainProviders[].channelDeposit` | Lets the maker open and fund its side of a channel with each taker **on demand**, at that taker's first verified fill, and top it up later. Without it, channels must be pre-opened under `channels`. |
| `order.fill.min` / `max` | The smallest and largest fill a taker may send. The floor is what stops anyone making you sign thousands of near-zero claims. |
| `relay` | Where orders and messages go. **Without `relay.connectorUrl` the maker boots offline** — health and admin only, no orders, no fills — and says so loudly. |
| `statePath` | Everything that must survive a restart: inventory, channel watermarks, sessions, orders. |

`GET /health` on `appPort` (default 8080) shows the relay loop, published orders and per-taker
watermarks. Full key list and operational detail:
[deploy/swap/README.md](https://github.com/toon-protocol/swap/blob/main/deploy/swap/README.md).

# Choosing δ

δ (`--delta`) is the size of one fill, and it is the only number you really tune. It sets three
things at once. **Small δ: safer, more expensive, slower. Large δ: riskier, cheaper, faster.**

| For a swap of size S, with N = ⌈S/δ⌉ fills | |
| --- | --- |
| **Exposure** | δ — the most you can lose if the maker stops mid-stream: one fill. |
| **Relay cost** | (2N + 3) µUSDC — two writes per fill, three per swap, 1 µUSDC each. |
| **Time** | ≈ N × 0.37 s — about 350 ms per fill on the devnet, whatever δ is. |

**Sensible default on the devnet: δ between 1 000 and 10 000 µUSDC** (0.001–0.01 USDC). That
keeps relay cost under 0.25 % and puts a 1 USDC swap between 40 s and 6 min. The measurements and
the reasoning behind them are in
[docs/how-it-works.md](https://github.com/toon-protocol/swap/blob/main/docs/how-it-works.md#the-lever-δ).

# CLI reference

Every command takes `--config <path>` (default `./swap.config.json`). Commands after `take` take
`--stream <streamNonce>`.

| Command | Does |
| --- | --- |
| `toon-swap make` | Run a maker: publish orders, answer fills. (Also the default when no command is given.) |
| `toon-swap orders [--json]` | List live orders on the relay. |
| `toon-swap take --order <maker>:<orderId> --size <units> [--delta <units>] [--recipient <addr>] [--json]` | Accept an order and stream the fills. |
| `toon-swap sessions [--json]` | Your sessions, their status, and channel watermarks. |
| `toon-swap resume --stream <nonce> [--json]` | Continue a session from disk after a stop, crash or lost answer. |
| `toon-swap redeem --stream <nonce> [--via own\|gas-station] [--no-fallback]` | Redeem the newest claim on chain. |
| `toon-swap close --stream <nonce>` | Solana only: start the channel's challenge window. |
| `toon-swap settle --stream <nonce>` | Solana only: pay out after the window closes. |

> [!NOTE]
> `--via gas-station` asks a gas station to pay the redemption fee instead of you. It falls back
> to your own gas unless you pass `--no-fallback`. **Gas stations do not accept swap claims yet**
> ([gas-station#18](https://github.com/toon-protocol/gas-station/issues/18)) — until they do,
> redeem with your own gas.

### Environment variables

These override the config file: `SWAP_MNEMONIC`, `SWAP_AUTOGEN_IDENTITY`, `SWAP_IDENTITY_FILE`,
`SWAP_STATE_PATH`, `SWAP_RELAY_READ_URL`, `SWAP_RELAY_CONNECTOR_URL`, `SWAP_RELAY_PAY_CHAIN`,
`SWAP_FILL_MIN`, `SWAP_FILL_MAX`, `SWAP_APP_PORT`, `SWAP_LOG_LEVEL`.

# What each side verifies

Nobody verifies for you, and no server sits in the middle. Before a claim counts, the party
receiving it checks:

- **the signature**, against the counterparty bound when the session opened — before any chain read;
- **the channel**, re-derived from the two participants, never taken from the message;
- **the money**: the claim's total is above the last accepted total by at least the fill, and the
  counterparty's on-chain deposit covers it. Chain reads are cached and budgeted per counterparty.

The relay's connector only checks that each write was paid for. It never opens a message, and
never sees a swap claim.

# State, resume and safety

- The taker keeps `<statePath minus .json>.taker.json`: every session, plus one watermark per
  channel so it can never sign a claim below one it already sent. **A fill is written to disk
  before it is published.**
- The maker keeps `statePath`: inventory, channel watermarks, sessions, per-taker inbound
  watermarks, the relay cursor and its published orders.
- After any stop, `toon-swap resume --stream <nonce>` re-quotes, reads what the relay kept, and
  continues. A re-sent fill gets the same answer; a lost state file is re-synced from the maker's
  refusal.

Your money is never in a message that can be replayed — only in the newest claim, which you
redeem once.

# Learn more

| | |
| --- | --- |
| **How it works** — the full sequence, and the δ lever | [docs/how-it-works.md](https://github.com/toon-protocol/swap/blob/main/docs/how-it-works.md) |
| Why the swap is relay-mediated (design record) | [docs/relay-swap.md](https://github.com/toon-protocol/swap/blob/main/docs/relay-swap.md) |
| Operator & config reference | [deploy/swap/README.md](https://github.com/toon-protocol/swap/blob/main/deploy/swap/README.md) |
| Changelog | [CHANGELOG.md](https://github.com/toon-protocol/swap/blob/main/packages/swap/CHANGELOG.md) |

# Develop

```sh
pnpm --filter @toon-protocol/swap test        # unit: in-memory relay, real signatures
pnpm --filter @toon-protocol/swap test:e2e    # real relay + connector + anvil + solana-test-validator
```

`test:e2e` is the fastest way to watch a complete swap without funding anything: it swaps
EVM→Solana and Solana→EVM through a real relay and redeems every claim on chain, in about a
minute. It needs `anvil`, `solana-test-validator`, `solana`, `spl-token` and `solana-keygen` on
PATH, plus a connector — `SWAP_E2E_CONNECTOR_IMAGE=ghcr.io/toon-protocol/connector:rust-sha-…`
(run with docker) or `SWAP_E2E_CONNECTOR_BIN`. See
[tests/e2e/README.md](https://github.com/toon-protocol/swap/blob/main/packages/swap/tests/e2e/README.md).
