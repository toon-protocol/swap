/**
 * swap#153 — ROLLING swap-flow + settlement E2E, Solana target (AC-7's
 * rolling counterpart).
 *
 * Same gate as the legacy Solana suite it replaces: this repo vendors no
 * `solana-test-validator`, so `waitForSolanaHealth()` reports not-ready and
 * both cases skip unless an operator brought the chain up and exported
 * `SOLANA_E2E_RPC_URL` / `SOLANA_E2E_PROGRAM_ID` (see `tests/e2e/README.md`).
 * That gap is infra, not protocol: leg A on Solana is exercisable against a
 * local validator that clones the real devnet program so PDAs match — the
 * toon-meta#394 T6 rig did exactly that — and `peer-node.ts` grew a
 * multi-chain shape in this ticket precisely so wiring a Solana pair here is
 * a config change rather than a rewrite.
 *
 * Until then the chain boundary that IS crossed on every CI run is the second
 * anvil — `docker-rolling-swap-cross-chain-e2e.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildSettlementTx, generateSolanaKeypair } from '@toon-protocol/sdk';
import type { SwapPair } from '@toon-protocol/core';

import {
  buildLiveSender,
  type LiveSender,
} from './helpers/build-live-sender.js';
import {
  createLegBDaemon,
  runRollingSwap,
  type LegBDaemon,
  type RollingSwapResult,
} from './helpers/rolling-driver.js';
import { present } from './helpers/present.js';

import {
  checkAllServicesReady,
  waitForPeer2Bootstrap,
  waitForSolanaHealth,
  skipIfNotReady,
  PEER1_NOSTR_PUBKEY,
  PEER1_ILP_ADDRESS,
  SOLANA_RPC,
  SOLANA_PROGRAM_ID,
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_SOLANA,
} from './helpers/infra-gate.js';
import { ROLLING_SENDER_ILP } from './helpers/topology.js';

const PAIR: SwapPair = {
  from: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
  to: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_SOLANA },
  rate: '1',
};

describe('Docker Rolling Swap Solana E2E (swap#153)', () => {
  let servicesReady = false;
  let sender: LiveSender | null = null;
  let daemon: LegBDaemon = createLegBDaemon();
  let solanaRecipient = '';
  let result: RollingSwapResult | null = null;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;
    const bootstrapped = await waitForPeer2Bootstrap(45_000);
    if (!bootstrapped) return;
    const solanaReady = await waitForSolanaHealth(30_000);
    if (!solanaReady) return;
    servicesReady = true;

    try {
      daemon = createLegBDaemon();
      sender = await buildLiveSender({
        nodeIdPrefix: 'roll-sol',
        btpServerPort: 19936,
        healthCheckPort: 19937,
        loggerName: 'swap-e2e-rolling-solana-connector',
        senderIlpAddress: ROLLING_SENDER_ILP.solana,
        localDeliveryHandler: daemon.handler,
      });
      // generateSolanaKeypair() returns publicKey already base58-encoded;
      // do NOT re-encode (that would treat the string as a byte array and
      // throw "Cannot convert R to a BigInt" inside base58Encode).
      solanaRecipient = generateSolanaKeypair().publicKey;
      result = await runRollingSwap({
        sender,
        daemon,
        makerPubkey: PEER1_NOSTR_PUBKEY,
        makerIlpAddress: PEER1_ILP_ADDRESS,
        pair: PAIR,
        chainRecipient: solanaRecipient,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });
    } catch (err) {
      console.error('Solana rolling swap failed in beforeAll:', err);
    }
  }, 120_000);

  afterAll(async () => {
    if (sender) await sender.close();
    await new Promise((r) => setTimeout(r, 250));
  });

  it('S-1 [P1] a rolling session to solana:devnet delivers leg-B claims bound to a 32-byte base58 pubkey', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const swap = present(result, 'the Solana rolling swap result');
    expect(
      swap.state,
      `rfq: ${JSON.stringify(swap.rfqReject)} rejections: ${JSON.stringify(swap.rejections)}`
    ).toBe('completed');
    expect(swap.claims.length).toBeGreaterThanOrEqual(1);
    const first = present(swap.claims[0], 'the first leg-B claim');
    expect(first.recipient).toBe(solanaRecipient);
    expect(first.pair.to.chain).toBe(DOCKER_CHAIN_SOLANA);
  });

  it('S-2 [P1] buildSettlementTx() over the leg-B claims produces a valid Solana bundle', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    expect(
      SOLANA_PROGRAM_ID,
      'SOLANA_PROGRAM_ID not exported — see tests/e2e/README.md'
    ).not.toBe('');
    expect(SOLANA_RPC).toBe('http://localhost:19899');
    const swap = present(result, 'the Solana rolling swap result');
    expect(swap.claims.length).toBeGreaterThanOrEqual(1);

    const lastClaim = present(swap.claims.at(-1), 'the last leg-B claim');
    const settlement = buildSettlementTx({
      claims: swap.claims,
      signers: {
        [DOCKER_CHAIN_SOLANA]: {
          address: present(
            lastClaim.swapSignerAddress,
            'claim.swapSignerAddress'
          ),
          programId: SOLANA_PROGRAM_ID,
        },
      },
      recipients: { [DOCKER_CHAIN_SOLANA]: solanaRecipient },
      verifySignatures: false,
    });

    expect(settlement.bundles.length).toBeGreaterThanOrEqual(1);
    const bundle = present(settlement.bundles[0], 'the settlement bundle');
    expect(bundle.chainKind).toBe('solana');
    expect(bundle.chain).toBe(DOCKER_CHAIN_SOLANA);
    expect(bundle.channelId).toBe(lastClaim.channelId);
    expect(bundle.nonce).toBe(lastClaim.nonce);
    expect(bundle.cumulativeAmount).toBe(lastClaim.cumulativeAmount);
    expect(bundle.recipient).toBe(solanaRecipient);
    expect(bundle.unsignedTxBytes.length).toBeGreaterThan(0);
    expect(bundle.claimsMerged).toBeGreaterThanOrEqual(1);
  });
});
