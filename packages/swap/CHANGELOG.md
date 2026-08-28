# @toon-protocol/swap

## 3.0.1

### Patch Changes

- 53fb94e: The README is now a guide (what this is, try it on the devnet in 60 seconds, run a maker,
  choose δ, CLI reference, what is verified, state & resume), and `docs/how-it-works.md`
  explains the swap sequence and the δ lever in plain language, with the devnet measurements.
  A maker config may now omit `channels` for a chain whose `chainProviders[].channelDeposit`
  opens channels on demand (previously that was refused as `INVALID_CONFIG`).

## 3.0.0

### Major Changes

- 9451a21: The swap node now signs the v2 EIP-712 domain-separated balance-proof digest (via `@toon-protocol/settlement-digest`) instead of the v1 raw-packed digest, so claims recover correctly against the v2 verifiers across the ecosystem (client, sdk, connector and the on-chain `RollingSwapChannel`). Verifiers still on the v1 raw-packed digest — including the `@toon-protocol/sdk` 2.x pinned here — will NOT recover these claims; those repos migrate separately. `SwapNodeEvmChainProvider` gains a required `channelAddress` field (the deployed `RollingSwapChannel` address); a swap pair targeting an EVM chain with no matching `chainProviders` entry now refuses to boot instead of issuing unverifiable claims.
- e18d4dc: The swap node's kind:10032 `tokenNetworks` map now advertises **leg A** — the deployed `TokenNetwork` a client calls `openChannel(address participant2, uint256 settlementTimeout)` on to open the payment channel it pays this maker over — sourced from a new required `chainProviders[].tokenNetworkAddress`. The maker's own `RollingSwapChannel` (`chainProviders[].channelAddress`) moves to its own announce key, `swapVerifyingContracts`, which is **leg B**: the EIP-712 `verifyingContract` its v2 balance-proof claims are signed under.

  Previously `tokenNetworks` carried the `RollingSwapChannel`. `tokenNetworks` is the field a stock client reads to open leg A, and `RollingSwapChannel.openChannel(bytes32,address,uint256)` is a different ABI, so the client's lazy `ensureChannel` reverted and the swap threw before a packet was ever sent — with no diagnostic. `tokenNetworkAddress` is required with no default (an EVM chain a `swapPair` targets refuses to boot without it) rather than silently defaulting to `channelAddress` and reintroducing the invisible failure.

- b7238a4: **A swap refusal is now logged and actionable, and a failed swap no longer leaks inventory.**

  Two defects that together turned a mundane live condition into a multi-hour outage diagnosis.

  **1 — the rejection that logged nothing.** After one successful swap the maker refused every subsequent swap with `T00 Internal error` and wrote not a single line. Two causes, both fixed:
  - `cli.ts` — the entrypoint the published image runs — never supplied `config.logger`, so `startSwapNode()` installed its no-op default and _every_ log statement in the swap node **and** in the SDK swap handler was a no-op. The CLI now installs a JSON-line console logger (`createConsoleLogger()`), verbosity via the optional `SWAP_LOG_LEVEL` env var (`debug|info|warn|error|silent`, default `info`). No new config key, and no new _required_ anything.
  - The SDK swap handler collapses everything except `INSUFFICIENT_INVENTORY` into `ctx.reject('T00', 'Internal error')`, discarding a perfectly good diagnosis. `claim-refusal.ts` now classifies what the claim issuer threw, logs it at warn/error, and replaces that blanket T00 on the wire:
    - unredeemed channel → **T04** / `insufficient_funds`, `channel_unredeemed: the maker's payment channel <id> on <chain> still has <n> unredeemed unit(s); redeem or settle the previous claim before swapping again`
    - no channel provisioned for the sender → **F99** / `application_error`, `no_channel_available: …`
    - persist / signing / encrypt failures stay T-class but say which one they are.

    Every refusal also carries base64-JSON reject `data` whose `reason` field is the machine discriminator, matching the `stale_rate` and rolling-engine reject contracts. The rolling coupled-leg path had the same silent-`T00` collapse and gets the same treatment.

  **2 — a failed swap leaked inventory.** `issueClaim()`'s rollback called `SwapInventory.credit()`, the operator-refill primitive (`available += n` **and** `total += n`), to undo a `debit()` (`available -= n`). So `total` — what the maker advertises in kind:10032 and reports on `/health` — ratcheted upward on every failure (observed live: 15 001 000 against a configured 15 000 000). The unwind now uses a new `SwapInventory.refundDebit()`, the exact inverse of `debit`. A failed issuance is byte-identical on both buckets.

  Still owed upstream: the SDK's `swap_handler.encrypt_failed` branch discards its error object entirely, so this package can only _infer_ that path (claim issued, then a blanket T00) and name it. Surfacing the real error belongs in `@toon-protocol/sdk`'s `swap-handler.ts`.

- e581701: `@toon-protocol/swap` drops the legacy claim-in-FULFILL public API (toon-meta#411 Stage 6). The
  maker itself already stopped serving this protocol (swap#154); this removes the now-dead exports
  so a published 3.0.0 no longer promises them.

  Removed from the public API:
  - `createSwapHandler` / `CreateSwapHandlerConfig` (the `@toon-protocol/sdk` re-export)
  - `withMaxRateAge` / `WithMaxRateAgeOptions` (the legacy handler's staleness-gate decorator)
  - `MultiChainClaimIssuer.issueClaim` (the legacy gift-wrap issuance entrypoint)
  - `SwapInventory.debit` / `.refundDebit` (the permanent-debit accounting the legacy path used —
    a honeypot sized to notional with no refill loop, per swap#138/#141). `SwapInventory.credit`
    goes `private` in the same move: it is now reachable only through
    `creditCorroboratedFunding()`, so no caller can raise `total` without chain corroboration.

  No throwing compatibility shim replaces any of these — a caller gets a missing export (or, for
  the removed methods, a type error) at build time, not a runtime surprise later.

  **What survives, unchanged in shape:** `MultiChainClaimIssuer` remains the leg-B claim signer
  (`issueRollingClaim` / `commitRollingClaim` / `rollbackRollingClaim`, its per-chain signers and
  wallet) and `SwapInventory` remains the rolling window's capital (`reserve` / `commitReservation`
  / `releaseReservation` / `recordChainRedemption` / `creditCorroboratedFunding`). Neither class nor
  its rolling-path methods changed.

  **Migration:** `createSwapHandler` had exactly one job — issue a claim from pre-funded inventory
  on receipt of a legacy gift-wrap — and there is no rolling equivalent to point a caller at, because
  rolling is not a handler you install onto a connector; it is a maker you run. The supported way to
  run a maker, on any protocol this package still serves, is `startSwapNode()`.

- 7493386: The maker's Solana balance proofs are now REDEEMABLE (swap#164, toon#214).

  `SolanaPaymentChannelSigner` signed `balanceProofHashSolana` —
  `sha256(utf8(channelId) || cumulativeAmount(32BE) || nonce(32BE) || utf8(recipient))`
  — which **no deployed TOON program has ever verified**. Connector's native
  `packages/solana-program` verifies an Ed25519 signature over the RAW 48 bytes
  `channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)`, compared
  byte-for-byte through the Ed25519 precompile (`processor.rs:900-910`). Every
  Solana claim this package has ever issued was therefore unredeemable, and nothing
  noticed because nothing verifies a Solana claim's signature: both Solana E2E
  suites pass `verifySignatures: false`, and the rolling driver checks the claim
  bytes' length and never their content.

  The signer now signs that 48-byte message, via a new local
  `balanceProofMessageSolana` (`src/solana-balance-proof.ts`). The helper is local
  only because this package pins the published `@toon-protocol/sdk@^3.2.0`, which
  predates the canonical `balanceProofMessageSolana` export added in toon#214; its
  header and pinned byte vectors exist so swapping it for the shared one on the next
  sdk bump is provably byte-identical.

  **Behaviour change worth knowing:** a Solana `channelId` IS its channel PDA, so the
  signer now REFUSES a `channelId` that is not 32 base58 bytes rather than signing a
  proof no chain could resolve. Synthetic Solana channel ids in callers' tests must
  become real PDAs.

  The Solana E2E suites keep `verifySignatures: false` and still do not broadcast:
  the fix to the settlement BUILDER is upstream in toon#214 and unreleased, so the
  sdk pinned here would both build an unexecutable transaction and verify against the
  digest the maker no longer signs. Their stale docblocks and README claims — one of
  which asserted the suite "submits the accumulated claim via raw Solana JSON-RPC and
  asserts an on-chain effect", which it has never done — are corrected in the same
  change.

- 256fbcd: **The swap is a relay-mediated client.** `@toon-protocol/swap` no longer embeds, dials, or sits
  behind a connector at all. Both parties are plain TOON clients: the maker publishes a public
  **order** (kind `30032`) on the relay; accept, quote, fill, advance, refusal and done are NIP-59
  gift-wrapped rumors (kind `20036`) each carrying one side's **cumulative** payment-channel claim.
  The relay stores them, so either party can go offline and resume from the last `seq`. Every
  write is an ordinary paid packet to the relay's connector (`g.toon.relay`); the connector never
  opens a wrap. This is the `rolling/3` wire (`src/wire.ts`). `rolling/1`'s coupled legs and
  `rolling/2`'s HTTP route terminations are gone; see `docs/relay-swap.md`.
  - **Each party verifies the other's claim itself** (`verifyInboundClaim`, `src/received-claim.ts`):
    signature before any chain read, channel id re-derived from the participants (ADR 0059),
    monotonic against a persisted inbound watermark seeded from chain, delta within the order's
    `fill: {min, max}`, on-chain deposit cover. Chain reads are cached and budgeted per
    counterparty (`maxChainReadsPerMin`).
  - **A swap is a stream of micro-claims.** δ is taker-chosen per fill within the order's bounds;
    the maker prices the delta that arrived. One on-chain redeem per stream.
  - **Maker:** `startSwapNode()` now takes `relay: { readUrl, connectorUrl, payChain?, deposit?, … }`,
    `order: { fill: {min, max}, ttlMs?, refreshMs? }`, `maxChainReadsPerMin?`; `chainProviders`
    must cover every `from.chain` as well as every `to.chain` (leg A needs the maker's facts there).
    `ilpAddress`, `fillAmount` and the `/swap/*` HTTP routes are gone; `GET /health` and `/admin/*`
    stay, on `node:http` (`hono` is no longer a dependency). Health gains `nostrPubkey`, `legA`,
    `relay`. Without `relay` the maker boots **offline** (engine, health, admin) and warns.
  - **Taker:** new — `SwapTaker` (`listOrders`, `accept`, `run`, `resume`, `redeem`),
    `createTakerRuntime`, `JsonFileTakerStateStore`, `createRedeemer` (EVM `claimFromChannel`;
    Solana claim/close/settle), and the CLI subcommands `toon-swap orders|take|resume|redeem|close|settle|sessions`.
  - **Relay plane:** `deriveNostrIdentity` (NIP-06 at the swap's account index), `wrapGiftWrap` /
    `unwrapGiftWrap` (NIP-59 with NIP-40 expiration and a real `created_at` on the wrap),
    `RelaySubscription` (NIP-01 reads with EOSE), `createRelayWriter` / `createRelayClient`
    (paid writes via `@toon-protocol/client` 2.1.0, now a runtime dependency).
  - **State:** schema v3 adds `sessions`, `inbound`, `relayCursor`, `orders` and renames
    `seenPacketIds` → `seenEventIds`; v1/v2 snapshots load.
  - **Config aliases so a committed fleet config boots:** `relayUrls[0]` → `relay.readUrl`,
    `connectorUrl` → `relay.connectorUrl`, `fillAmount` → `order.fill.min`. Remaining 2.x keys are
    accepted and ignored with a warning; `ilpAddress` joins them. New env:
    `SWAP_RELAY_READ_URL`, `SWAP_RELAY_CONNECTOR_URL`, `SWAP_RELAY_DESTINATION`,
    `SWAP_RELAY_PAY_CHAIN`, `SWAP_FILL_MIN` / `SWAP_FILL_MAX` (`SWAP_FILL_AMOUNT` → min).
  - **Chain side, unchanged from the previous 3.0.0 changesets:** leg B on the fleet's
    `TokenNetwork` / Solana program channel opened by the maker on demand; the 96-byte
    `TOON-BALPROOF-V2` Solana proof; PDA-resolved Solana channels; inventory raised from config.
  - **API removed:** `registerMakerRoutes`, `MAKER_RFQ_PATH`, `MAKER_FILL_PATH`, `MakerAnswer`,
    `SwapRfqRequest`, `SwapFillRequest`, `parseSwapRfqRequest`, `parseSwapFillRequest`,
    `readPaymentAttribution`, `SWAP_REFUSAL_STATUS`, `PAYMENT_HEADER_*`, `registerAdminRoutes`
    (→ `handleAdminRequest`), `SwapNodeInstance.ilpAddress/rfqDestination/fillDestination`.
  - **Tests:** `tests/e2e/relay-swap.e2e.test.ts` drives EVM→Solana and Solana→EVM swaps through a
    real relay, its Rust connector, anvil and `solana-test-validator`, redeems every leg-B claim on
    chain, and proves taker resume and maker restart; `src/maker.test.ts` does the same over an
    in-memory relay.
  - **Gasless redemption is not available yet** — the gas station excludes claims
    (toon-protocol/gas-station#18).

### Minor Changes

- 9d74cc7: The swap node's kind:10032 announce now carries a NIP-40 `["expiration", created_at + ttl]` tag and is republished on a refresh loop, instead of being published exactly once at boot with no expiry at all.

  kind:10032 is a **replaceable** event: a relay keeps the latest one per author and the only retraction path is a newer event signed by the same key. An announce with no expiration therefore outlives the node it describes, and once that key is gone it is unretractable by anyone — not the operator, not the relay's author, not a NIP-09 delete. Devnet is carrying exactly that today: `b23599a6…` / `g.toon.swap.sol`, published by this code path from a throwaway proof rig, advertising a `ws://127.0.0.1:3401` loopback literal that resolves to whatever machine reads it. Clients discover peers here — which node terminates a destination, its BTP endpoint, its settlement addresses, its swap pairs — so a dead node's announce is a routing hazard, not just clutter.

  The TTL and the refresh loop are one change, not two. This publisher had **no refresh loop of any kind**: stamping an expiry on a one-shot publish would have made a long-lived, perfectly healthy maker silently vanish from discovery one TTL after start-up — strictly worse than the litter. Each round re-signs rather than re-sends, because the tag is `created_at + ttl` and a cached event's expiry recedes into the past however often it is republished.

  Both knobs follow the fleet convention rather than inventing one: `peerInfoTtlSeconds` defaults to **600s** (the Rust connector's `[announce] ttl_secs` default, what every live devnet announce is stamped with) and `peerInfoRefreshIntervalMs` to **240s** (every `connector announce` loop overlay's `REFRESH_SECS`), leaving the same ~6 minutes of continuous headroom that was measured live for relay#137's serve-time enforcement. Both are **optional with safe defaults**, forwarded through `toon-swap --config` for operators who need to override them — no config file has to carry either key, so no `:release`-tracking deployment can crash-loop on a newly required one. Setting a non-positive TTL restores the old never-expires behaviour and logs a warning; a refresh interval that is not shorter than the TTL is reported at `error`.

- c5d1061: The swap node's kind:10032 peer-info now advertises `tokenNetworks[chain]` (the deployed `RollingSwapChannel` address, the EIP-712 `verifyingContract`) and `settlementAddresses[chain]` (the swap node's own payout address) for every chain a swap pair targets. Without this, a stock client that receives a v2-signed leg-B claim (#101) has no way to reconstruct the EIP-712 domain and rejects it with `MISSING_CHAIN_CONFIG`. Both maps are derived from the same per-chain walk that constructs the EVM signers, so the advertised chain key and contract address can never drift from the ones a claim is actually signed under.
- a528402: Bumped `@toon-protocol/sdk` from `^2.2.0` to `^3.1.8` (toon#200): released clients send EIP-55 checksummed (mixed-case) EVM `chain-recipient` addresses, and the sdk's `createSwapHandler`/`streamSwap` shared `validateChainRecipient` was lowercase-only, rejecting every such packet as `missing_or_malformed_chain_recipient` with an opaque ILP `T00 Internal error`. sdk 3.1.8 fixes this and reclassifies the reject as `F01` (permanent, self-diagnosable) instead of `T00` (transient). The swap node's own third-tier defense-in-depth check in `MultiChainClaimIssuer` (`claim-issuer.ts`, guarding direct `issueClaim`/rolling-session callers that bypass the sdk handler) carried a byte-for-byte copy of the same lowercase-only bug — fixed the same way, and now normalizes the accepted recipient to lowercase before signing/echoing it, matching the sdk's own `findChainRecipient()` behavior.
- df8e1a3: The swap node's kind:10032 peer-info now advertises `supportedChains` (every chain a swap pair targets) and `preferredTokens[chain]` (the settlement-token address/mint/id, from the same `chainProviders` entry each chain's signer/`tokenNetworks` entry already reads). Without `supportedChains`, a stock client's apex onboarding hard-refuses the maker (`addApex`: "announced no supportedChains — cannot settle") — found during the toon-meta#394 T6 devnet proof (swap#105).
- 5af4a75: The `toon-swap` CLI now accepts `peerInfoIlpDestination` / `peerInfoPricePerByte` in the JSON config file, closing the last gap in the CLI's config surface versus the proven standalone-maker wiring (`scratchpad/t6/maker.mjs`) — these fields were already supported by `startSwapNode()` but never forwarded from `packages/swap/src/cli.ts`. Also adds a runtime container image (`deploy/swap/Dockerfile`, published to `ghcr.io/toon-protocol/swap` by `.github/workflows/publish-swap-image.yml`) that boots the maker via `toon-swap --config`; see `deploy/swap/README.md` for the full config-surface reference.
- 785b117: The `toon-swap` CLI now closes two gaps blocking a fully-autonomous, self-provisioning maker deploy (toon-meta#402):
  - **Self-generated + persisted identity.** `SWAP_AUTOGEN_IDENTITY=1` (or `identityAutogen: true` in the config file), when no `mnemonic`/`secretKey` is otherwise provided, generates a fresh BIP-39 mnemonic and persists it to an identity file (default beside `statePath`, mode 600; override with `SWAP_IDENTITY_FILE`). A later boot against the same identity file loads the persisted mnemonic instead of regenerating — idempotent, since funds are tied to the identity.
  - **Auto-derived index-2 settlement key.** Whenever the resolved identity is a mnemonic and `settlementPrivateKey` is unset (or a `0xdead…`-style placeholder), the CLI derives the BIP-44 account-index-2 EVM key (`deriveSwapNodeKeys` / D12-011 — the same key `settlementAddresses` advertises and leg-B v2 EIP-712 claims are signed with) and fills `settlementPrivateKey` in. This applies to any mnemonic-based boot, not just autogenerated ones — previously the CLI had no knob to derive it at all, so a config that omitted `settlementPrivateKey` fell back to the (unrelated) Nostr identity key for the connector's claim-signing `keyId`.

  The resolved index-0 Nostr pubkey and index-2 EVM settlement address are logged once on boot (never the secret) so an operator can fund the settlement address and open its leg-B channel.

- c3cb8fe: Inventory now recycles on the legacy swap path, so a maker no longer degrades to permanently unusable. Both claim paths share ONE capital model: `issueClaim` takes an in-flight window reservation and commits it to **unsettled channel liability** instead of permanently debiting `available`, exactly as the rolling path already did. Previously a _successful_ legacy claim burned `available` for good — `recordSettlement`, the only recycler, shrank `unsettled`, which the legacy path never populated — so `available` ratcheted toward zero over the maker's lifetime and it then refused everything with T04 however faithfully its counterparties redeemed on chain.

  A new `SwapInventoryReconciler` closes the loop from chain truth: at boot and every `SWAP_RECONCILE_INTERVAL_MS` (default 60s) the node reads each provisioned channel's LIVE on-chain `cumulativePaid` through the existing `ChannelOnChainReader` and applies it via `SwapInventory.recordChainRedemption`. That call releases liability first and returns any remainder — value a pre-fix permanent debit burned — to `available`. Over-crediting is structurally impossible: the per-channel watermark is monotone (a replayed read credits nothing), only value the node itself read from the chain moves it, and `available` can never rise above `total`. A counterparty-asserted `SettlementEvent` (`SwapNodeInstance.recordSettlement`) still only releases liability and never restores `available`. Makers upgrading from the permanent-debit build heal automatically as their outstanding claims are redeemed.

  The maker also gets an operator surface on the BLS server, alongside the pre-existing lone `GET /health`: `GET /admin/inventory` (per-pool buckets, per-channel issued-vs-redeemed-on-chain, and an explicit `blockedReason` when `free` is 0), `POST /admin/inventory/reconcile`, and `POST /admin/inventory/credit` — which credits only what an on-chain redemption corroborates and refuses anything else with 409. The routes sit under `/admin` so the fleet's box nginx `^~ /admin` 404 already covers them, and the writes additionally require `SWAP_ADMIN_TOKEN` (`Authorization: Bearer` or `X-Swap-Admin-Token`, constant-time compared); with no token configured the writes are disabled, not open. Both new env vars — `SWAP_ADMIN_TOKEN` and `SWAP_RECONCILE_INTERVAL_MS` — are optional, so no `:release`-tracking deployment can crash-loop on a newly required key.

- acf6413: Chain-truth inventory recycling is no longer EVM-only. `createEvmChannelOnChainReader` was the sole `ChannelOnChainReader`, so on a Solana target chain nothing ever observed a claim's redemption: `unsettled` liability only grew, `free` walked to zero, and the maker refused every swap however faithfully its counterparty redeemed — the exact defect #138 fixed, still live for a second chain family. A new `createSolanaChannelOnChainReader` reads the channel PDA's `transferred_amount_{a,b}` straight from `getAccountInfo` (hand-decoded from the canonical 178-byte `ChannelState` layout, no Solana SDK dependency, mirroring the EVM reader's raw-`eth_call` stance), and `createChannelOnChainReader` composes the readers behind the one seam both consumers already take — so this ALSO closes the same gap in the #113 channel-rebind precondition, which was likewise EVM-only.

  The Solana channel is bidirectional, carrying one monotone cumulative per participant rather than one per channel, so the reader picks the maker's OWN slot using the node's own derived Solana address — never an operator setting, so no new config key is introduced (a required key is what crash-looped the live maker in #134). Reading the counterparty's slot would count value flowing toward the maker as redemption, so a channel this node is not a participant of throws rather than picking a side. Every other ambiguity fails closed the same way: an absent account (which is also how a settled-and-closed channel looks), an account owned by some other program, a missing `"pchannel"` discriminator, short data, or an RPC error all throw, and both consumers treat a throw as "unsafe". Nothing is cached — every call reads the chain fresh, because a stale value that overstates the watermark would over-recycle and would approve a rebind that strips an unredeemed claim.

  **Mina is deliberately left unrecycled.** Its `PaymentChannel` zkApp publishes no cumulative-paid at all: the balances exist on chain only inside `balanceCommitment = Poseidon(balanceA, balanceB, salt)` with a per-packet random salt, which is why the connector itself tracks Mina cumulative transferred off-chain. Every readable substitute — `nonceField` (a counter), `depositTotal` (the capacity ceiling), `channelState` (drained, but not how much) — can overstate the watermark, and an overstated watermark both over-credits inventory and approves a rebind that strips an unredeemed claim. So a `mina:*` read refuses with that chain fact instead of approximating, a Mina-only maker reports `reconciler.enabled: false`, and `blockedReason` says why. Over-crediting is the forbidden failure; refusing to serve is the safe one.

  The dispatcher forwards capabilities rather than enumerating them. `ChannelOnChainReader` grows optional capabilities over time (swap#142's `getFundingPosition`, EVM-only, backs `POST /admin/inventory/deposit`); a dispatcher returning a fixed object literal would silently DROP any capability it did not name, taking that route dark on every chain — fail-closed, but unexplained — and would drop the next one the same way. The composed reader is built from the union of the families' actual callables, so a capability any family implements survives the dispatch and one a family lacks throws for that family's chains.

- bcc3455: Operator route for genuinely new capital: `POST /admin/inventory/deposit`.

  #140's `/admin/inventory/credit` applies only what an on-chain **redemption**
  corroborates, which is right for recycling and leaves an operator who actually
  **adds** capital — funds a new channel, tops up a deposit — with no route at
  all (`SwapInventory.credit` had no caller, and raising config inventory does
  not reliably take: the persisted snapshot wins for keys it has already seen,
  issue #130).

  The new route corroborates against the pool's on-chain channel funding, Σ
  `cumulativePaid + deposit`, and credits only the excess of that over the pool's
  own `total`. `deposit` alone is unusable — it is the _remaining un-paid-out_
  balance and falls on every redemption — while the sum is invariant under
  redemption and rises only when capital actually enters a channel. Because
  crediting raises `total`, and `total` is what the next read is compared
  against, a repeated call measures a gap that has already closed: double
  crediting is structurally impossible, with no new persisted ledger.

  Also adds the optional `getFundingPosition` capability to the
  `ChannelOnChainReader` seam (implemented for EVM as one `eth_call` returning
  both words, so they can never straddle a redemption). Readers without it cause
  the route to refuse (503), never to guess. `SWAP_ADMIN_TOKEN` still gates the
  write and an unset token still disables it (503); no new config key.

- 841842c: The maker no longer accepts the legacy claim-in-FULFILL swap protocol (swap#154, toon-meta#411 Stage 5).

  By the time this lands, no client in the fleet emits legacy (toon-client#598), the removal gate has a real zero reading behind it (swap#152), and the cross-chain E2E harness no longer depends on the legacy path (swap#153). This is the second and last removal on the wire.

  **Behaviour change:** a zero-condition kind:1059 gift wrap whose inner rumor is not kind:20033 — overwhelmingly the retired legacy kind:20032 request — is now refused with a named, machine-readable reason (`legacy_protocol_refused` in the base64-JSON reject `data`, or `unreadable_request` if the payload does not even unwrap). Previously it was dispatched to the SDK's `createSwapHandler` and, if valid, fulfilled with a signed balance-proof claim. A kind:20033 RFQ still establishes a rolling session exactly as before — the RFQ sniff this reject sits behind is untouched.

  `rfqIntake.handle()` is now terminal: it always returns an accept or a reject, never `null`, so there is no more legacy fall-through in `swap-node.ts`. The `rolling.rfq.enabled` config knob is removed — it had become a switch whose only function was disabling the maker's sole remaining protocol.

  `createSwapHandler` and `withMaxRateAge` remain exported from this package (Stage 6, a major bump, retires them from the public API) but are no longer wired into `startSwapNode()`. `MultiChainClaimIssuer` and `SwapInventory` are unaffected — they are the rolling path's leg-B claim signer and capital, and stay exactly as they were.

- a76752b: **A rolling fill can now actually be delivered: leg B goes back over the BTP session its RFQ arrived on.**

  A live devnet swap negotiated a rolling session end to end for the first time — and then delivered nothing. The maker quoted, opened the session, and F02'd its own leg-B PREPARE:

  ```
  maker:  REJECT destination=g.toon.client errorCode=F02 "no route found"
  maker:  swap.rolling.fill_unwound streamNonce=1007de73… seq=1 cause=F02
  client: F99 "leg B failed; fill not executed"  packetsAccepted 0, valueReceived 0
  ```

  The address was right. The maker simply had no way to reach it, and — because auto-probe is the default and this maker now answers the RFQ — **every** default swap against it failed. Only an explicit `rolling: "off"` still worked.

  **Two layers, both maker-side, neither of which any existing test could see** (every rolling test injects `rollingLegBSender` or drives a fake connector, so leg B never touched a routing table):
  1. **No route.** A client that direct-dials the maker's BTP server is an inbound _session_, bound in `BTPServer.peers` under the `peerId` it declared on the auth greeting — never a routing-table entry. `ConnectorNode.sendPacket` resolves a destination only through `RoutingTable.getNextHop()`, so leg B was rejected before it left the maker. Requiring an operator to hand-configure a route for each client would make the direct-dial model (swap#105, `docker-compose.relay.swap.yml`) unusable.
  2. **No settlement channel.** Even routed, `PacketHandler` demands a per-packet claim on every value-bearing forward to a non-`child` next hop, and a maker holds no payment channel toward the client it is _paying_ — so a routed leg B answers `T00 "No payment channel available for peer"` instead. `'child'` is the ILP-correct relation, not a workaround: the connector's own comment for that skip is _"a parent settles DOWN to a child by letting the child accrue a balance owed up"_, which is exactly the rolling swap's netting (the sender pays on leg A; leg B's value is the signed chain-B claim inside the packet, never an ILP settlement over the link).

  New `leg-b-return-path.ts` resolves the return path at RFQ intake, from the session the RFQ actually arrived on (`LocalDeliveryRequest.sourcePeer`) — so a **stock client works against a stock maker with no operator routing configuration**. It adds no config key.

  Guards, because an RFQ payload is attacker-controlled:
  - the route is only ever `prefix: X → nextHop: X` for the string the peer **authenticated under** — a stock client's `senderIlpAddress` is by construction the same expression as its BTP greeting `peerId`, and requiring the match stops an RFQ claiming `senderIlpAddress: "g.proxy"` from shadowing the maker's upstream route;
  - a prefix that would shadow the maker's own `ilpAddress` is refused;
  - an operator/static route for the same prefix always wins;
  - bindings are capped and LRU-evicted, and withdrawn on `stop()`.

  **When the maker cannot deliver, it now refuses at leg 0** (`F02` / `reason: "no_return_path"`) instead of minting a session every fill will fail. That is the only moment failing is free — nothing quoted, no inventory reserved, no leg A revealed — and a sender's existing RFQ-failure fallback quietly takes the legacy path, which works. No retry-after-failure was added: re-running a fill as legacy after a rolling attempt is exactly the shape that risks double-delivery, and the withhold property (spec R5/R8) is what made the original failure free.

  Also: the standalone connector branch now sets `settlement: { connectorFeePercentage: 0 }`, mirroring the embedded-with-parent branch. Without it the default fee shaved the ILP `amount` of the one thing a standalone maker ever forwards — its own leg-B PREPARE — so the packet understated the claim it carried (3000 → 2997).

  Withhold behaviour is unchanged, and is now also asserted on the real wire: a sender that answers leg B with a REJECT leaves leg A rejected with no preimage learned.

  New tests boot a REAL `startSwapNode()` with a REAL `ConnectorNode` and drive it from a REAL `BtpRuntimeClient` over a socket — the same `onMessage` seam a stock client installs its leg-B router on. That is what caught defect 2; a unit test of address derivation would have caught neither.

- f60b2d1: The maker now accepts a rolling-swap session **from the wire**: an inbound kind:20033 RFQ (NIP-59 gift wrap, rolling-swap spec §2.2) registers the session and is answered with a gift-wrapped kind:20034 quote carrying `R₀`, `rateTimestamp`, quote expiry, `spread`, `maxRateAge`, `minAmount`/`maxAmount` and the leg-B `swapSignerAddress`.

  Previously the rolling protocol shipped in the released image but was unreachable: the only way to put a session in the `RollingSessionStore` was the in-process `SwapNodeInstance.registerRollingSession`, which `cli.ts` — what the container runs — never calls. Every rolling fill reaching a deployed maker therefore rejected F06 `unknown_session`, and every real swap fell through to the legacy SDK gift-wrap handler.

  Intake sits in `startSwapNode`'s existing `setPacketHandler` callback, ahead of the legacy branch, and is identified purely by the inner rumor kind — anything it cannot positively identify as an RFQ (including any unwrap failure) falls through to the legacy path byte-for-byte unchanged. Knobs are `rolling.rfq.{enabled,quoteTtlMs,spreadBps}`, all optional and defaulted (intake defaults ON); the CLI now also forwards the whole optional `rolling` config block. No new required config key. No announce change: per spec §10.3 step 2, rolling capability is discovered by probing the RFQ, not by an advertised flag.

- e3cad0e: **Adopt `@toon-protocol/sdk@3.2.0`'s `onFailure` seam and delete the workaround that stood in for it.**

  swap#137 had to reclaim the SDK swap handler's swallowed diagnoses from the outside, because `createSwapHandler` collapsed every non-`INSUFFICIENT_INVENTORY` failure into an opaque `T00 Internal error` and discarded the error object. SDK 3.2.0 (toon#204/#205) adds `CreateSwapHandlerConfig.onFailure`: a synchronous classifier called before the handler rejects on any _thrown_ failure, handed the thrown value verbatim, the packet context, and the `defaultRejection` it would otherwise emit.

  `claim-refusal.ts` is now that classifier and nothing else. Deleted with the workaround:
  - the `AsyncLocalStorage` per-packet capture slot;
  - `instrument()`, which wrapped the claim issuer purely to observe its throws;
  - `wrap()`, which wrapped the whole handler and sniffed its response for the literal `T00` / `Internal error` to know when to rewrite it;
  - the inference that named the `encrypt` stage from the _absence_ of an issuer throw.

  **The encrypt path is now observed, not inferred.** The SDK reports `stage: 'encrypt'` with `context.claimIssued: true`, `context.claimId`, and the thrown value, so the refusal carries the real encryption error (`claim_encrypt_failed: … : <error>`, plus `err` and `claimId` in the reject `data`) instead of a deduction with an empty payload.

  **No behaviour change on the wire.** An unredeemed channel still refuses with `T04` / `insufficient_funds`, the same `channel_unredeemed: …` message naming the channel and the unredeemed amount, and the same base64-JSON `data`. `INSUFFICIENT_INVENTORY` — and anything else the SDK already classified, signalled by `defaultRejection.code !== 'T00'` — is still left entirely to the SDK. `rate_provider` and `rate_conversion` are untouched; `RateFreshnessGuard` still owns staleness upstream. No new configuration key.

  `swap-node.claim-refusal.test.ts`, the end-to-end proof of the live-verified swap#137 contract, passes unchanged.

  Package surface: `createClaimRefusalDiagnostics` and the `ClaimRefusalDiagnostics` type are gone (they existed only to carry the workaround); `createClaimRefusalMapper` replaces them. `classifyClaimIssuerError`, `buildClaimRefusalReject`, `CLAIM_REFUSAL_REASONS`, `ClaimRefusal`, `ClaimRefusalReason` and `ClaimRefusalReject` are unchanged — `rolling-engine.ts` is a live caller of the classifier.

- 69ac585: The Solana balance-proof bytes now come from the published shared leaf, not a
  local copy (completes swap#165 / toon#214).

  swap#165 had to implement the 48-byte program message
  (`channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)`) locally, in
  `src/solana-balance-proof.ts`, because this package pinned
  `@toon-protocol/sdk@^3.2.0` — a range that predated the canonical export. That
  release has landed: `@toon-protocol/settlement-digest@1.1.0` publishes
  `balanceProofMessageSolana`, re-exported by `@toon-protocol/core@3.5.0` and
  `@toon-protocol/sdk@3.3.0`.

  Ranges bumped accordingly (`settlement-digest ^1.0.0 → ^1.1.0`,
  `sdk ^3.2.0 → ^3.3.0`, `core ^2.1.0 → ^3.5.0` — the last of which retires a
  second, two-major-old copy of core from the dependency tree, since the sdk
  already pulled core 3.x transitively). The Solana balance proof and the EVM
  EIP-712 digest are now sourced from the SAME shared leaf, so the maker cannot
  drift from the on-chain verifier or from the client's off-chain one.

  `src/solana-balance-proof.ts` is deleted. What survives is
  `solanaBalanceProofMessage` in `src/payment-channel-signer.ts`, next to its only
  caller — an adapter that is explicitly NOT a second implementation of the layout:
  it base58-decodes the `channelId` into the 32-byte PDA, refuses one that cannot
  name a channel on chain, and raises `SwapWalletError`s that NAME the offending
  u64 field (the shared leaf throws plain `Error`s whose text `signBalanceProof`
  would bury in `cause`). The bytes themselves are the published function's.

  Before the local copy was removed it was proven byte-identical to the published
  one over 524 vectors (the pinned ones plus 512 pseudo-random PDA/u64 triples) and
  over every one of the 64 bit positions in both u64 slots, through all three import
  paths (`settlement-digest` direct, and the `core` and `sdk` re-exports), with
  matching rejection behaviour for a non-32-byte PDA and for out-of-u64 values. The
  pinned vectors in `src/solana-balance-proof.test.ts` — derived from connector
  `processor.rs:900-910`, not from any TypeScript implementation — are kept and now
  guard the published bytes, with one test added asserting the adapter delegates
  rather than recomputes.

## 2.1.0

### Minor Changes

- df1168d: Rolling swap settlement-batching e2e + per-fulfill stream receipts + public leg-B egress (swap#50).
  - **Receipts on the rolling path (spec §7.2, sdk 2.2.0 toon#84):** every ACCEPTED rolling fill's `RollingAcceptRecord` now carries a signed `StreamReceipt` (`receipt` field, additive) — BIP-340-signed with the swap node's identity key via the sdk's `issueSessionReceipt`, gapless per-session maker seq, verifiable against `swapPubkey`. Rejected fills never advance the receipt session. New optional `RollingSwapEngineConfig.receiptSecretKey` / `receiptSessions`; `startSwapNode()` wires the identity key automatically.
  - **Leg-B egress reach-in retired:** `createConnectorLegBSender` now originates the conditioned leg-B PREPARE through the connector's PUBLIC `sendPacket` (`SendPacketParams.executionCondition`, connector 3.30.0 #314) instead of the internal `_packetHandler.handlePreparePacket`. Still fail-closed: no seam / thrown validation / a FULFILL that does not reveal the preimage of `C_i` (the signature of a condition-dropping pre-3.30.0 connector) all reject benignly — leg B is never externalized unconditioned by this package, and a rejected packet's claim is void per spec R8.
  - **Dependency floors:** `@toon-protocol/connector` ^3.30.0 (public executionCondition), `@toon-protocol/sdk` ^2.2.0 (receipts).
  - **Settlement-batching e2e (the epic's closing proof):** a self-contained anvil-gated integration suite drives a 25-fill rolling swap (one fill withheld mid-stream) between two REAL in-process ConnectorNodes over BTP across two anvil chains, and proves N leg-A + N leg-B advances net to exactly ONE on-chain settlement per chain at the final cumulative watermark — chain A submitted by the connector's own SettlementMonitor→SettlementExecutor auto-drive, chain B by the receive-side client machinery (`@toon-protocol/client` 0.18.0 ingest→store→build→submit), with the accumulated receipt chain matching the settled amount and `recordSettlement()` recycling the window. Runs in the devbox CI job (foundry pinned); runtime-skips where `anvil` is absent.

## 2.0.0

### Major Changes

- 6fde535: Rolling path: inventory → in-flight window reservation model (swap#49, rolling-swap spec §8, toon-meta#145).

  The rolling coupled-leg flow no longer permanently debits a notional pre-fund. Each fill takes a TTL'd **window reservation** for its leg-B amount (durable, write-ahead, before the leg-B advance is externalized), which is **committed** to unsettled channel liability on fulfill (shrunk later by on-chain settlement confirmations) or **released** on reject/rollback/TTL expiry. Capacity is gated by `min(windowBudget, available) − inFlight − unsettled` — the maker's honeypot is sized to δ×W of open packets plus the unsettled balance, not to notional volume; a capacity shortage rejects with the same benign T04 `insufficient_liquidity` vocabulary as before. Reservation TTLs align with the engine's leg-B expiry budget (+`rolling.reservationGraceMs`, default 5s), so a crashed/stalled packet frees its slot; crash recovery is expire-and-release (state-store crash rule 6) — no leaked capacity, no double-spend. The legacy zero-condition gift-wrap path keeps permanent debit/credit unchanged.

  Part of the same major train as the rolling engine (swap#47). Major because:
  - `SwapNodeInstance` gains a required `recordSettlement(event)` member and `SwapNodeHealthResponse` a required `inventoryWindow` three-bucket record (`budget`/`inFlight`/`unsettled`/`free`) — breaking for structural implementations/doubles.
  - `SwapInventoryBalance` gains a required `unsettled` field; `SwapInventory` snapshots and the persisted state schema change shape (`PersistedSwapState.version` 1 → 2, new `reservations`/`settledWatermarks` sections; v1 snapshots still load with defaults).
  - `MultiChainClaimIssuer.rollbackClaim()` (introduced unreleased in swap#47) is replaced by the reservation-keyed `issueRollingClaim()`/`commitRollingClaim()`/`rollbackRollingClaim()` triple; the rolling engine no longer calls `issueClaim()`.

  Also new: `SwapNodeConfig.windowBudget` (per-chain in-flight ceiling, CLI `windowBudget` config key), `SwapInventory.reserve/commitReservation/releaseReservation/recordSettlement/windowSnapshot`, and the `resolveChannel` doc comment corrected to the actual first-unbound-channel policy (binding is not capacity-aware; the window budget bounds exposure one level up).

- 9f6aec1: Rolling swap engine: coupled shared-condition packet legs (swap#47, rolling-swap spec §3, toon-meta#145).

  Each fill packet's two legs now share ONE sender-minted execution condition `C_i = sha256(P_i)`: the connector delivers `C_i` to the swap node (local-delivery fulfillment contract, connector 3.29.x), the engine issues the chain-B cumulative claim as an outbound leg-B PREPARE under the SAME `C_i`, and can only FULFILL leg A by relaying the preimage the sender reveals after verifying that claim — value-atomic per packet, replacing claim-in-FULFILL on the rolling path. Legacy zero-condition gift-wrap fills keep the pre-existing claim-in-FULFILL behavior byte-for-byte.

  Major because:
  - `SwapNodeInstance` gains a required `registerRollingSession()` member (breaking for structural implementations/test doubles).
  - Packets carrying a sender-chosen (non-zero) execution condition with a legacy gift-wrap payload are now rejected F99 up front instead of being dispatched (the legacy handler cannot mint the preimage; dispatching would debit inventory only for the connector to F99 the FULFILL with nothing recorded).
  - `STALE_RATE_SEMANTIC_REASON` flips `'timeout'` → `'stale_rate'` (native wire T99), which requires `@toon-protocol/connector` >= 3.29.0 — the dependency floors move to connector ^3.29.1 / sdk ^2.1.0 / core ^2.1.0.

  Also new: `RollingSwapEngine`/`RollingSessionStore` + wire payload types (`rolling/1` fill/advance/accept), `MultiChainClaimIssuer.rollbackClaim()` full-unwind for failed coupled packets, `createHttpRateProvider` + `SWAP_RATE_URL`/`SWAP_RATE_TIMEOUT_MS` CLI wiring so deployed makers finally price per packet via `rateProvider` instead of the config-frozen `pair.rate`.

## 1.0.0

### Major Changes

- e4a0608: BREAKING (local API + env): retire the legacy "mill" vocabulary entirely — hard cut, no aliases, no fallback env reads (matches the org's dvm→store precedent; the sdk 2.x wire rename `millSignerAddress`→`swapSignerAddress` already shipped separately).
  - Env vars: `MILL_MNEMONIC`→`SWAP_MNEMONIC`, `MILL_SECRET_KEY_HEX`→`SWAP_SECRET_KEY_HEX`, `MILL_BLS_PORT`→`SWAP_BLS_PORT`, `MILL_RELAYS`→`SWAP_RELAYS`
  - Public API: `startMill()`→`startSwapNode()`, `MillConfig`→`SwapNodeConfig`, `MillInstance`→`SwapNodeInstance` (`.millKeys`→`.swapNodeKeys`), `MillLogger`→`SwapNodeLogger`, `MillHealthResponse`→`SwapNodeHealthResponse`, `MillStartError(Code)`→`SwapNodeStartError(Code)`, `Mill*ChainProvider`→`SwapNode*ChainProvider`, `MillKeys`→`SwapNodeKeys`, `MillChainKind`→`SwapNodeChainKind`, `deriveMillKeys`→`deriveSwapNodeKeys`, `DeriveMillKeysInput`→`DeriveSwapNodeKeysInput`, `MillInventory*`→`SwapInventory*`, `MillChannelState*`→`SwapChannelState*`, `MillWalletError(Code)`→`SwapWalletError(Code)`
  - Error-code string: `MILL_REQUIRES_MNEMONIC`→`SWAP_REQUIRES_MNEMONIC`
  - Files/CLI: `src/mill.ts`→`src/swap-node.ts`, default config path `./mill.config.json`→`./swap.config.json`
  - Default ILP address prefix: `g.toon.mill.<pubkey16>`→`g.toon.swap.<pubkey16>` (self-declared via kind:10032; nothing deployed)
  - Log event names: `mill.*`→`swap.*`

  See `docs/sdk-2x-migration.md` for the full mapping table.

- e4a0608: Migrate to `@toon-protocol/sdk` ^2.0.0 / `@toon-protocol/core` ^2.0.0 / `@toon-protocol/connector` ^3.20.1 and adopt the mill→swap wire vocabulary (toon#48, swap#45; rolling-swap prerequisite P4 for toon-meta#145).

  BREAKING (wire): FULFILL accept-metadata now emits `swapSignerAddress` / `swapEphemeralPubkey` instead of `millSignerAddress` / `millEphemeralPubkey`, with no back-compat alias. sdk 0.5.x clients silently drop the renamed fields at `decodeFulfillMetadata` and fail much later at settlement with `MISSING_SETTLEMENT_METADATA` — deploys MUST be coordinated with the toon-client sdk-2.x migration (toon-client#349). See `docs/sdk-2x-migration.md` for the deploy-ordering rule and mixed-fleet symptom.

  Connector stays at ^3.20.1 (highest published; the connector npm publish pipeline is broken past 3.20.1 — bump to ^3.28 when fixed). The embedded child-connector boot (`relation: 'parent'` skip + `setPacketHandler` seam) is re-verified against the installed connector by a new boot smoke test.

### Minor Changes

- 9917dc0: Persist swap node state across restarts (issue #46, rolling-swap prerequisite P2): inventory, channel nonce/cumulative watermarks, sticky sender→channel bindings, and replay reservations survive a crash or restart. New `SwapNodeConfig.statePath` / `stateStore` (CLI: `statePath`, env `SWAP_STATE_PATH`) enables a JSON-file snapshot written atomically (temp file + fsync + rename) with write-ahead ordering: the watermark is persisted BEFORE a signed claim can leave the process, so a handed-out claim is never ahead of the stored watermark. `startSwapNode` rehydrates the snapshot at boot (persisted values win over config notionals; corrupt snapshots fail boot loudly with `STATE_LOAD_FAILED` instead of silently resetting watermarks). Adds `JsonFileSwapStateStore`, `SwapStatePersister`, `PersistentSeenPacketIds`, `SwapChannelState.snapshot()`/binding rehydration, and `MultiChainClaimIssuer.persistState` (write-ahead failure → `PERSISTENCE_FAILED`, claim refused, state rolled back). Without `statePath`/`stateStore` the swap node runs in-memory exactly as before.
- 9c384b7: Maker staleness-reject (`maxRateAge`) prototype — toon-protocol/swap#48, rolling-swap epic toon-meta#145 (spec §4).

  New maker-owned per-chain/per-pair freshness bound: when configured, any kind:1059 fill packet whose pair's rate feed has not ticked within the bound is rejected BENIGNLY — before the replay reservation, pricing, and leg-B claim issuance — with a machine-distinguishable contract the sender treats as "re-quote and retry":
  - handler-level code `T99`, `message: 'stale_rate'`, base64-JSON `data` `{"reason":"stale_rate","maxRateAgeMs":…,"lastRateAt":…,"pair":…}` (`StaleRateRejectData`)
  - `rejectReason.code: 'timeout'` → wire T00 (T-class, retryable) on connector <=3.20.1, whose `REJECT_CODE_MAP` has no `stale_rate`/T99 entry yet; senders MUST discriminate on `data.reason === 'stale_rate'` (fallback `message`), not the wire code

  Config: `SwapNodeConfig.maxRateAge` (`{ defaultMs?, perChain?, perPair? }`; perPair > min(perChain across both legs, exact id or family) > defaultMs), env `SWAP_MAX_RATE_AGE` (JSON) / `SWAP_MAX_RATE_AGE_MS`. Requires a `rateProvider`; `SwapNodeConfig.rateProvider` is widened to return timestamped quotes `{ rate, at }` (bare strings still accepted — but leave the guard inert). `maxRateAge` without a `rateProvider` fails boot with `INVALID_CONFIG`.

  Calibrated per-chain-class starting points exported as `RECOMMENDED_MAX_RATE_AGE_MS` (`evm: 1500`, `solana: 3000`, `mina: 15000`) — derived and pinned by the seeded simulation harness in `max-rate-age.calibration.test.ts` (rule of thumb: ~4-6× the feed's median tick interval, ≈ its p99 gap). Unconfigured swap nodes are behavior-identical.
