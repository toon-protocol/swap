# Docker cross-chain E2E harness

Ten suites here drive a real swap session over real BTP against a real swap
node (`peer1`), then check settlement-bundle construction on each target chain.
There are **two families**, and they run side by side:

### Rolling (swap#153) — the protocol ADR 0003 keeps

kind:20033 RFQ → kind:20034 quote → coupled fills carrying a real 32-byte
sender-minted execution condition, with the chain-B claim arriving on **leg B**.

| suite | collects | what it covers |
| --- | --- | --- |
| `docker-rolling-swap-evm-e2e.test.ts` | 5 | RFQ, coupled fills, R4/R6 coupling, R5/R8 withhold, EVM settlement bundle |
| `docker-rolling-swap-cross-chain-e2e.test.ts` | 3 | `evm:base:31337 → evm:base:31338` — a REAL chain boundary, no operator infra |
| `docker-rolling-swap-pair-matrix-e2e.test.ts` | 17 | 16 ordered pairs over 4 chains + a coverage guard |
| `docker-rolling-swap-solana-e2e.test.ts` | 2 | Solana target (skips without a validator) |
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
reports.

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

### Solana / Mina — optional, real infra required

Neither chain has an equivalent to Anvil's "spawn a fresh local binary and
load a state snapshot" — they need a real `solana-test-validator` process
and a real Mina lightnet. This repo doesn't vendor either, so by default
`waitForSolanaHealth()` / `waitForMinaHealth()` return `false` and the
Solana/Mina-only suites (and the 5 Solana/Mina-touching pairs in the
pair-matrix suite) skip.

To exercise them:

```sh
./scripts/sdk-e2e-infra.sh up    # docker compose: solana-test-validator + mina-lightnet
```

then export the env vars the script prints (`SOLANA_E2E_RPC_URL`,
`SOLANA_E2E_PROGRAM_ID`, `MINA_E2E_GRAPHQL_URL`,
`MINA_E2E_ACCOUNTS_MANAGER_URL`, `MINA_E2E_ZKAPP_ADDRESS`) before rerunning
`test:e2e:docker`. `SOLANA_E2E_PROGRAM_ID` / `MINA_E2E_ZKAPP_ADDRESS` have no
default — deploying the swap-channel program / zkApp against a fresh
validator/lightnet is a separate, chain-specific step this script does not
perform.

`peer-node.ts` currently only wires an EVM `chainProviders` entry for
peer1. Extending it to advertise/settle Solana and Mina pairs too (mirroring
the EVM wiring, using the env vars above) is a natural follow-up once an
operator has real infra to develop against — the suites already gate
correctly on `waitForSolanaHealth()` / `waitForMinaHealth()` either way, so
this is additive, not blocking.

Tear down with `./scripts/sdk-e2e-infra.sh down`.

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
