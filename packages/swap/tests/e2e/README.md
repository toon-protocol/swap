# Docker cross-chain E2E harness

Four suites here drive a real `streamSwap()` session over real BTP against a
real swap node (`peer1`), then check settlement-bundle construction on each
target chain:

- `docker-swap-flow-evm-e2e.test.ts` (AC-3..6)
- `docker-swap-flow-solana-e2e.test.ts` (AC-7)
- `docker-swap-flow-mina-e2e.test.ts` (AC-8)
- `docker-swap-flow-pair-matrix-e2e.test.ts` (AC-9/10 — all 9 ordered chain pairs)

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

### EVM leg — fully automatic, no setup

`tests/e2e/global-setup.ts` (a Vitest `globalSetup`) boots, once per test
run, before any suite file:

1. **Anvil**, loaded with the same vendored `rolling-e2e-anvil-state.hex`
   fixture the integration suite uses (`TokenNetworkRegistry` / `TokenNetwork`
   (USDC) already deployed at the fixed addresses the EVM suite asserts).
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
client-side signature verification, no on-chain broadcast). It does **not**
yet catch the v1-vs-v2 balance-proof digest mismatch described in
toon-meta#394 — that requires peer1 to actually sign with the v2 EIP-712
digest and advertise its `verifyingContract` (swap#101, swap#102, both
still open as of this harness landing). Once those ship, this is exactly the
seam this harness exists to close: wire a real client-side verify step into
AC-3 (or a new AC) so a future v1/v2 regression fails here instead of
silently passing both repos' CI, per toon-meta#394's original report.
