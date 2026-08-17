/**
 * swap#153 — ROLLING pair-matrix coverage.
 *
 * The rolling counterpart of `docker-swap-flow-pair-matrix-e2e.test.ts`
 * (AC-9/AC-10), with two differences that both make the matrix say more:
 *
 * 1. **Four chains, sixteen ordered pairs**, not three and nine — the second
 *    anvil (`topology.ts`'s `ANVIL_B_CHAIN_ID`) is in the matrix, so a pair
 *    that genuinely crosses a chain boundary is exercised on every CI run
 *    instead of only when an operator has brought up Solana or Mina.
 * 2. **A pair peer1 does not advertise is asserted to be REFUSED**, not
 *    skipped. The legacy matrix could only skip, so "the maker quotes a pair
 *    it cannot deliver" would have passed. Here `unsupported_pair` is the
 *    expected answer and its absence fails.
 *
 * A pair whose chains have no live backing service still skips, exactly as
 * before — see `tests/e2e/README.md` for what it takes to bring Solana and
 * Mina up.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSolanaKeypair } from '@toon-protocol/sdk';
import type { SwapPair } from '@toon-protocol/core';

import {
  buildLiveSender,
  type LiveSender,
} from './helpers/build-live-sender.js';
import {
  createLegBDaemon,
  openRollingSession,
  runRollingSwap,
  type LegBDaemon,
} from './helpers/rolling-driver.js';
import { present } from './helpers/present.js';

import {
  checkAllServicesReady,
  waitForPeer2Bootstrap,
  waitForSolanaHealth,
  waitForMinaHealth,
  skipIfNotReady,
  acquireMinaAccount,
  releaseMinaAccount,
  PEER1_NOSTR_PUBKEY,
  PEER1_ILP_ADDRESS,
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_EVM_B,
  DOCKER_CHAIN_SOLANA,
  DOCKER_CHAIN_MINA,
  ROLLING_CHAINS,
  ROLLING_PAIR_MATRIX,
  peer1AdvertisesPair,
  SWAP_E2E_EVM_SENDER_ADDRESS,
  type RollingChain,
} from './helpers/infra-gate.js';
import { ROLLING_SENDER_ILP } from './helpers/topology.js';

/** Lazily generated Solana recipient — reused across all Solana-target pairs. */
let cachedSolanaRecipient: string | null = null;

/** Distinct EVM payout address per EVM chain, so a mis-bound claim shows up. */
const EVM_B_RECIPIENT = '0x' + '7e57'.repeat(10);

function chainRecipientForTarget(
  target: RollingChain,
  minaAccountPk: string | null
): string {
  switch (target) {
    case DOCKER_CHAIN_EVM:
      return SWAP_E2E_EVM_SENDER_ADDRESS.toLowerCase();
    case DOCKER_CHAIN_EVM_B:
      return EVM_B_RECIPIENT;
    case DOCKER_CHAIN_SOLANA: {
      if (!cachedSolanaRecipient) {
        // generateSolanaKeypair() returns publicKey already base58-encoded;
        // do NOT re-encode (would throw "Cannot convert R to a BigInt").
        cachedSolanaRecipient = generateSolanaKeypair().publicKey;
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

describe('Docker Rolling Swap pair-matrix E2E (swap#153) — 16 ordered chain pairs', () => {
  let coreReady = false;
  const chainReady: Record<RollingChain, boolean> = {
    [DOCKER_CHAIN_EVM]: false,
    [DOCKER_CHAIN_EVM_B]: false,
    [DOCKER_CHAIN_SOLANA]: false,
    [DOCKER_CHAIN_MINA]: false,
  };
  let minaAccount: { pk: string; sk: string } | null = null;
  let sender: LiveSender | null = null;
  let daemon: LegBDaemon = createLegBDaemon();

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;

    // Both EVM chains are implied by checkAllServicesReady() (it probes both
    // anvils). Solana/Mina get a SHORT probe so a missing lightnet costs the
    // matrix 30 s, not 180 s, and never masks the EVM pairs.
    const [bootstrapped, solanaReady, minaReady] = await Promise.all([
      waitForPeer2Bootstrap(45_000),
      waitForSolanaHealth(30_000),
      waitForMinaHealth(30_000),
    ]);
    if (!bootstrapped) return;

    chainReady[DOCKER_CHAIN_EVM] = true;
    chainReady[DOCKER_CHAIN_EVM_B] = true;
    chainReady[DOCKER_CHAIN_SOLANA] = solanaReady;
    chainReady[DOCKER_CHAIN_MINA] = minaReady;

    if (minaReady) {
      minaAccount = await acquireMinaAccount();
      if (!minaAccount) chainReady[DOCKER_CHAIN_MINA] = false;
    }

    coreReady = true;

    try {
      daemon = createLegBDaemon();
      sender = await buildLiveSender({
        nodeIdPrefix: 'roll-mtx',
        btpServerPort: 19934,
        healthCheckPort: 19935,
        loggerName: 'swap-e2e-rolling-matrix-connector',
        senderIlpAddress: ROLLING_SENDER_ILP.matrix,
        localDeliveryHandler: daemon.handler,
        initialDeposit: '50000000', // 50 USDC — enough for the whole matrix
      });
    } catch (err) {
      console.error('Failed to build the rolling matrix sender:', err);
    }
  }, 240_000);

  afterAll(async () => {
    if (minaAccount) await releaseMinaAccount(minaAccount.pk);
    if (sender) await sender.close();
    await new Promise((r) => setTimeout(r, 250));
  });

  // -------------------------------------------------------------------
  // Coverage guard — the matrix is what it claims to be
  // -------------------------------------------------------------------
  it('M-0 coverage guard — the matrix enumerates every ordered pair over 4 chains, and at least one crosses a boundary without operator infra', () => {
    expect(ROLLING_CHAINS.length).toBe(4);
    expect(ROLLING_PAIR_MATRIX.length).toBe(16);
    const uniq = new Set(
      ROLLING_PAIR_MATRIX.map(({ from, to }) => `${from}->${to}`)
    );
    expect(uniq.size).toBe(16);

    // The pair that keeps this harness honest: advertised by peer1, backed by
    // infra this repo vendors, and crossing a chain boundary. If this ever
    // stops holding, "multi-chain coverage" is back to being a claim only.
    expect(peer1AdvertisesPair(DOCKER_CHAIN_EVM, DOCKER_CHAIN_EVM_B)).toBe(
      true
    );
    expect(DOCKER_CHAIN_EVM).not.toBe(DOCKER_CHAIN_EVM_B);
  });

  // -------------------------------------------------------------------
  // One it() per ordered pair
  // -------------------------------------------------------------------
  it.each(ROLLING_PAIR_MATRIX)(
    'M [P1] pair $from -> $to — rolling session behaves as the maker advertises',
    async (pair) => {
      if (skipIfNotReady(coreReady)) return;

      if (!chainReady[pair.from] || !chainReady[pair.to]) {
        console.log(
          `Skipping pair ${pair.from} -> ${pair.to}: chain not ready ` +
            `(from=${chainReady[pair.from]}, to=${chainReady[pair.to]})`
        );
        return;
      }

      const live = present(sender, 'the matrix sender');

      const recipient = chainRecipientForTarget(
        pair.to,
        minaAccount?.pk ?? null
      );
      expect(recipient.length).toBeGreaterThan(0);

      const swapPair: SwapPair = {
        from: { assetCode: 'USD', assetScale: 6, chain: pair.from },
        to: { assetCode: 'USD', assetScale: 6, chain: pair.to },
        rate: '1',
      };

      if (!peer1AdvertisesPair(pair.from, pair.to)) {
        // Not advertised: the maker must REFUSE at leg 0 rather than quote a
        // pair it has no inventory, signer or channel for.
        const probe = createLegBDaemon();
        const opened = await openRollingSession({
          sender: live,
          daemon: probe,
          makerPubkey: PEER1_NOSTR_PUBKEY,
          makerIlpAddress: PEER1_ILP_ADDRESS,
          pair: swapPair,
          chainRecipient: recipient,
        });
        expect(
          opened.ok,
          `peer1 quoted ${pair.from} -> ${pair.to}, which it does not advertise`
        ).toBe(false);
        if (!opened.ok) {
          expect(opened.reason).toBe('unsupported_pair');
        }
        return;
      }

      const perPairDaemon = createLegBDaemon();
      live.connector.setLocalDeliveryHandler(perPairDaemon.handler);
      const result = await runRollingSwap({
        sender: live,
        daemon: perPairDaemon,
        makerPubkey: PEER1_NOSTR_PUBKEY,
        makerIlpAddress: PEER1_ILP_ADDRESS,
        pair: swapPair,
        chainRecipient: recipient,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });

      expect(
        result.state,
        `rejections: ${JSON.stringify(result.rejections)} rfq: ${JSON.stringify(result.rfqReject)}`
      ).toBe('completed');
      expect(result.claims.length).toBeGreaterThanOrEqual(1);
      for (const claim of result.claims) {
        expect(claim.recipient?.toLowerCase()).toBe(recipient.toLowerCase());
        expect(claim.pair.to.chain).toBe(pair.to);
      }
    }
  );
});
