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
