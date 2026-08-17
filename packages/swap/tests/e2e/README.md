# Docker cross-chain E2E harness

Ten suites here drive a real swap session over real BTP against a real swap
node (`peer1`), then check settlement-bundle construction on each target chain.
As of swap#160 a full local run collects **52 tests and skips only the 4 Mina
ones** — every EVM and Solana case executes.
There are **two families**, and they run side by side:

### Rolling (swap#153) — the protocol ADR 0003 keeps

kind:20033 RFQ → kind:20034 quote → coupled fills carrying a real 32-byte
sender-minted execution condition, with the chain-B claim arriving on **leg B**.

| suite | collects | what it covers |
| --- | --- | --- |
| `docker-rolling-swap-evm-e2e.test.ts` | 5 | RFQ, coupled fills, R4/R6 coupling, R5/R8 withhold, EVM settlement bundle |
| `docker-rolling-swap-cross-chain-e2e.test.ts` | 3 | `evm:base:31337 → evm:base:31338` — a REAL chain boundary, no operator infra |
| `docker-rolling-swap-pair-matrix-e2e.test.ts` | 17 | 16 ordered pairs over 4 chains + a coverage guard |
| `docker-rolling-swap-solana-e2e.test.ts` | 4 | `evm:base:31337 → solana:devnet` against a REAL vendored-program validator: leg-B ed25519 claims, the Solana settlement bundle's SHAPE (not a broadcast — see below), a real channel PDA read back through swap#141's decoder, and the refusal of the reverse direction (swap#160) |
| `docker-rolling-swap-mina-e2e.test.ts` | 2 | Mina target (skips without a lightnet) |
| `docker-rolling-leg-b-routing-e2e.test.ts` | 3 | the swap#148 `F02` and `T00` routing shapes |

### Legacy (`streamSwap`) — kept until Stage 5 of toon-meta#411

| suite | collects |
| --- | --- |
| `docker-swap-flow-evm-e2e.test.ts` (AC-3..6) | 4 |
| `docker-swap-flow-solana-e2e.test.ts` (AC-7) | 2 |
| `docker-swap-flow-mina-e2e.test.ts` (AC-8) | 2 |
| `docker-swap-flow-pair-matrix-e2e.test.ts` (AC-9/10) | 10 |

**Do not delete the legacy four before the rolling six are green in CI** — they
were the project's only multi-chain E2E swap coverage, and swap#106 had already
found four of them silently collecting *zero* tests while reporting a pass.
The counts in the tables above are the guard against that happening again: a
suite that collects fewer than its number has lost coverage, whatever colour CI
reports. The `solana-e2e` CI job enforces the two Solana rows mechanically (it
greps the vitest output for the exact collected count), because "green" has
twice now meant "ran nothing".

Whole-run totals, as a second guard on the same thing: **52 collected, 48
passing, 4 skipped** under `SWAP_E2E_REQUIRE_SOLANA=1` (the `solana-e2e` job).
The 4 skips are Mina's, and only Mina's. Before swap#160 it was 50 / 42 / 8 —
the extra 8th..5th skips were the four Solana tests that had never once run.

Run with:

```sh
pnpm --filter @toon-protocol/swap test:e2e:docker
```

## History (swap#104)

These suites collected **zero tests** from the monorepo extraction until
swap#104: `tests/e2e/helpers/infra-gate.ts` imported from a sibling
`packages/sdk/tests/e2e/` checkout that has not existed in this repo since
the split (swap#51), and the Docker Compose harness those helpers talked to
(`./scripts/sdk-e2e-infra.sh` + a multi-service compose file) was never
carried into either extracted repo.

swap#104 replaced the dead cross-repo import with a **self-contained**
harness for the EVM leg, following the same pattern
`tests/integration/helpers/rolling-e2e-harness.ts` already established for
the rolling-swap settlement suite (swap#50): no cross-repo dependency, no
required Docker daemon — just `anvil` on PATH.

## Topology

### EVM legs — fully automatic, no setup

`tests/e2e/global-setup.ts` (a Vitest `globalSetup`) boots, once per test
run, before any suite file:

1. **Anvil (chain A, 31337)**, loaded with the same vendored
   `rolling-e2e-anvil-state.hex` fixture the integration suite uses
   (`TokenNetworkRegistry` / `TokenNetwork` (USDC) already deployed at the
   fixed addresses the EVM suite asserts).
1b. **Anvil (chain B, 31338)** — swap#153. The same blob at a different chain
   id, so peer1 can advertise `evm:base:31337 → evm:base:31338` and the
   rolling suites cross a **real** chain boundary on every CI run. Before
   this, the only pair that ever executed here was same-chain EVM: Solana,
   Mina and 8 of the 9 matrix pairs all skip for want of infra this repo does
   not vendor, so "multi-chain coverage" had never once been exercised. Same
   trick `tests/integration/rolling-settlement.integration.test.ts` uses; it
   costs one extra `anvil` process and no new dependency.
2. An **in-process Nostr relay** (`tests/e2e/helpers/local-nostr-relay.ts`)
   — just enough NIP-01 (`EVENT`/`REQ`/`EOSE`/`CLOSE`) for kind:10032
   discovery (AC-4). `startSwapNode()`'s default relay publisher
   (`SimplePool`-backed) is a plain Nostr WS publish, so any spec-compliant
   relay works — no pay-to-write TOON relay needed here.
3. **peer1** — a real `startSwapNode()` instance (`tests/e2e/helpers/
   peer-node.ts`), listening for inbound BTP on its own port. This is the
   swap node under test.

Requirement: `anvil` on PATH. `devbox.json` pins foundry 1.7.1, so
`devbox run -- pnpm --filter @toon-protocol/swap test:e2e:docker` always has
it; a plain shell needs `foundryup` (or equivalent) run first.

If `anvil` isn't found, `global-setup.ts` leaves everything down (it never
throws) and `tests/e2e/helpers/infra-gate.ts`'s readiness probes report
"not ready" — every gated test skips locally with a console warning
pointing back here. Under `CI=1`, that same "EVM core did not come up" case
throws instead of skipping (see `skipIfNotReady()`'s doc comment) — this
repo owns and boots that infra itself, so its absence under CI is a real
regression, not an expected gap.

### The rolling sender

A rolling sender is the same `ConnectorNode` the legacy suites build
(`helpers/build-live-sender.ts`), with two additions the legacy path never
needed:

- **its `nodeId` IS its ILP address.** The maker refuses to mint a session it
  cannot answer, and decides that by comparing the RFQ's `senderIlpAddress`
  against the peer id the arriving BTP session authenticated under
  (`src/leg-b-return-path.ts` — the swap#148 `F02` fix). A `ConnectorNode`
  greets with its `nodeId` verbatim, so the two have to be one string;
- **a local-delivery handler terminates leg B** — the sender daemon's
  verify-before-reveal seam (spec R5), built by
  `helpers/rolling-driver.ts`'s `createLegBDaemon()`.

Leg A is genuinely paid: δ > 0 means the maker's `InboundClaimValidator`
demands a payment-channel claim it can verify on chain, and the sender
connector's `PerPacketClaimService` signs it against the real Anvil channel —
which is why the sender here is a connector and not a bare `BtpRuntimeClient`.
The daemon enforces the structural half of R5 (recipient equality, monotone
`(nonce, cumulativeAmount)`, Δcumulative covering `targetAmount`, the signer
the quote promised); the v2 EIP-712 signature itself is verified by the real
client pipeline in `tests/integration/rolling-settlement.integration.test.ts`.

There used to be a second peer (`peer2`) in the pre-extraction Docker
topology. None of the four suites assert anything about a distinct peer2
identity or behavior — `waitForPeer2Bootstrap()` was always just a boolean
readiness gate — so this harness has one peer and `waitForPeer2Bootstrap()`
is an alias for the same EVM-core readiness check.

### Solana legs — fully automatic too (swap#160)

`global-setup.ts` boots a **real `solana-test-validator`** and everything the
maker needs to price and settle on it. Nothing is operator-supplied:

1. the **payment-channel program**, baked into the validator's genesis via
   `--bpf-program HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR
   fixtures/solana/payment_channel.so`. No deploy transaction, no program
   keypair — the same mechanism connector's Rust test harness uses. The binary
   is vendored (109 KB); `fixtures/solana/README.md` records its source commit,
   build command and hash, and `solana-validator.ts` verifies both before boot.
2. a mock 6-decimal **USDC SPL mint** at a fixed address, created through the
   `spl-token` CLI (as connector's `infra/solana/create-usdc-mint.sh` does).
3. **eight REAL channel PDAs** between derived openers and peer1, opened
   on-chain through `@toon-protocol/client`'s `OnChainChannelClient` — the same
   class the toon-meta#394 T6 rig used. `peer-node.ts` seeds
   `channels['solana:devnet']` with these, because a Solana `channelId` IS its
   channel PDA: seeding synthetic ids would leave the maker's chain-truth reader
   with nothing real to read.

Peer1 then advertises `evm:base:31337 → solana:devnet` and issues real ed25519
balance proofs on it — as of swap#164 over the 48-byte
`channel_pda || nonce(8 LE) || transferred_amount(8 LE)` message the program
above actually verifies, so those proofs are REDEEMABLE. Until then the maker
signed `sha256(utf8(channelId) || cumulative(32BE) || nonce(32BE) ||
utf8(recipient))`, a digest no deployed program has ever checked (toon#214).

What these suites still do NOT do is broadcast one. The upstream builder's
encoding is fixed (toon#214, proven by redeeming against this same vendored
program on a local validator), but this package pins the published
`@toon-protocol/sdk@^3.2.0`, which is the version that still emits an
Anchor-style discriminator, a reversed payload and an inlined signature. So the
Solana settlement assertions remain SHAPE-ONLY and `verifySignatures: false`
stays load-bearing — 3.2.0's verifier checks the legacy digest the maker no
longer signs. Bumping that range, then wiring the redemption and asserting
`transferred_amount_b` moves in S-3, is the follow-up.

Requirement: `solana-test-validator`, `solana` and `spl-token` on PATH
(`https://release.anza.xyz/v2.1.21/install`). The **`solana-e2e` CI job**
installs them, and sets `SWAP_E2E_REQUIRE_SOLANA=1` so a Solana skip in that
job is a hard failure rather than a green tick over a suite that never ran.
Without the CLI, Solana stays down, `waitForSolanaHealth()` reports not-ready,
and the Solana suites skip with a message naming the missing binary.

Why v2.1.21 and not v3.x: v3's validator hard-requires `io_uring`, which is
unavailable under some sandboxed runners. It also matches the `=2.1.0`
`solana-program` pin the vendored binary was built against.

Why a local validator at all, when the public devnet exists: the devnet blocker
is **supply**, not code — its airdrop is dry, the TOON faucet's Solana route is
unconfigured, and the mock-USDC mint authority lives off-repo. A local validator
mints freely and confirms in a slot, which is exactly why this is tractable in
CI when it is not on devnet.

### Mina — still optional, real infra required

Mina has no equivalent of "one binary plus a vendored blob": it needs a real
lightnet. This repo doesn't vendor one, so `waitForMinaHealth()` returns `false`
by default and the Mina suites (and the Mina-touching pair-matrix pairs) skip.
That is the only thing in this directory that still skips on a normal run.

To exercise them:

```sh
./scripts/sdk-e2e-infra.sh up    # docker compose: mina-lightnet
```

then export `MINA_E2E_GRAPHQL_URL`, `MINA_E2E_ACCOUNTS_MANAGER_URL` and
`MINA_E2E_ZKAPP_ADDRESS` before rerunning `test:e2e:docker`.
`MINA_E2E_ZKAPP_ADDRESS` has no default — deploying the zkApp against a fresh
lightnet is a separate step that script does not perform. Tear down with
`./scripts/sdk-e2e-infra.sh down`.

`SOLANA_E2E_RPC_URL` / `SOLANA_E2E_PROGRAM_ID` / `SOLANA_E2E_TOKEN_MINT` still
work as overrides if you want the suites pointed at a validator you manage
yourself.

### What does NOT run: `solana → evm` (leg A paid on Solana)

The direction the T6 rig proved by hand — the client paying **on Solana** and
receiving an EVM claim — is not drivable from this harness, and peer1
deliberately does not advertise it. `S-4` in
`docker-rolling-swap-solana-e2e.test.ts` asserts the refusal and carries the
full reasoning; in short:

1. **the sender cannot pay on Solana.** Leg A is paid by the sender connector's
   `PerPacketClaimService`, and `ConnectorNode` can only open EVM channels
   (`ChannelManager.openChannelForPeer` calls the EVM `PaymentChannelSDK` with
   no chain dispatch; the manager is only built `if (hasEvm)`; the admin surface
   answers `400 Unsupported blockchain: solana`). Only
   `@toon-protocol/client`'s `OnChainChannelClient` can — which is what this
   harness uses to *seed* channels, and moving the sender onto it is a rewrite
   of `build-live-sender.ts`, not a config change. There is also no upstream to
   wait on: the TypeScript connector was retired (toon-protocol/connector#543),
   so `^3.30.0` is the last line shipping `ConnectorNode` at all.
2. **the maker could not verify such a claim.** `startSwapNode` defaults every
   `chainProviders[].keyId` to the 0x-hex EVM key regardless of `chainType`
   (`src/swap-node.ts`), the connector base58-decodes it, and the decode throws
   on `0` — so the Solana provider registration always fails (swallowed as a
   `chain_provider_registration_failed` warn) and inbound Solana claims are
   rejected with `No settlement provider registered for blockchain: solana`.
3. **nothing would have told us.** `pair.from.chain` is never validated in
   `validateConfig` — only `to.chain` is — so such a maker boots silently and
   quotes RFQs it can never be paid for.

Items 2 and 3 are this repo's own product gaps and are tracked as follow-ups;
item 1 is the sender rewrite that has to come with them.

## A known, tracked gap

The EVM suite exercises `streamSwap()` completion, kind:10032 discovery, and
`buildSettlementTx()`'s structural output (`verifySignatures: false` — no
client-side signature verification, no on-chain broadcast). swap#101 (v2
EIP-712 balance-proof signing) and swap#102 (kind:10032 `verifyingContract`
advertisement) have both since landed on `main`, and `peer-node.ts` wires
peer1's `chainProviders` entry with the deployed `RollingSwapChannel`
address (`channelAddress`, from the same vendored Anvil fixture the
integration suite uses) so the swap node signs with the real v2 digest and
advertises it — but this harness still does not exercise real client-side
verification of that signature; AC-6's settlement assertions use
`verifySignatures: false`. Wiring a real client-side verify step into AC-3
(or a new AC) so a future v1/v2 regression fails here instead of silently
passing both repos' CI (per toon-meta#394's original report) remains a
follow-up.

## Identity

Peer1 boots from a fixed BIP-39 mnemonic (`tests/e2e/helpers/topology.ts`'s
`PEER1_MNEMONIC`) rather than a raw secret key — `startSwapNode()` requires
a mnemonic (it throws `SWAP_REQUIRES_MNEMONIC` for a bare `secretKey`, since
BIP-32 key derivation needs the seed). `PEER1_NOSTR_PUBKEY` is derived from
that mnemonic at module load (not hardcoded), so the four E2E suites import
it from `infra-gate.ts` instead of each carrying their own copy of the
literal hex string.
