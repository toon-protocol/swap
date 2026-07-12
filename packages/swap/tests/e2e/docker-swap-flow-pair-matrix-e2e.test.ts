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
import { streamSwap, generateSolanaKeypair } from '@toon-protocol/sdk';

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
  SWAP_E2E_EVM_SENDER_ADDRESS,
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
      return SWAP_E2E_EVM_SENDER_ADDRESS.toLowerCase();
    case DOCKER_CHAIN_SOLANA: {
      if (!cachedSolanaRecipient) {
        // generateSolanaKeypair() returns publicKey already base58-encoded;
        // do NOT re-encode (would throw "Cannot convert R to a BigInt").
        const identity = generateSolanaKeypair();
        cachedSolanaRecipient = identity.publicKey;
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
// swap-node E2E test files to eliminate ~80 lines of duplicated wiring per file).

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Docker Swap-Flow Pair-Matrix E2E (Story 12.10, Task 5) — 9 ordered chain pairs', () => {
  // Core readiness — peer1/peer2 BLS+relay, Anvil. Required for any pair.
  let coreReady = false;
  // Per-chain readiness — gate each pair on whether its source AND target
  // chain are actually live in the SDK E2E topology. This avoids the previous
  // false-skip behavior where Mina lightnet's slow/flaky GraphQL endpoint
  // (often returns ECONNRESET on `{syncStatus}`) caused the whole matrix to
  // skip silently for ~180 s, masking 4-of-9 EVM/Solana pairs that should run.
  const chainReady: Record<DockerChain, boolean> = {
    [DOCKER_CHAIN_EVM]: false,
    [DOCKER_CHAIN_SOLANA]: false,
    [DOCKER_CHAIN_MINA]: false,
  };
  let minaAccount: { pk: string; sk: string } | null = null;
  let sharedSender: LiveSender | null = null;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;

    // EVM availability is implied by checkAllServicesReady() (Anvil probe).
    // Probe Solana and Mina independently in parallel — Mina uses a SHORT
    // 30 s timeout here (not 180 s) because we now gate per-pair: a missing
    // Mina lightnet means the 5 Mina-touching pairs skip, while the 4 pairs
    // not touching Mina (EVM↔EVM, EVM↔Solana, Solana↔Solana) still execute.
    const [bootstrapped, solanaReady, minaReady] = await Promise.all([
      waitForPeer2Bootstrap(45_000),
      waitForSolanaHealth(30_000),
      waitForMinaHealth(30_000),
    ]);
    if (!bootstrapped) return;

    chainReady[DOCKER_CHAIN_EVM] = true;
    chainReady[DOCKER_CHAIN_SOLANA] = solanaReady;
    chainReady[DOCKER_CHAIN_MINA] = minaReady;

    if (minaReady) {
      minaAccount = await acquireMinaAccount();
      if (!minaAccount) chainReady[DOCKER_CHAIN_MINA] = false;
    }

    coreReady = true;

    try {
      sharedSender = await buildLiveSender({
        nodeIdPrefix: 'swap-mtx',
        btpServerPort: 19926,
        healthCheckPort: 19927,
        loggerName: 'swap-e2e-matrix-connector',
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
      // Runtime skip when CORE infra is not ready (Anvil/peer1/peer2 down).
      if (skipIfNotReady(coreReady)) return;

      // Per-pair skip when EITHER side of the pair targets a chain whose
      // backing service isn't healthy in the current topology. This is the
      // fix for the prior false-skip: instead of gating all 9 pairs on the
      // strictest chain (Mina), we gate each pair on its own dependencies
      // so the 4 non-Mina pairs (EVM↔EVM, EVM↔Solana, Solana↔Solana) run
      // even when Mina lightnet is down.
      if (!chainReady[pair.from] || !chainReady[pair.to]) {
        console.log(
          `Skipping pair ${pair.from} → ${pair.to}: chain not ready ` +
            `(from=${chainReady[pair.from]}, to=${chainReady[pair.to]})`
        );
        return;
      }

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
        swapPubkey: PEER1_NOSTR_PUBKEY,
        swapIlpAddress: 'g.toon.peer1',
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
