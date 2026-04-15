/**
 * Story 12.10 — Pair-matrix coverage (AC-9, AC-10)
 *
 * RED-PHASE. Covers all 9 ordered `(sourceChain, targetChain)` permutations
 * across `{evm:base:31337, solana:devnet, mina:devnet}`. Each case runs
 * `streamSwap()` end-to-end through peer2 → peer1 and asserts:
 *   - `result.state === 'completed'`
 *   - `result.claims.length >= 1`
 *   - every `claim.recipient === sender.chainRecipient` (format per target chain)
 *
 * Settlement submission is NOT asserted here — covered by the three dedicated
 * per-chain test files (AC-6/7/8) to keep the matrix fast and DRY.
 *
 * Topology: AC-10 Option A (reuse peer1/peer2 as-is) — compose file already
 * advertises all three chains on both peers. If a per-chain wallet gap
 * surfaces at Task 5.3, add `peer3` reusing `image: toon:optimized` and
 * document in Dev Notes. No image rebuilds.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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
// Per-target chainRecipient factory (format gate per target chain)
// ---------------------------------------------------------------------------

function chainRecipientForTarget(
  target: DockerChain,
  minaAccountPk: string | null
): string {
  switch (target) {
    case DOCKER_CHAIN_EVM:
      return MILL_E2E_EVM_SENDER_ADDRESS.toLowerCase();
    case DOCKER_CHAIN_SOLANA:
      // Deterministic 32-byte zero pubkey for RED-phase structure checks;
      // GREEN phase should use a freshly generated Ed25519 keypair so each
      // matrix case has a unique recipient (per-pair isolation).
      return '11111111111111111111111111111111';
    case DOCKER_CHAIN_MINA:
      return (
        minaAccountPk ??
        // Valid Mina public key string shape (B62 prefix). Only used when
        // the acquire-account pool was unavailable; test will skip anyway.
        'B62qrPN5Y5yq8kGE3FbVKbGTdTAJNdtNtB5sNVpxyRwWGcDEhpMzc8g'
      );
  }
}

async function buildLiveMatrixSender(
  _source: DockerChain,
  _target: DockerChain
): Promise<null> {
  return null;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Docker Swap-Flow Pair-Matrix E2E (Story 12.10, Task 5) — 9 ordered chain pairs', () => {
  let servicesReady = false;
  let minaAccount: { pk: string; sk: string } | null = null;

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
    servicesReady = true;
  }, 240_000);

  afterAll(async () => {
    if (minaAccount) await releaseMinaAccount(minaAccount.pk);
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
    'AC-9 [P1] pair %s → %s — streamSwap completes with recipient-bound claims',
    async (pair, ctx) => {
      // Note: vitest's `it.each` passes args positionally; runtime ctx is
      // the last argument when using context-based skip. We use a guard.
      const runCtx = (ctx ??
        (pair as unknown as { skip: () => void })) as {
        skip: () => void;
      };
      if (skipIfNotReady(servicesReady)) {
        if (typeof runCtx?.skip === 'function') return runCtx.skip();
        return;
      }

      const target = pair.to;
      const recipient = chainRecipientForTarget(
        target,
        minaAccount?.pk ?? null
      );
      expect(recipient.length).toBeGreaterThan(0);

      const sender = await buildLiveMatrixSender(pair.from, pair.to);
      expect(
        sender,
        `RED: Task 5.2 must wire live sender for pair ${pair.from}→${pair.to}`
      ).not.toBeNull();

      // GREEN flow per pair:
      // const result = await streamSwap({
      //   client: sender!.client,
      //   millPubkey: …,
      //   millIlpAddress: 'g.toon.peer1',
      //   pair: {
      //     from: { assetCode: 'USD', assetScale: 6, chain: pair.from },
      //     to:   { assetCode: 'USD', assetScale: 6, chain: pair.to },
      //     rate: '1',
      //   },
      //   senderSecretKey: generateSecretKey(),
      //   chainRecipient: recipient,
      //   totalAmount: 1_000_000n,
      //   packetCount: 1,
      // });
      // expect(result.state).toBe('completed');
      // expect(result.claims.length).toBeGreaterThanOrEqual(1);
      // for (const c of result.claims) expect(c.recipient).toBe(recipient);
    }
  );
});
