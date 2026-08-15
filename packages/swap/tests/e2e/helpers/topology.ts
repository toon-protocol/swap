/**
 * swap#104 — fixed topology constants shared between `global-setup.ts`
 * (which boots the self-contained infra) and `infra-gate.ts` (which probes
 * it from the test-runner process). Kept in one module so port/identity
 * values can never drift between the two.
 */

import { getPublicKey } from 'nostr-tools/pure';

/**
 * Peer1's Nostr identity. This exact hex value is load-bearing: all four
 * E2E suites hardcode the derived pubkey (`d6bfe100…`) as
 * `PEER1_NOSTR_PUBKEY` in their own source (originally the
 * `docker-compose-sdk-e2e.yml` `NOSTR_SECRET_KEY` env var) — changing this
 * value breaks every suite's peer1 lookup.
 */
export const PEER1_NOSTR_SECRET_KEY_HEX =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

export const PEER1_NOSTR_SECRET_KEY = Uint8Array.from(
  Buffer.from(PEER1_NOSTR_SECRET_KEY_HEX, 'hex')
);

export const PEER1_NOSTR_PUBKEY = getPublicKey(PEER1_NOSTR_SECRET_KEY);

/** Anvil — reuses the vendored fixture from the rolling-swap integration harness (swap#50). */
export const ANVIL_PORT = 18545;
export const ANVIL_CHAIN_ID = 31337;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

/** In-process vanilla Nostr relay (local-nostr-relay.ts). */
export const RELAY_PORT = 18901;
export const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

/** Peer1 — the swap node under test, booted in-process (peer-node.ts). */
export const PEER1_BTP_PORT = 18902;
export const PEER1_BTP_URL = `ws://127.0.0.1:${PEER1_BTP_PORT}`;
export const PEER1_BLS_PORT = 18903;
export const PEER1_BLS_URL = `http://127.0.0.1:${PEER1_BLS_PORT}`;
