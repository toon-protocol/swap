---
'@toon-protocol/swap': major
---

**The maker is an app behind a Rust connector.** `@toon-protocol/swap` no longer embeds,
dials or configures a connector; the retired `@toon-protocol/connector` 3.x `ConnectorNode`
dependency is gone. A Rust connector terminates two routes at the maker — a free
`<ilpAddress>.rfq` → `POST /swap/rfq` and a priced `<ilpAddress>` → `POST /swap/fill` — verifies
the taker's leg-A claim itself, and delivers the fill with `X-TOON-Payer` / `X-TOON-Amount` /
`X-TOON-Chain` (connector ADR 0040). The maker's cumulative leg-B balance proof rides back in
the HTTP response, sealed into the FULFILL. This is the `rolling/2` wire (`src/wire.ts`,
exported); `rolling/1`'s gift-wrapped RFQ and condition-coupled leg-B PREPARE cannot exist on
the Rust connector (PF-01, ADR 0019, no parent/child peering) and are removed along with
`RollingSwapEngine`, `createRollingRfqIntake`, `createLegBReturnRouteBinder`,
`createConnectorLegBSender`, `withMaxRateAge`, the `createSwapHandler` re-export and the
`Publisher`/kind:10032 publish. See `docs/rust-connector-migration.md`.

- **Config:** connector/announce keys (`btpServerPort`, `btpEndpoint`, `relayUrls`,
  `connectorUrl`, `parentPeerId`, `parentAuthToken`, `parentEvmAddress`, `nodeId`,
  `knownPeers`, `transport`, `advertisedAsset`, `peerInfo*`, `rolling.*`, `settlementPrivateKey`)
  are accepted and ignored with a boot warning, so a committed 2.x config boots. New:
  `fillAmount`, `quote.{ttlMs,sessionTtlMs,maxSessions}`, `appPort` (alias `blsPort`, default
  8080), env `SWAP_APP_PORT` / `SWAP_ILP_ADDRESS` / `SWAP_FILL_AMOUNT`. Solana
  `chainProviders[]` entries now require `programId` and `tokenMint`; EVM entries no longer
  require `tokenNetworkAddress`. `relayUrls` is no longer required.
- **Leg B rides the normal channels, one per taker, opened by the maker on demand.** The
  `RollingSwapChannel` is no longer used: its single per-channel watermark with a
  recipient-per-claim let a maker void a taker's claim by redeeming a later one to another
  address. Leg B now signs the fleet's `TokenNetwork`/`1` `BalanceProof`
  (`TokenNetworkBalanceProofSigner`) on the (maker, taker) `TokenNetwork` channel, and the
  Solana program's proof on the (maker, taker, mint) PDA; both have per-participant watermarks
  and on-chain collateral checks. With `chainProviders[].channelDeposit` set, the maker opens
  the channel (if the taker has not) and deposits its side at the taker's first paid fill, tops
  up when a claim would exceed the deposit, and seeds its watermark from chain
  (`createEvmLegBChannelProvisioner`, `createSolanaLegBChannelProvisioner`,
  `MakerEngineConfig.ensureChannel`). The maker's connector should settle with the maker's
  index-2 keys so one channel per taker per chain carries both legs. EVM `chainProviders[]`
  require `tokenNetworkAddress` again; `channelAddress` is accepted and ignored; `channels`
  may be empty when `channelDeposit` is set. The EVM chain-truth reader now reads
  `TokenNetwork.participants(channelId, maker)` (`EvmChannelReaderProvider` takes
  `tokenNetworkAddress` + `makerAddress`). `viem` and `@solana/web3.js` become runtime
  dependencies.
- **Solana claims** sign the 96-byte `TOON-BALPROOF-V2` message that binds the program id
  (connector ADR 0053) — `SolanaPaymentChannelSigner` takes `programId`,
  `solanaBalanceProofMessage(programId, channelId, nonce, amount)`. The 48-byte form 2.x signed
  is not a prefix of it and is unredeemable on the current program.
- **Solana leg-B channels** are resolved by the participants' PDA (ADR 0059) rather than
  "first unbound": `ReserveParams.preferredChannelId` / `IssueRollingClaimParams.preferredChannelId`,
  `deriveSolanaChannelPda`. An unprovisioned PDA is refused `no_channel_available` naming it.
- **Inventory** (swap#130): a configured pool `total` above the persisted snapshot raises the
  pool instead of being silently ignored.
- **API:** `SwapNodeInstance` gains `appPort`, `ilpAddress`, `rfqDestination`,
  `fillDestination`, `engine`; loses `connector`, `registerRollingSession`, `_rollingEngine`.
  `SwapNodeHealthResponse` gains `ilpAddress`, `rfqDestination`, `fillDestination`, `legB`,
  `sessions`. New exports: `MakerEngine`, `registerMakerRoutes`, the `rolling/2` types and
  parsers, `readPaymentAttribution`, `deriveSolanaChannelPda`.
- **Tests:** the connector-era Docker/integration suites are replaced by
  `tests/e2e/rust-connector-swap.e2e.test.ts`, which drives EVM→Solana and Solana→EVM swaps
  through a real Rust connector against anvil + `solana-test-validator` and redeems every
  leg-B claim on chain; `tests/e2e/helpers` is the reference `rolling/2` taker.
