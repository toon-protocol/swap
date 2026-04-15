/**
 * Story 12.10 — Solana swap-flow + settlement E2E (AC-7)
 *
 * RED-PHASE. Drives `streamSwap()` with `swapPair.to.chain === 'solana:devnet'`
 * against peer2 → peer1 over real BTP, then submits the accumulated claim via
 * raw Solana JSON-RPC (`sendTransaction`) to `http://localhost:19899` and
 * asserts an on-chain effect on the channel program account.
 *
 * Settlement rubric (from story Dev Notes):
 *   Solana minimum = `CLAIM_FROM_CHANNEL` discriminator txn submitted,
 *   confirmed, and EITHER (a) recipient ATA SPL balance increased by claim
 *   amount OR (b) channel account nonce field advanced. Mirrors the pattern
 *   in `packages/sdk/tests/e2e/docker-solana-settlement-e2e.test.ts`.
 *
 * Why RED today:
 *   - Same BTP-wiring gap as the EVM flow (Task 3.3).
 *   - Solana settlement submission helper (`sendSolanaSettlementTx`) has no
 *     equivalent of viem's `sendRawTransaction` in the SDK public surface;
 *     Task 3.5 wires this through.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  checkAllServicesReady,
  waitForPeer2Bootstrap,
  waitForSolanaHealth,
  skipIfNotReady,
  SOLANA_RPC,
  SOLANA_PROGRAM_ID,
  DOCKER_CHAIN_SOLANA,
} from './helpers/infra-gate.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Deterministic 32-byte Ed25519 pubkey (base58). RED-phase sentinel — GREEN
 * phase must call `generateSolanaKeypair()` from the SDK identity module and
 * fund it via the validator's airdrop faucet before running streamSwap().
 */
const SOLANA_CHAIN_RECIPIENT_PLACEHOLDER =
  '11111111111111111111111111111111' as const; // 32-byte all-zero base58

async function buildLiveSolanaSender(): Promise<null> {
  return null;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Docker Swap-Flow Solana E2E (Story 12.10, Task 3)', () => {
  let servicesReady = false;
  let solanaReady = false;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;
    const bootstrapped = await waitForPeer2Bootstrap(45_000);
    if (!bootstrapped) return;
    solanaReady = await waitForSolanaHealth(30_000);
    if (!solanaReady) return;
    servicesReady = true;
  }, 120_000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });

  // ---------------------------------------------------------------------
  // AC-7 pt.1 — swap completion + recipient equality (Solana target)
  // ---------------------------------------------------------------------
  it('AC-7 [P1] streamSwap() to solana:devnet completes with recipient === 32-byte base58 pubkey', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const sender = await buildLiveSolanaSender();
    expect(
      sender,
      'RED: Task 3.3 must wire live sender with Solana chainRecipient'
    ).not.toBeNull();

    // GREEN:
    // const result = await streamSwap({
    //   client: sender!.client,
    //   millPubkey: …,
    //   millIlpAddress: 'g.toon.peer1',
    //   pair: {
    //     from: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
    //     to:   { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_SOLANA },
    //     rate: '1',
    //   },
    //   senderSecretKey: generateSecretKey(),
    //   chainRecipient: senderSolanaKeypair.publicKeyBase58,
    //   totalAmount: 1_000_000n,
    //   packetCount: 1,
    // });
    // expect(result.state).toBe('completed');
    // expect(result.claims.length).toBeGreaterThanOrEqual(1);
    // expect(result.claims[0]!.recipient).toBe(senderSolanaKeypair.publicKeyBase58);
  });

  // ---------------------------------------------------------------------
  // AC-7 pt.2 — on-chain settlement effect
  // ---------------------------------------------------------------------
  it('AC-7 [P1] buildSettlementTx() sendTransaction to Solana validator updates channel account state', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    // Guard: the infra script must have exported SOLANA_PROGRAM_ID.
    expect(
      SOLANA_PROGRAM_ID,
      'SOLANA_PROGRAM_ID not exported — rerun ./scripts/sdk-e2e-infra.sh up'
    ).not.toBe('');

    expect(SOLANA_RPC).toBe('http://localhost:19899');

    // GREEN flow (paraphrased from Task 3.5):
    //   1. const built = buildSettlementTx(lastClaim);  // Solana variant
    //   2. POST to SOLANA_RPC with jsonrpc sendTransaction + built.rawTx (base64).
    //   3. Poll `getTransaction(signature, 'confirmed')` until included.
    //   4. fetch channel PDA account data via getAccountInfo; decode and
    //      assert nonce > previous OR SPL balance increased.

    const settlementSubmitted = false;
    expect(
      settlementSubmitted,
      'RED: Task 3.5 must POST Solana settlement tx and verify channel PDA update'
    ).toBe(true);
  });
});
