/**
 * swap#153 — ROLLING swap-flow + settlement E2E, Mina target (AC-8's rolling
 * counterpart).
 *
 * Same gate as the legacy Mina suite it replaces: this repo vendors no Mina
 * lightnet, so `waitForMinaHealth()` reports not-ready and both cases skip
 * unless an operator brought one up and exported `MINA_E2E_GRAPHQL_URL` /
 * `MINA_E2E_ZKAPP_ADDRESS` (see `tests/e2e/README.md`).
 *
 * Mina carries a SECOND, deeper gap that no infra fixes: the SDK's Mina
 * settlement builder is still a stub (Story 12.6 AC-9 deferred the zkApp
 * wiring), so even with a lightnet the most this can assert is that a Mina
 * claim is routed to the Mina builder and refused there. The rolling port
 * keeps that assertion rather than pretending the chain is covered.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildSettlementTx } from '@toon-protocol/sdk';
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
  waitForMinaHealth,
  skipIfNotReady,
  acquireMinaAccount,
  releaseMinaAccount,
  PEER1_NOSTR_PUBKEY,
  PEER1_ILP_ADDRESS,
  MINA_GRAPHQL,
  MINA_ZKAPP_ADDRESS,
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_MINA,
} from './helpers/infra-gate.js';
import { ROLLING_SENDER_ILP } from './helpers/topology.js';

const PAIR: SwapPair = {
  from: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
  to: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_MINA },
  rate: '1',
};

describe('Docker Rolling Swap Mina E2E (swap#153)', () => {
  let servicesReady = false;
  let minaAccount: { pk: string; sk: string } | null = null;
  let sender: LiveSender | null = null;
  let daemon: LegBDaemon = createLegBDaemon();
  let result: RollingSwapResult | null = null;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;
    const bootstrapped = await waitForPeer2Bootstrap(45_000);
    if (!bootstrapped) return;
    const minaReady = await waitForMinaHealth(180_000);
    if (!minaReady) return;
    minaAccount = await acquireMinaAccount();
    if (!minaAccount) return;
    servicesReady = true;

    try {
      daemon = createLegBDaemon();
      sender = await buildLiveSender({
        nodeIdPrefix: 'roll-mina',
        btpServerPort: 19938,
        healthCheckPort: 19939,
        loggerName: 'swap-e2e-rolling-mina-connector',
        senderIlpAddress: ROLLING_SENDER_ILP.mina,
        localDeliveryHandler: daemon.handler,
      });
      result = await runRollingSwap({
        sender,
        daemon,
        makerPubkey: PEER1_NOSTR_PUBKEY,
        makerIlpAddress: PEER1_ILP_ADDRESS,
        pair: PAIR,
        chainRecipient: minaAccount.pk,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });
    } catch (err) {
      console.error('Mina rolling swap failed in beforeAll:', err);
    }
  }, 240_000);

  afterAll(async () => {
    if (minaAccount) await releaseMinaAccount(minaAccount.pk);
    if (sender) await sender.close();
    await new Promise((r) => setTimeout(r, 250));
  });

  it('N-1 [P1] a rolling session to mina:devnet delivers leg-B claims bound to the acquired Mina pk', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const account = present(minaAccount, 'the acquired Mina account');
    const swap = present(result, 'the Mina rolling swap result');
    expect(
      swap.state,
      `rfq: ${JSON.stringify(swap.rfqReject)} rejections: ${JSON.stringify(swap.rejections)}`
    ).toBe('completed');
    expect(swap.claims.length).toBeGreaterThanOrEqual(1);
    const first = present(swap.claims[0], 'the first leg-B claim');
    expect(first.recipient).toBe(account.pk);
    expect(first.pair.to.chain).toBe(DOCKER_CHAIN_MINA);
  });

  it('N-2 [P1] Mina leg-B claims carry settlement context and route to the (still deferred) Mina builder', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    expect(
      MINA_ZKAPP_ADDRESS,
      'MINA_ZKAPP_ADDRESS not exported — see tests/e2e/README.md'
    ).not.toBe('');
    expect(MINA_GRAPHQL).toBe('http://localhost:19085/graphql');
    const account = present(minaAccount, 'the acquired Mina account');
    const swap = present(result, 'the Mina rolling swap result');
    expect(swap.claims.length).toBeGreaterThanOrEqual(1);

    const lastClaim = present(swap.claims.at(-1), 'the last leg-B claim');
    expect(lastClaim.channelId).toBeDefined();
    expect(lastClaim.nonce).toBeDefined();
    expect(lastClaim.cumulativeAmount).toBeDefined();
    expect(lastClaim.recipient).toBe(account.pk);
    const signerAddress = present(
      lastClaim.swapSignerAddress,
      'claim.swapSignerAddress'
    );

    // The Mina settlement builder is a stub (Story 12.6 AC-9), so the
    // honest assertion is that the claim REACHES it and is refused there.
    expect(() =>
      buildSettlementTx({
        claims: swap.claims,
        signers: { [DOCKER_CHAIN_MINA]: { address: signerAddress } },
        recipients: { [DOCKER_CHAIN_MINA]: account.pk },
        verifySignatures: false,
      })
    ).toThrow(/UNSUPPORTED_CHAIN|mina/i);

    const health = await fetch(MINA_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{syncStatus}' }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(health.ok).toBe(true);
    const healthData = (await health.json()) as {
      data?: { syncStatus?: string };
    };
    expect(healthData.data?.syncStatus).toBe('SYNCED');
  });
});
