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
 * Prefix of the EVM chain string peer1 advertises and the suites gate on.
 * Shared so `peer-node.ts` (which builds peer1's swapPairs) and
 * `infra-gate.ts` (which builds `DOCKER_CHAIN_EVM`) can never disagree —
 * a mismatch would make every EVM pair silently unroutable.
 */
export const EVM_CHAIN_PREFIX = 'evm:base:';

/** In-process vanilla Nostr relay (local-nostr-relay.ts). */
export const RELAY_PORT = 18901;
export const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

/** Peer1 — the swap node under test, booted in-process (peer-node.ts). */
export const PEER1_BTP_PORT = 18902;
export const PEER1_BTP_URL = `ws://127.0.0.1:${PEER1_BTP_PORT}`;
export const PEER1_BLS_PORT = 18903;
export const PEER1_BLS_URL = `http://127.0.0.1:${PEER1_BLS_PORT}`;
