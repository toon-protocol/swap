# End-to-end: the swap through a real relay

```sh
pnpm --filter @toon-protocol/swap test:e2e
```

Two suites, each booting its own infra in `beforeAll` (no global setup):

| suite | what it proves |
| --- | --- |
| `relay-swap.e2e.test.ts` (5) | **The swap.** anvil + `solana-test-validator` + a real relay (`@toon-protocol/relay`) + the `connector` binary/image fronting it (`g.toon.relay`, price 1, settling on anvil) + `startSwapNode()` and `createTakerRuntime()` in-process. The maker publishes one order per pair; a taker reads them, accepts, streams fills (each leg-A claim verified by the maker, each leg-B advance verified by the taker), the maker deposits its side of the pair channel on demand, and the taker is paid **on chain** — Solana `ClaimFromChannel` → `CloseChannel` → `SettleChannel` (+2.97 USDC to its ATA), EVM `claimFromChannel` (+2 USDC). Also: a taker that stops before reading an answer resumes from disk through the relay's history, and a maker restarted from its state file continues the stream at the right leg-B nonce. |
| `taker-toolkit.selfcheck.test.ts` (12) | The ILP taker toolkit against the connector alone: wire-vector replays, sealed requests (free / EVM claim / Solana claim / replay / unpaid), and settlement on both chains. |

## Requirements

- `anvil` (foundry), `solana-test-validator`, `solana`, `spl-token`, `solana-keygen` on PATH.
- The relay: `@toon-protocol/relay` (a devDependency; `better-sqlite3` ships prebuilt binaries),
  or `SWAP_E2E_RELAY_BIN` pointing at a built `relay` cli.
- A Rust connector, one of:
  - `SWAP_E2E_CONNECTOR_BIN` — a built binary (default `/home/jonathan/Documents/connector/target/debug/connector` if present);
  - `SWAP_E2E_CONNECTOR_IMAGE` — a published `ghcr.io/toon-protocol/connector:rust-sha-…` tag, run with `docker run --rm --network host` (what CI does).

Ports are fixed in `helpers/topology.ts` (anvil 18545, validator 18899, relay ws 18901 / write
18903, relay connector 18300, maker health 18310). `helpers/rust-connector.ts` refuses to start
when 18300 already answers `GET /ilp/identity` — a stale container from an aborted run is the
usual cause; `helpers/relay.ts` does the same for 18903.

## Against the devnet

The same code runs against TOON's live devnet — `wss://relay-ws.devnet.toonprotocol.dev` and
`https://proxy.relay.devnet.toonprotocol.dev/ilp` — with `toon-swap make` / `toon-swap take`;
that is the dev loop, not a CI job (it needs funded keys on Base Sepolia and Solana devnet).

## Fixtures

- `fixtures/evm/*.json` — trimmed forge artifacts (`{abi, bytecode}`) of the connector's contracts.
- `fixtures/solana/payment_channel.so` — the connector's payment-channel program, vendored; size and
  sha256 asserted at boot (`helpers/solana-validator.ts`).
- `fixtures/connector-vectors/wire-vectors.json` — verbatim copy of the connector's vectors.

Each fixture README records the source commit.
