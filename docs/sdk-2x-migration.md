# sdk 2.x migration — `millSignerAddress` → `swapSignerAddress` wire rename

**Status:** shipped with issue [#45](https://github.com/toon-protocol/swap/issues/45)
(rolling-swap prerequisite P4, [toon-meta#145](https://github.com/toon-protocol/toon-meta/issues/145),
spec §10.1). **Read this before deploying a swap node built from this revision
into a fleet that still runs sdk 0.5.x clients.**

## What changed

This repo moved from `@toon-protocol/sdk` ^0.5.0 / `@toon-protocol/core` ^1.4.1 /
`@toon-protocol/connector` ^3.10.0 to:

| Package | Old pin | New pin | Notes |
|---|---|---|---|
| `@toon-protocol/sdk` | ^0.5.0 | ^2.0.0 | The mill→swap vocabulary rename shipped as the **2.0.0** major (changeset `af4cd24`, toon#48). The issue text says "1.x" because at audit time the rename sat unreleased at in-repo version 1.0.1; it released as 2.0.0. |
| `@toon-protocol/core` | ^1.4.1 | ^2.0.0 | Pulled by sdk 2.x; direct dep for `buildIlpPeerInfoEvent` etc. |
| `@toon-protocol/connector` | ^3.10.0 | ^3.20.1 | See "connector 3.28 gap" below. |

Renamed identifiers, applied throughout src + tests:

- `millSignerAddress` → `swapSignerAddress` (`IssueClaimResult`, `SettlementClaim`, `SettlementBundle`) — **wire field**, travels in the FULFILL accept-metadata dict
- `millEphemeralPubkey` → `swapEphemeralPubkey` (`SettlementClaim`) — **wire field**
- `millPubkey` / `millIlpAddress` → `swapPubkey` / `swapIlpAddress` (`StreamSwapParams`, client-side sender params)
- Error codes `MILL_SIGNER_MISMATCH` / `MILL_RECIPIENT_MISMATCH` → `SWAP_SIGNER_MISMATCH` / `SWAP_RECIPIENT_MISMATCH` (sender-side verification; not used in this repo)

**Unchanged on purpose:** operator-facing env/config names (`MILL_MNEMONIC`,
`MILL_SECRET_KEY_HEX`, `MILL_BLS_PORT`, `MILL_RELAYS`, `TOON_CONNECTOR_URL`) and
internal `Mill*` type/file names. Per #45: env names may stay, wire fields must
change.

## The deploy-ordering trap (read this twice)

sdk 2.0.0 renamed the wire vocabulary **with no back-compat alias**. A swap node
built from this revision emits `swapSignerAddress` in FULFILL accept-metadata;
sdk 0.5.x clients still look for `millSignerAddress`.

The failure is **silent and deferred**:

1. A 0.5.x client swaps against a 2.x swap node. Its `decodeFulfillMetadata`
   (sdk `stream-swap.ts`) **drops unknown settlement fields without error** —
   the swap "succeeds", claims accumulate, money moves on leg A.
2. Much later, at settlement, `buildSettlementTx` fails with
   `MISSING_SETTLEMENT_METADATA` because `millSignerAddress` never arrived.

Nothing errors at swap time on either side. The same applies mirrored: a 2.x
client against a 0.5.x swap node loses `swapSignerAddress` the same way.

### Rule

**Both sides of the wire MUST cross the rename together.** Deploy windows for
this repo and the toon-client sdk-2.x migration
([toon-client#349](https://github.com/toon-protocol/toon-client/issues/349))
must be coordinated:

- Do NOT deploy a swap node from this revision against a fleet of 0.5.x
  clients you do not control.
- Do NOT point upgraded (sdk 2.x) clients at a swap node still running the
  0.5.x build.
- There is deliberately no dual-emit/tolerant-reader shim in this repo: the
  metadata dict is assembled inside the sdk's swap-handler (not here), and the
  rolling-swap spec (toon-meta `docs/rolling-swap.md` §10.1) authors all new
  fields against the 2.x vocabulary only. If a mixed-fleet window becomes
  unavoidable, ship an alias reader in the **sdk**, not per-consumer hacks.

### How to detect a mixed fleet

A client stuck on the wrong side shows exactly one symptom: swaps fulfil
normally but `buildSettlementTx` throws `MISSING_SETTLEMENT_METADATA`. If you
see that error after this deploy, check the peer's sdk major first.

## connector 3.28 gap

Issue #45 targets connector ^3.28, but the connector's npm publish pipeline has
been failing since 3.20.1 (the `Publish npm Package` job fails in
`onboarding-wizard` tests with `ERR_REQUIRE_ESM`; git tags run to v3.28.5 with
nothing published past 3.20.1). This repo therefore pins the highest published
version, `^3.20.1`, which already carries the two load-bearing child-connector
behaviors (`relation: 'parent'` claimless-parent-forward skip, connector#78,
present since ≥3.8; and the `setPacketHandler` local-delivery seam) — both
re-verified at runtime by `src/mill.connector-boot.test.ts`. Bump the range to
`^3.28` once the connector repo's publish job is fixed and re-run that smoke
test; no code change here is expected.

## Docker E2E status

`packages/swap/tests/e2e/*` (the docker swap-flow suites) currently cannot run
in this repo at all — pre-existing since the monorepo extraction, unrelated to
this migration. `tests/e2e/helpers/infra-gate.ts` re-exports helpers from
`../../../../sdk/tests/e2e/helpers/docker-e2e-setup.js` (a sibling
`packages/sdk` that no longer exists here), and the referenced
`./scripts/sdk-e2e-infra.sh` harness was not carried into either extracted
repo. The e2e sources were migrated to the 2.x vocabulary anyway so they are
ready when the harness is restored. Coverage in the meantime:

- `pnpm -r test` — 131 unit tests, including the new embedded-connector boot
  smoke against the real installed connector.
- `pnpm --filter @toon-protocol/swap test:integration` — 18 in-process
  end-to-end tests driving the real sdk 2.x `streamSwap` → gift-wrap →
  swap-handler → claim-issuer → FULFILL metadata → `buildSettlementTx`
  round-trip, asserting `swapSignerAddress` end to end.
