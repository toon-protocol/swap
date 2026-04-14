/**
 * Fixture topology helpers for Story 12.8 integration tests.
 *
 * RED-PHASE SCAFFOLD ONLY — functions are unimplemented (`throw`) so the
 * integration tests in `tests/integration/` collect but do not pass.
 * Dev implements each helper during GREEN phase.
 *
 * Design constraints (per 12-8 story Dev Notes):
 * - Helpers are PRIVATE to this package — do NOT extract to a shared
 *   `packages/test-utils`. There is no second consumer until Epic 13
 *   months from now.
 * - The Mill boots in the SAME Node process as the test; sender uses an
 *   in-process peered `ConnectorNode`. No Docker. No BTP WebSocket.
 * - The fixture mnemonic is test-only and hardcoded; operators MUST NOT
 *   reuse it.
 *
 * See `packages/sdk/src/__integration__/create-node.test.ts` for the
 * peered-connector blueprint.
 */

import type { MillInstance } from '@toon-protocol/mill';

/**
 * Deterministic 12-word BIP-39 mnemonic used by every Story 12.8
 * integration test.
 *
 * test-only mnemonic, DO NOT reuse.
 *
 * The two keys derived from this mnemonic (connector-side at
 * BIP-44 account 1, Mill-side at account 2) are asserted disjoint by
 * AC-1.1 — re-using this string outside the test suite would collapse
 * the disjointness invariant.
 */
export const FIXTURE_MNEMONIC =
  'test test test test test test test test test test test junk';

/**
 * Anvil dev chain id — distinct from the common `1337` (Ganache)
 * value. AC-9 fails silently if this mismatches (EIP-155 chain-id in
 * signed tx).
 */
export const ANVIL_CHAIN_ID = 31337;

/**
 * Anvil JSON-RPC URL used by the opt-in AC-9 suite.
 */
export const ANVIL_URL = 'http://localhost:18545';

/** Opaque sender handle returned by `buildFixtureSender()`. */
export interface FixtureSender {
  /** Nostr x-only pubkey (32-byte hex). */
  readonly publicKey: string;
  /** EVM address derived from the same mnemonic at the sender path. */
  readonly evmAddress: string;
  /** Closes the sender's connector + node. Idempotent. */
  close(): Promise<void>;
  /** Raw peered-connector handle for replay / interception assertions. */
  readonly connector: unknown;
  /** ToonClient-shaped handle for `streamSwap()` consumers. */
  readonly client: unknown;
}

/** Options for `buildFixtureMill()`. */
export interface BuildFixtureMillOptions {
  /** Override the default swapPairs (AC-4 rate-drift test uses this). */
  readonly swapPairs?: unknown;
  /**
   * Inject a capturing publisher (AC-2). If omitted, the default
   * `SimplePool`-backed publisher is used (but `relayUrls: ['ws://localhost:0']`
   * makes it a no-op against the fixture topology).
   */
  readonly publisher?: { publish(event: unknown): Promise<void> };
  /** Override Mill-side rate provider (AC-4.3). */
  readonly rateProvider?: unknown;
}

/**
 * Boot a Mill against the fixture topology.
 *
 * RED-PHASE: throws. GREEN-PHASE: implementation must:
 *   1. Construct a `ConnectorNode` via the in-process-peer transport used
 *      by `packages/sdk/src/__integration__/create-node.test.ts`.
 *   2. Call `startMill()` with `FIXTURE_MNEMONIC`, a single
 *      USDC→ETH swap pair on `evm:31337`, pre-opened channel, 100 ETH
 *      inventory, `relayUrls: ['ws://localhost:0']`, and `connector`
 *      OMITTED (AC-1.3 + AC-11).
 *   3. Return the `MillInstance`.
 */
export async function buildFixtureMill(
  _options: BuildFixtureMillOptions = {},
): Promise<MillInstance> {
  throw new Error(
    'buildFixtureMill() — unimplemented. Implement in Story 12.8 Task 2.5.',
  );
}

/**
 * Construct an in-process sender peered to the given Mill's connector.
 *
 * RED-PHASE: throws. GREEN-PHASE: mirrors
 * `packages/sdk/src/__integration__/create-node.test.ts` peer setup.
 *
 * Caller supplies a unique `senderSeed` to guarantee a distinct Nostr
 * pubkey for AC-7 two-sender assertions.
 */
export async function buildFixtureSender(
  _mill: MillInstance,
  _senderSeed: Uint8Array,
): Promise<FixtureSender> {
  throw new Error(
    'buildFixtureSender() — unimplemented. Implement in Story 12.8 Task 2.5.',
  );
}
