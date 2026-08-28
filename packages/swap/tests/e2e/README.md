# End-to-end: the maker behind a real Rust connector

```sh
pnpm --filter @toon-protocol/swap test:e2e
```

Two suites, each booting its own infra in `beforeAll` (no global setup):

| suite | what it proves |
| --- | --- |
| `rust-connector-swap.e2e.test.ts` (9) | **The swap.** anvil + `solana-test-validator` + the `connector` binary/image settling with the **maker's own keys** (one key) + `startSwapNode()` in-process. A taker opens one channel per chain to the maker, RFQs, pays 3 fills on chain A through the connector's client edge; the maker deposits its side of that same channel on demand (and tops up for fill 3); the taker verifies each cumulative leg-B claim and redeems on chain B (`claimFromChannel` on the `TokenNetwork`, +3 USDC; `ClaimFromChannel` recorded on the Solana PDA) — **EVM→Solana and Solana→EVM**. Also: an unpaid fill is HTTP 402 at the edge, a replayed leg-A claim is refused before the maker is asked, and the maker recycles capacity from chain truth after the redemption. |
| `taker-toolkit.selfcheck.test.ts` (12) | The taker toolkit against the connector alone: wire-vector replays, sealed requests (free / EVM claim / Solana claim / replay / unpaid), and leg-B settlement on both chains. |

## Requirements

- `anvil` (foundry), `solana-test-validator`, `solana`, `spl-token`, `solana-keygen` on PATH.
- A Rust connector, one of:
  - `SWAP_E2E_CONNECTOR_BIN` — a built binary (default `/home/jonathan/Documents/connector/target/debug/connector` if present);
  - `SWAP_E2E_CONNECTOR_IMAGE` — a published `ghcr.io/toon-protocol/connector:rust-sha-…` tag, run with `docker run --rm --network host` (what CI does).

Ports are fixed in `helpers/topology.ts` (anvil 18545, validator 18899, connector client edge
18300, maker app 18310). `helpers/rust-connector.ts` refuses to start when 18300 already answers
`GET /ilp/identity` — a stale container from an aborted run is the usual cause.

## The taker (`helpers/`)

What `toon-client` will do, written against the connector's normative wire vectors
(`fixtures/connector-vectors/wire-vectors.json`). See `helpers/README-taker-toolkit.md` for each
module and every gotcha met getting it green (Solana `ClaimFromChannel` moves no tokens — payout is
close → settle; the "claimer" is the payer; unpaid → HTTP 402 not `F06`; …).

## Fixtures

- `fixtures/evm/*.json` — trimmed forge artifacts (`{abi, bytecode}`) of the connector's contracts.
- `fixtures/solana/payment_channel.so` — the connector's payment-channel program, vendored; size and
  sha256 asserted at boot (`helpers/solana-validator.ts`).
- `fixtures/connector-vectors/wire-vectors.json` — verbatim copy of the connector's vectors.

Each fixture README records the source commit.
