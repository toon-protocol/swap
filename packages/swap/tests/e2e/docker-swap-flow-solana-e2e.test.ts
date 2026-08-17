/**
 * Story 12.10 — Solana swap-flow + settlement E2E (AC-7)
 *
 * Drives `streamSwap()` with `swapPair.to.chain === 'solana:devnet'` against
 * sender → peer1 over real BTP and asserts the leg-B claims plus the SHAPE of the
 * `buildSettlementTx` bundle built from them.
 *
 * It does NOT broadcast. This docblock claimed for two stories that it "submits
 * the accumulated claim via raw Solana JSON-RPC (`sendTransaction`) and asserts
 * an on-chain effect"; the file has never contained a `sendTransaction` call, and
 * the settlement rubric it quoted (a confirmed `CLAIM_FROM_CHANNEL` txn advancing
 * the channel account's nonce) has never been met here. Corrected in swap#164 —
 * a stale claim in a docblock is how a defect stays invisible.
 *
 * Redeeming from this suite is unblocked upstream but not in this repo yet: the
 * builder's encoding is fixed in toon#214 and the maker's signer is fixed in
 * swap#164, but this package pins the published `@toon-protocol/sdk@^3.2.0`,
 * which still carries the broken builder. See the `buildSettlementTx` NOTE in
 * `docker-rolling-swap-solana-e2e.test.ts` and the README's "known gaps".
 *
 * swap#160: this suite now EXECUTES. It used to collect two tests and skip both
 * because nothing ever brought a validator up; `global-setup.ts` now boots a
 * real one with the vendored payment-channel program baked into genesis. It is
 * the legacy `streamSwap()` twin of `docker-rolling-swap-solana-e2e.test.ts` and
 * stays until Stage 5 of toon-meta#411 retires the legacy path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  streamSwap,
  buildSettlementTx,
  generateSolanaKeypair,
  type StreamSwapResult,
} from '@toon-protocol/sdk';

import {
  buildLiveSender,
  type LiveSender,
} from './helpers/build-live-sender.js';

import {
  checkAllServicesReady,
  waitForPeer2Bootstrap,
  waitForSolanaHealth,
  skipIfNotReady,
  PEER1_NOSTR_PUBKEY,
  SOLANA_RPC,
  SOLANA_PROGRAM_ID,
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_SOLANA,
} from './helpers/infra-gate.js';
import { SOLANA_RPC_URL } from './helpers/topology.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Sender builder extracted to helpers/build-live-sender.ts (shared across all
// swap-node E2E test files to eliminate ~80 lines of duplicated wiring per file).

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Docker Swap-Flow Solana E2E (Story 12.10, Task 3)', () => {
  let servicesReady = false;
  let sender: (LiveSender & { solanaRecipient: string }) | null = null;
  let swapResult: StreamSwapResult | null = null;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;
    const bootstrapped = await waitForPeer2Bootstrap(45_000);
    if (!bootstrapped) return;
    const solanaReady = await waitForSolanaHealth(30_000);
    if (!solanaReady) return;
    servicesReady = true;

    try {
      const baseSender = await buildLiveSender({
        nodeIdPrefix: 'swap-sol',
        btpServerPort: 19922,
        healthCheckPort: 19923,
        loggerName: 'swap-e2e-solana-connector',
      });
      // Generate a Solana keypair for the chain-recipient.
      // generateSolanaKeypair() returns publicKey already base58-encoded;
      // do NOT re-encode (that would treat the string as a byte array
      // and throw "Cannot convert R to a BigInt" inside base58Encode).
      const solanaIdentity = generateSolanaKeypair();
      const solanaRecipient = solanaIdentity.publicKey;
      sender = { ...baseSender, solanaRecipient };
      swapResult = await streamSwap({
        client: sender.client,
        swapPubkey: PEER1_NOSTR_PUBKEY,
        swapIlpAddress: 'g.toon.peer1',
        pair: {
          from: {
            assetCode: 'USD',
            assetScale: 6,
            chain: DOCKER_CHAIN_EVM,
          },
          to: {
            assetCode: 'USD',
            assetScale: 6,
            chain: DOCKER_CHAIN_SOLANA,
          },
          rate: '1',
        },
        senderSecretKey: sender.senderSecretKey,
        chainRecipient: sender.solanaRecipient,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });
    } catch (err) {
      console.error('Solana swap failed in beforeAll:', err);
    }
  }, 120_000);

  afterAll(async () => {
    if (sender) await sender.close();
    await new Promise((r) => setTimeout(r, 250));
  });

  // ---------------------------------------------------------------------
  // AC-7 pt.1 — swap completion + recipient equality (Solana target)
  // ---------------------------------------------------------------------
  it('AC-7 [P1] streamSwap() to solana:devnet completes with recipient === 32-byte base58 pubkey', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    expect(sender, 'Sender must be built').not.toBeNull();
    expect(swapResult, 'streamSwap must have been called').not.toBeNull();

    expect(swapResult!.state).toBe('completed');
    expect(swapResult!.claims.length).toBeGreaterThanOrEqual(1);
    expect(swapResult!.claims[0]!.recipient).toBe(sender!.solanaRecipient);
  });

  // ---------------------------------------------------------------------
  // AC-7 pt.2 — settlement bundle verification
  //
  // Rubric: buildSettlementTx() produces a valid Solana settlement bundle
  // with the correct channelId, nonce, cumulativeAmount, recipient, and
  // programId. The bundle's unsignedTxBytes contain a serialized Solana
  // Message template (placeholder blockhash). Full on-chain submission
  // (patch blockhash + sign + sendTransaction + getAccountInfo) follows
  // the pattern in docker-solana-settlement-e2e.test.ts.
  // ---------------------------------------------------------------------
  it('AC-7 [P1] buildSettlementTx() produces valid Solana settlement bundle', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    expect(
      SOLANA_PROGRAM_ID,
      'SOLANA_PROGRAM_ID unset — solana-validator.ts should default it'
    ).not.toBe('');
    expect(SOLANA_RPC).toBe(SOLANA_RPC_URL);

    expect(sender, 'Sender must be built').not.toBeNull();
    expect(swapResult, 'streamSwap must have completed').not.toBeNull();
    expect(
      swapResult!.claims.length,
      'Need at least 1 claim'
    ).toBeGreaterThanOrEqual(1);

    const lastClaim = swapResult!.claims[swapResult!.claims.length - 1]!;
    expect(lastClaim.channelId).toBeDefined();
    expect(lastClaim.nonce).toBeDefined();
    expect(lastClaim.cumulativeAmount).toBeDefined();
    expect(lastClaim.recipient).toBeDefined();
    expect(lastClaim.swapSignerAddress).toBeDefined();

    // Build settlement transaction
    const settlementResult = buildSettlementTx({
      claims: swapResult!.claims,
      signers: {
        [DOCKER_CHAIN_SOLANA]: {
          address: lastClaim.swapSignerAddress!,
          programId: SOLANA_PROGRAM_ID,
        },
      },
      recipients: {
        [DOCKER_CHAIN_SOLANA]: sender!.solanaRecipient,
      },
      verifySignatures: false,
    });

    expect(
      settlementResult.bundles.length,
      'Should produce at least 1 settlement bundle'
    ).toBeGreaterThanOrEqual(1);

    const bundle = settlementResult.bundles[0]!;

    // Verify bundle metadata
    expect(bundle.chainKind).toBe('solana');
    expect(bundle.chain).toBe(DOCKER_CHAIN_SOLANA);
    expect(bundle.channelId).toBe(lastClaim.channelId);
    expect(bundle.nonce).toBe(lastClaim.nonce);
    expect(bundle.cumulativeAmount).toBe(lastClaim.cumulativeAmount);
    expect(bundle.recipient).toBe(sender!.solanaRecipient);
    expect(bundle.swapSignerAddress).toBe(lastClaim.swapSignerAddress);
    expect(bundle.unsignedTxBytes.length).toBeGreaterThan(0);
    expect(bundle.claimsMerged).toBeGreaterThanOrEqual(1);
  });
});
