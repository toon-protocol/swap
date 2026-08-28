# Taker-side test toolkit (Rust-connector maker)

Helpers for exercising a swap end to end against the **new** maker topology:
the maker is an HTTP app behind a `[[routes]]` termination of a
[toon-protocol/connector](https://github.com/toon-protocol/connector) Rust
connector. The taker pays **leg A** by POSTing a sealed ILP PREPARE with a
payment-channel claim to the connector's client edge; the connector verifies
the claim against the chain, delivers HTTP to the app with
`X-TOON-Payer`/`X-TOON-Amount`/`X-TOON-Chain`, and seals the app's response
into the FULFILL. The taker then redeems the maker's **leg-B** claim on the
target chain. EVM (anvil) and Solana (`solana-test-validator`) both work in
both roles.

Normative sources (in the connector repo): `docs/protocol/client-edge-spec.md`
§1.1/§1.3/§1.4/§1.7/§1.8, `vectors/wire-vectors.json` (+ `vectors/README.md`),
`docs/protocol/configuration-spec.md`, `packages/contracts/src/*.sol`,
`packages/solana-program/src/*.rs`, `crates/connector-settlement-solana/src/wire.rs`,
`crates/connector-signer/src/claim_signature.rs`, ADR 0053, ADR 0059, ADR 0063.

## Run the self-check

```sh
pnpm --filter @toon-protocol/swap exec vitest run \
  --config vitest.e2e.config.ts tests/e2e/taker-toolkit.selfcheck.test.ts
```

Needs `anvil`, `solana-test-validator`, `solana`, `spl-token`, `solana-keygen`
on PATH, and a connector:

| env | meaning |
| --- | --- |
| `SWAP_E2E_CONNECTOR_BIN` | path to a built `connector` binary (default `/home/jonathan/Documents/connector/target/debug/connector`) |
| `SWAP_E2E_CONNECTOR_IMAGE` | a published image, e.g. `ghcr.io/toon-protocol/connector:rust-2026.08.28.1`; runs `docker run --rm --network host`. Wins over the binary when set. |

Every e2e suite boots its own infra in `beforeAll`; typecheck the tree with
`pnpm --filter @toon-protocol/swap exec tsc --noEmit -p tests/e2e/tsconfig.json`.

The self-check (12 tests, ~25 s) does: replay the wire vectors offline → anvil
+ deploy → validator + mint → fund the connector's EVM key and Solana seed →
boot the connector with BOTH settlement backends and two routes (`g.test.app`
priced 1 USDC, `g.test.app.free` priced 0) in front of a `node:http` recorder →
taker opens a `TokenNetwork` channel and a Solana channel to the connector as
depositor → (a) free FULFILL with no `X-TOON-*`, (b)(c) EVM claims nonce 1/2,
(c2) replayed nonce → `F01`, (d) Solana claim, (e) unpaid → HTTP 402, (f)
`RollingSwapChannel.updateBalance` with an `EvmPaymentChannelSigner` v2 claim,
(g) Solana `ClaimFromChannel` + close + settle.

## Modules

### `rust-connector.ts` — `startRustConnector(opts)`

Writes `connector.toml` + one-line-hex key files into a temp dir, spawns the
binary (`connector <config>`) or the image, waits for `GET /ilp/identity`, and
returns `{ url, identity: {keyId, publicKey}, describe(), stop(), logPath,
configPath, logTail() }`. A boot failure throws with the log tail — the
connector explains its refusals in there.

- `evm.registryAddress` is the **TokenNetworkRegistry**. Naming a TokenNetwork
  makes the node refuse to start (it has no `getTokenNetwork`).
- `evm.settlementKeyHex` needs ETH (`fundEth`); `solana.settlementSeedHex`
  needs SOL (`airdropSol`) **before** boot — `connect` creates the node's own
  ATA and simulates a probe instruction.
- `decimals` (default 6) is checked against the token's `decimals()` at boot.
- `stateDir` is required (chain-resolved claims need durable watermarks).
- `routes[].handlerUrl` — keep the **trailing slash**; the envelope `target`
  (`"/"`) is resolved beneath the handler path (ADR 0025), so
  `http://127.0.0.1:18310/paid/` + `/` → the app sees `/paid/`.
- Docker mode mounts the temp dir at `/app/data` (ro) and `stateDir` at
  `/app/state`, chmods for uid 10001, and rewrites the paths in the TOML.

### `evm-chain.ts` (viem)

| fn | does |
| --- | --- |
| `startFreshAnvil({port, chainId})` | plain anvil, no state blob |
| `deployEvmContracts(rpcUrl)` | replays `DeployLocal.s.sol` from account 0; returns `{usdc, registry, tokenNetwork, rollingSwapChannel, chainId}` |
| `fundEth`, `mintUsdc`, `erc20Balance`, `evmAddressOf` | plumbing (MockERC20's `mint` is ungated) |
| `deriveEvmChannelId(a, b, epoch)` / `readChannelEpoch` | ADR 0059: `keccak256(abi.encodePacked(min, max, channelEpoch[min][max]))` |
| `openTakerEvmChannel({...})` | `openChannel(counterparty, timeout)` (asserts the emitted id equals the derived one) then `approve` + `setTotalDeposit(id, taker, deposit)` — the taker is the depositor |
| `signEvmClientClaim({...})` | spec §1.3 `evm` claim; EIP-712 `TokenNetwork`/`1` `BalanceProof`, cumulative amount, `lockedAmount:'0'`, zero `locksRoot` |
| `evmClientClaimDigest`, `recoverEvmClientClaimSigner` | vector checks |
| `openMakerRollingChannel({...})` | `approve` + `RollingSwapChannel.openChannel(channelId, signer, deposit)` from the funder |
| `settleRollingSwapChannel({...})` | `updateBalance(channelId, cumulative, nonce, recipient, sig)` — anyone may submit; returns the `SettlementSucceeded` args |
| `rollingClaimDigestOnChain` | the contract's `claimDigest` view |

### `solana-chain.ts` (@solana/web3.js)

Hand-rolled client for `payment_channel.so` (native Rust, no IDL):
`initializeChannelIx`, `depositIx`, `ed25519VerifyIx`, `claimFromChannelIx`,
`closeChannelIx`, `settleChannelIx`, plus PDAs (`deriveSolanaChannelPda`,
`deriveSolanaVaultPda`, `associatedTokenAddress`) and `decodeSolanaChannel`
(the 178-byte `pchannel` layout).

| fn | does |
| --- | --- |
| `solanaBalanceProofMessage96({programId, channelAccount, nonce, transferredAmount})` | ADR 0053 bytes |
| `signSolanaBalanceProof(seed, …)` / `signSolanaClientClaim({seed, …})` | 64-byte ed25519 sig; spec §1.3 `solana` claim (`signature` base64, `signerPublicKey` base58) |
| `openSolanaChannelAsDepositor({depositorSeed, counterparty, amount, challengeDurationSeconds?})` | `InitializeChannel` (payer = depositor) + `Deposit`; idempotent on the open |
| `claimFromSolanaChannel({feePayerSeed, claimer, nonce, transferredAmount, signature})` | ed25519 precompile at ix 0 + `ClaimFromChannel` |
| `closeSolanaChannel`, `settleSolanaChannel` | the two steps that actually move tokens |
| `airdropSol`, `mintUsdcTo`, `splBalance`, `readSolanaChannel` | plumbing |

Confirmation is by polling `getSignatureStatuses`, never `confirmTransaction`
(see gotchas).

### `taker-edge.ts`

`sendSealedRequest({connectorUrl, connectorPublicKey, destination, amount,
envelope, claim?, expiresInMs?})` → one of

- `{kind:'fulfill', response:{status, headers, body}, fulfillment}` — the app's
  answer, opened with the exchange's own secret; the FULFILL preimage is
  checked against the condition we minted;
- `{kind:'reject', code, message, triggeredBy, data, accumulatedCost, origin}`
  — `origin` is `destination` when the reject was sealed with our secret, else
  `path` (§1.8);
- `{kind:'payment-required', status:402, terms}` — an unpaid request to a
  priced route (§1.4). **Not** an ILP REJECT: the edge answers HTTP 402 with
  x402 v2 JSON before routing;
- `{kind:'http-error', status, body}`.

Also `describeConnector(url)` (`GET /ilp/identity`), `connectorRoutePrice`,
and the codec (`encodeIlpPrepare`, `decodeIlpPacket`, `decodeIlpPrepare`).
Sealing is `@toon-protocol/client`'s `sealExchange`/`readExchangeOutcome`
(verified live: the connector opened every wrap). The PREPARE encoder is
hand-rolled from the client's OER primitives and checked byte-for-byte against
`peer_carriage.prepare.http_body_hex`.

### `topology.ts` additions

`MAKER_CONNECTOR_CLIENT_EDGE_PORT = 18300`, `MAKER_APP_PORT = 18310` (+ URLs).

### Fixtures

- `fixtures/evm/*.json` — trimmed forge artifacts (`{abi, bytecode}`), README
  has the source commit.
- `fixtures/connector-vectors/wire-vectors.json` — verbatim copy of the
  connector's normative vectors (schema 4).
- `fixtures/solana/payment_channel.so` — refreshed to connector
  `d4b1511e` (109,400 bytes, sha256 `ae2e9148…`); constants updated in
  `solana-validator.ts` and the table in `fixtures/solana/README.md`.
  `provisionSplMint` / `openSolanaChannels` there still work against it.

## Gotchas hit while getting this green

1. **`ClaimFromChannel` moves no tokens.** It only records
   `(nonce, transferred_amount)` in the *claimer's* slot. Value leaves the vault
   at `SettleChannel`/`ForceCloseExpired`: `A gets deposit_a - transferred_a +
   transferred_b`. A Solana leg-B payout is therefore claim → `CloseChannel`
   (any participant) → wait `challenge_duration` → `SettleChannel` (anyone).
   The self-check opens the leg-B channel with `challenge_duration = 0` so it
   can settle in the same run (the program does not floor it; the taker-facing
   leg-A channel uses 3600 s). On EVM `updateBalance` pays immediately.
2. **"claimer" = the PAYER.** In `process_claim_from_channel` the ed25519
   precompile's pubkey must equal the `claimer` account or the program returns
   `UnauthorizedSigner`, and the amount is bounded by the claimer's own
   deposit. Submitting with `claimer = recipient` is the wrong way round. The
   fee payer can be anyone (the taker, in the self-check).
3. **Unpaid request to a priced route is HTTP 402, not `F06`.** The connector
   answers x402 v2 terms (`accepts[0].scheme = 'toon-channel'`,
   `accepts[0].amount = <price>`) before routing; no OER body. The app is not
   called. A replayed nonce, by contrast, is an OER REJECT:
   `F01 "claim rejected: nonce does not advance this channel's watermark
   (replay)"`, origin `path`, `TOON-Accumulated-Cost: 0`.
4. **`X-TOON-Payer` is the *channel* key, not the signer:**
   `evm:0x<64 lower-case hex channelId>` / `solana:<channelAccount base58>`.
5. **Solana participant sort is by the 32 bytes**, not the base58 text
   (`sortSolanaParticipants`). Sorting strings derives a valid-looking wrong
   PDA.
6. **The vector's EVM signature `v` is libsecp256k1's raw `{0,1}`**
   (`claim_evm.signature` ends `…00`); viem's recover wants `{27,28}`. The
   connector accepts either; the self-check normalises before recovering.
7. **`@solana/web3.js` `confirmTransaction` opens a websocket** on
   `<rpc port>+1` and keeps reconnecting after the validator stops, printing
   `ws error: connect ECONNREFUSED 127.0.0.1:18900` during teardown. The
   helpers poll `getSignatureStatuses` instead.
8. **`PREPARE.amount` is not what is charged** on a terminated route — the
   claim's cumulative advance against the route `price` is (§1.3 step 3). The
   connector's own e2e test sends `amount: 0`; the self-check sends the price.
9. **Key files:** the connector accepts 32 raw bytes or 64 hex chars; the
   helper writes hex, one line, mode 0644 (the image reads them as uid 10001
   from a read-only mount; `mkdtemp` dirs are 0700 and must be relaxed).
10. `tests/e2e/tsconfig.json` includes `**/*.ts`, so a full `tsc -p
    tests/e2e/tsconfig.json` also reports the legacy suites' breakage against
    the in-progress `src/` rewrite. The toolkit files themselves are clean;
    use `tests/e2e/tsconfig.json`.
