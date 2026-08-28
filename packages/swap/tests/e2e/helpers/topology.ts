/**
 * swap#104 — fixed topology constants shared between `global-setup.ts`
 * (which boots the self-contained infra) and `infra-gate.ts` (which probes
 * it from the test-runner process). Kept in one module so port/identity
 * values can never drift between the two.
 */

import { fromMnemonic } from '@toon-protocol/sdk';

/**
 * Peer1's identity seed. `startSwapNode()` REQUIRES a BIP-39 mnemonic — it
 * derives the Nostr/EVM identity via `fromMnemonic()` (BIP-32) and throws
 * `SWAP_REQUIRES_MNEMONIC` for a bare `secretKey` (PR #106 review finding
 * #1). This is the standard 12-word all-zero-entropy test mnemonic already
 * used throughout this package's unit tests (e.g. `src/swap-node.peer-info.
 * test.ts`); reusing it here is just convention, not a security concern —
 * it's a well-known public test vector.
 */
export const PEER1_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * The pubkey `fromMnemonic(PEER1_MNEMONIC)` derives. Computed once here
 * (not hardcoded) so it can never drift from what peer1 actually boots
 * with; the four E2E suites import this value instead of hardcoding their
 * own copy.
 */
export const PEER1_NOSTR_PUBKEY = fromMnemonic(PEER1_MNEMONIC).pubkey;

/** Anvil — reuses the vendored fixture from the rolling-swap integration harness (swap#50). */
export const ANVIL_PORT = 18545;
export const ANVIL_CHAIN_ID = 31337;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

/**
 * Chain **B** — a SECOND anvil, loaded with the same vendored state blob at a
 * different chain id (swap#153).
 *
 * Why it exists: before this, every suite in `tests/e2e/` that actually
 * EXECUTED ran `evm:base:31337 → evm:base:31337`. The Solana and Mina suites,
 * and 8 of the pair matrix's 9 pairs, skip for want of infra this repo does not
 * vendor — so the "multi-chain E2E harness" never once crossed a chain boundary
 * in CI. `tests/integration/rolling-settlement.integration.test.ts` (swap#50)
 * had already shown a chain boundary can be crossed with nothing but a second
 * `anvil`, so the rolling port takes the same route: leg A settles on
 * {@link ANVIL_CHAIN_ID}, leg-B claims are signed for {@link ANVIL_B_CHAIN_ID}.
 *
 * This is a genuinely different chain — different chain id, different RPC,
 * different `RollingSwapChannel` deployment, its own EIP-712 domain — not a
 * relabelling of the same one.
 */
export const ANVIL_B_PORT = 18546;
export const ANVIL_B_CHAIN_ID = 31338;
export const ANVIL_B_RPC = `http://127.0.0.1:${ANVIL_B_PORT}`;

/**
 * Prefix of the EVM chain string peer1 advertises and the suites gate on.
 * Shared so `peer-node.ts` (which builds peer1's swapPairs) and
 * `infra-gate.ts` (which builds `DOCKER_CHAIN_EVM`) can never disagree —
 * a mismatch would make every EVM pair silently unroutable.
 */
export const EVM_CHAIN_PREFIX = 'evm:base:';

/**
 * Solana — a real `solana-test-validator` booted by `global-setup.ts`
 * (swap#160), with the real payment-channel program baked into its genesis
 * from `tests/e2e/fixtures/solana/payment_channel.so`.
 *
 * Why this exists: before it, the Solana suites gated on an operator having
 * brought up a validator by hand and exported `SOLANA_E2E_RPC_URL`, which
 * nobody ever did in CI — so they collected two tests and skipped both, on
 * every run, for the whole life of the harness. A local validator mints
 * freely and confirms instantly, so the supply problem that blocks the
 * public Solana devnet (dry airdrop, unconfigured faucet route) does not
 * apply; the only thing that was ever missing was a program to talk to, and
 * this repo can vendor that in 109 KB.
 *
 * Ports deliberately sit in the 188xx band, below the relay/peer1 block and
 * well clear of the 199xx band the per-suite senders use — two suites running
 * concurrently on one machine already collide there (`EADDRINUSE` on
 * 18901/19920 has been observed), and a validator that binds a range is the
 * worst thing to add to a crowded band. `--dynamic-port-range` covers the
 * gossip/TPU/serve-repair sockets the validator opens beyond the RPC.
 */
export const SOLANA_RPC_PORT = 18899;
export const SOLANA_RPC_URL = `http://127.0.0.1:${SOLANA_RPC_PORT}`;
export const SOLANA_FAUCET_PORT = 18898;
export const SOLANA_DYNAMIC_PORT_RANGE = '18860-18890';

/**
 * The address the vendored program is loaded at.
 *
 * The program has NO `declare_id!` (it is native Rust, not Anchor — it takes
 * `program_id` from the entrypoint and derives its PDAs from it), so this is
 * a free choice rather than a property of the binary. It is connector's
 * `LOCAL_TEST_PROGRAM_ID`
 * (`crates/connector-settlement-solana/src/test_support.rs`) verbatim, so a
 * channel PDA derived in this repo's tests matches one derived in that
 * repo's.
 */
export const SOLANA_PROGRAM_ID = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';

/**
 * The mock 6-decimal SPL mint the Solana channels settle in — the address of
 * the committed `fixtures/solana/usdc-mint.json` keypair, so it survives every
 * `--reset` and the suites can assert on it.
 */
export const SOLANA_USDC_MINT = 'CfXoHk5zRtFDtxD4HtTJXDzhfRMtSad4r3BiKeG9A2AC';

/** The Solana chain key peer1 advertises and the suites gate on. */
export const SOLANA_CHAIN = 'solana:devnet';

/** In-process vanilla Nostr relay (local-nostr-relay.ts). */
export const RELAY_PORT = 18901;
export const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

/** Peer1 — the swap node under test, booted in-process (peer-node.ts). */
export const PEER1_BTP_PORT = 18902;
export const PEER1_BTP_URL = `ws://127.0.0.1:${PEER1_BTP_PORT}`;
export const PEER1_BLS_PORT = 18903;
export const PEER1_BLS_URL = `http://127.0.0.1:${PEER1_BLS_PORT}`;

/** Peer1's own ILP address — the destination every RFQ and leg-A fill targets. */
export const PEER1_ILP_ADDRESS = 'g.toon.peer1';

/**
 * ILP addresses the ROLLING senders authenticate their BTP sessions under.
 *
 * On the rolling path this string is load-bearing in a way it never was on the
 * legacy path: the maker will only mint a session it can answer, and it decides
 * that by comparing the RFQ's `senderIlpAddress` against the peer id the
 * arriving BTP session authenticated with (`leg-b-return-path.ts` —
 * `sourcePeer === senderIlpAddress`). A `ConnectorNode` greets with its
 * `nodeId` verbatim (connector `btp/btp-client.ts`), so for a rolling sender
 * the nodeId IS its ILP address, and `build-live-sender.ts` installs the
 * matching self-route so leg B lands on its local-delivery handler.
 *
 * One per suite: peer1 is shared across every suite file in the run
 * (`vitest.e2e.config.ts` — `singleFork`, `isolate: false`), and two live BTP
 * sessions may not claim the same peer id.
 */
export const ROLLING_SENDER_ILP = {
  evm: 'g.toon.client.e2erollevm',
  crossChain: 'g.toon.client.e2erollxc',
  solana: 'g.toon.client.e2erollsol',
  mina: 'g.toon.client.e2erollmina',
  matrix: 'g.toon.client.e2erollmtx',
  routing: 'g.toon.client.e2erollroute',
} as const;

/**
 * The maker's Rust connector (toon-protocol/connector) — the client edge the
 * taker pays leg A into (`POST /ilp`), booted by `helpers/rust-connector.ts`.
 * Sits below the old 189xx/1890x blocks so a stale in-process peer1 on 18902
 * and a stale validator on 18899 can never collide with it.
 */
export const MAKER_CONNECTOR_CLIENT_EDGE_PORT = 18300;
export const MAKER_CONNECTOR_URL = `http://127.0.0.1:${MAKER_CONNECTOR_CLIENT_EDGE_PORT}`;

/**
 * The maker app behind the connector's route termination — what
 * `[[routes]] handler_url` points at. In the toolkit self-check this is a tiny
 * in-process `node:http` recorder; in the real harness it is the swap maker.
 */
export const MAKER_APP_PORT = 18310;
export const MAKER_APP_URL = `http://127.0.0.1:${MAKER_APP_PORT}`;
