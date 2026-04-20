/**
 * Story 12.10 — Pair-matrix coverage (AC-9, AC-10)
 *
 * GREEN-PHASE. Covers all 9 ordered `(sourceChain, targetChain)` permutations
 * across `{evm:base:31337, solana:devnet, mina:devnet}`. Each case runs
 * `streamSwap()` end-to-end through sender → peer1 and asserts:
 *   - `result.state === 'completed'`
 *   - `result.claims.length >= 1`
 *   - every `claim.recipient === sender.chainRecipient` (format per target chain)
 *
 * Settlement submission is NOT asserted here — covered by the three dedicated
 * per-chain test files (AC-6/7/8) to keep the matrix fast and DRY.
 *
 * Topology: AC-10 Option A (reuse peer1/peer2 as-is) — compose file already
 * advertises all three chains on both peers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  streamSwap,
  generateSolanaKeypair,
  base58Encode,
} from '@toon-protocol/sdk';

import {
  buildLiveSender,
  type LiveSender,
} from './helpers/build-live-sender.js';

import {
  checkAllServicesReady,
  waitForPeer2Bootstrap,
  waitForSolanaHealth,
  waitForMinaHealth,
  skipIfNotReady,
  acquireMinaAccount,
  releaseMinaAccount,
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_SOLANA,
  DOCKER_CHAIN_MINA,
  DOCKER_PAIR_MATRIX,
  MILL_E2E_EVM_SENDER_ADDRESS,
  type DockerChain,
} from './helpers/infra-gate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PEER1_NOSTR_PUBKEY =
  'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35';

// ---------------------------------------------------------------------------
// Per-target chainRecipient factory (format gate per target chain)
// ---------------------------------------------------------------------------

/** Lazily generated Solana recipient — reused across all Solana-target pairs. */
let cachedSolanaRecipient: string | null = null;

function chainRecipientForTarget(
  target: DockerChain,
  minaAccountPk: string | null
): string {
  switch (target) {
    case DOCKER_CHAIN_EVM:
      return MILL_E2E_EVM_SENDER_ADDRESS.toLowerCase();
    case DOCKER_CHAIN_SOLANA: {
      if (!cachedSolanaRecipient) {
        const identity = generateSolanaKeypair();
        cachedSolanaRecipient = base58Encode(identity.publicKey);
      }
      return cachedSolanaRecipient;
    }
    case DOCKER_CHAIN_MINA:
      if (!minaAccountPk) {
        throw new Error(
          'Mina account not acquired — cannot generate chainRecipient for mina:devnet target'
        );
      }
      return minaAccountPk;
  }
}

// Sender builder extracted to helpers/build-live-sender.ts (shared across all
// Mill E2E test files to eliminate ~80 lines of duplicated wiring per file).

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Docker Swap-Flow Pair-Matrix E2E (Story 12.10, Task 5) — 9 ordered chain pairs', () => {
  let servicesReady = false;
  let minaAccount: { pk: string; sk: string } | null = null;
  let sharedSender: LiveSender | null = null;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;

    const [bootstrapped, solanaReady, minaReady] = await Promise.all([
      waitForPeer2Bootstrap(45_000),
      waitForSolanaHealth(30_000),
      waitForMinaHealth(180_000),
    ]);
    if (!bootstrapped || !solanaReady || !minaReady) return;

    minaAccount = await acquireMinaAccount();
    if (!minaAccount) return;
    servicesReady = true;

    try {
      sharedSender = await buildLiveSender({
        nodeIdPrefix: 'mill-mtx',
        btpServerPort: 19926,
        healthCheckPort: 19927,
        loggerName: 'mill-e2e-matrix-connector',
        initialDeposit: '50000000', // 50 USDC -- enough for 9 x 1 USDC swaps
      });
    } catch (err) {
      console.error('Failed to build shared sender for pair matrix:', err);
    }
  }, 240_000);

  afterAll(async () => {
    if (minaAccount) await releaseMinaAccount(minaAccount.pk);
    if (sharedSender) await sharedSender.close();
    await new Promise((r) => setTimeout(r, 250));
  });

  // -------------------------------------------------------------------
  // AC-9 matrix enforcement — coverage count guard
  // -------------------------------------------------------------------
  it('AC-9 coverage guard — matrix enumerates exactly 9 ordered (source, target) pairs', () => {
    expect(DOCKER_PAIR_MATRIX.length).toBe(9);
    const uniq = new Set(
      DOCKER_PAIR_MATRIX.map(({ from, to }) => `${from}→${to}`)
    );
    expect(uniq.size).toBe(9);
  });

  // -------------------------------------------------------------------
  // AC-9 — one it() per pair via it.each
  // -------------------------------------------------------------------
  it.each(DOCKER_PAIR_MATRIX)(
    'AC-9 [P1] pair $from → $to — streamSwap completes with recipient-bound claims',
    async (pair) => {
      // Runtime skip when infra is not ready.
      // NOTE: vitest it.each does not pass test context as a second argument,
      // so we cannot call ctx.skip(). Instead, skipIfNotReady logs and returns
      // true (or throws in CI), and we return early. Vitest records this as
      // a pass, not a skip — acceptable for E2E tests gated by beforeAll.
      if (skipIfNotReady(servicesReady)) return;

      expect(
        sharedSender,
        'Shared sender must be built in beforeAll'
      ).not.toBeNull();

      const target = pair.to;
      const recipient = chainRecipientForTarget(
        target,
        minaAccount?.pk ?? null
      );
      expect(recipient.length).toBeGreaterThan(0);

      // Run streamSwap for this pair
      const result = await streamSwap({
        client: sharedSender!.client,
        millPubkey: PEER1_NOSTR_PUBKEY,
        millIlpAddress: 'g.toon.peer1',
        pair: {
          from: {
            assetCode: 'USD',
            assetScale: 6,
            chain: pair.from,
          },
          to: {
            assetCode: 'USD',
            assetScale: 6,
            chain: pair.to,
          },
          rate: '1',
        },
        senderSecretKey: sharedSender!.senderSecretKey,
        chainRecipient: recipient,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });

      expect(result.state).toBe('completed');
      expect(result.claims.length).toBeGreaterThanOrEqual(1);
      for (const c of result.claims) {
        expect(c.recipient).toBe(recipient);
      }
    }
  );
});
