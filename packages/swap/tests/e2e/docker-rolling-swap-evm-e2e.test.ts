/**
 * swap#153 — ROLLING swap-flow + settlement E2E, EVM leg.
 *
 * The rolling counterpart of `docker-swap-flow-evm-e2e.test.ts` (AC-3..AC-6),
 * which drives the legacy zero-condition `streamSwap` sender ADR 0003
 * removes. Same infra, same peer1, same socket — different protocol:
 * kind:20033 RFQ → kind:20034 quote → coupled fills carrying a real 32-byte
 * sender-minted execution condition, with the chain-B claim arriving on LEG B
 * rather than inside the leg-A FULFILL.
 *
 * Both suites run side by side until Stage 5 removes the maker's legacy
 * intake; nothing here deletes anything.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { buildSettlementTx, fillEvmSettlementTxGas } from '@toon-protocol/sdk';
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
  type RollingSession,
  type RollingSwapResult,
} from './helpers/rolling-driver.js';
import { present } from './helpers/present.js';

import {
  checkAllServicesReady,
  waitForPeer2Bootstrap,
  skipIfNotReady,
  PEER1_NOSTR_PUBKEY,
  PEER1_ILP_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  ROLLING_CHANNEL_ADDRESS,
  CHAIN_ID,
  createViemClient,
  SWAP_E2E_EVM_SENDER_ADDRESS,
  DOCKER_CHAIN_EVM,
} from './helpers/infra-gate.js';
import { ROLLING_SENDER_ILP } from './helpers/topology.js';

/** Sender's 20-byte EVM payout address (lowercase hex with `0x`). */
const EVM_CHAIN_RECIPIENT = SWAP_E2E_EVM_SENDER_ADDRESS.toLowerCase();

/** The same-chain pair peer1 has always advertised (see `peer-node.ts`). */
const PAIR: SwapPair = {
  from: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
  to: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
  rate: '1',
};

const TOTAL = 1_000_000n;
const PACKETS = 2;

describe('Docker Rolling Swap EVM E2E (swap#153)', () => {
  let servicesReady = false;
  let sender: LiveSender | null = null;
  let daemon: LegBDaemon = createLegBDaemon();
  let result: RollingSwapResult | null = null;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;
    const bootstrapped = await waitForPeer2Bootstrap(45_000);
    if (!bootstrapped) return;
    servicesReady = true;

    try {
      daemon = createLegBDaemon();
      sender = await buildLiveSender({
        nodeIdPrefix: 'roll-evm',
        btpServerPort: 19930,
        healthCheckPort: 19931,
        loggerName: 'swap-e2e-rolling-evm-connector',
        senderIlpAddress: ROLLING_SENDER_ILP.evm,
        localDeliveryHandler: daemon.handler,
      });
      result = await runRollingSwap({
        sender,
        daemon,
        makerPubkey: PEER1_NOSTR_PUBKEY,
        makerIlpAddress: PEER1_ILP_ADDRESS,
        pair: PAIR,
        chainRecipient: EVM_CHAIN_RECIPIENT,
        totalAmount: TOTAL,
        packetCount: PACKETS,
      });
    } catch (err) {
      console.error('EVM rolling swap failed in beforeAll:', err);
    }
  }, 120_000);

  afterAll(async () => {
    if (sender) await sender.close();
    await new Promise((r) => setTimeout(r, 250));
  });

  // ---------------------------------------------------------------------
  // R-1 — leg 0: the RFQ is answered with a kind:20034 quote
  // ---------------------------------------------------------------------
  it('R-1 [P1] the RFQ round-trips over real BTP and returns a quote bound to the session', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const swap = present(result, 'the rolling swap result');
    expect(
      swap.rfqReject,
      `leg 0 was refused: ${JSON.stringify(swap.rfqReject)}`
    ).toBeUndefined();

    const quote = present(swap.quote, 'the kind:20034 quote');
    expect(quote.proto).toBe('rolling/1');
    expect(quote.type).toBe('quote');
    // The session id the SENDER minted, echoed — this is what every fill and
    // every leg B in the session is keyed by.
    expect(quote.streamNonce).toBe(swap.streamNonce);
    expect(Number(quote.rate)).toBeGreaterThan(0);
    expect(quote.expiresAt).toBeGreaterThan(Date.now() - 60_000);
    // Armed before the first fill so the sender can verify leg B on arrival
    // rather than trusting whatever the first advance echoes (spec §2.2).
    expect(quote.swapSignerAddress).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // R-2 — legs A and B complete, coupled by the sender's own condition
  // ---------------------------------------------------------------------
  it('R-2 [P1] coupled fills complete: leg B delivers a recipient-bound claim and leg A fulfils with the sender preimage', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const swap = present(result, 'the rolling swap result');
    expect(swap.state, `rejections: ${JSON.stringify(swap.rejections)}`).toBe(
      'completed'
    );

    // One accept record per fill, and one leg-B advance per fill: the claim
    // now travels on leg B, which is the headline change vs the legacy path.
    expect(swap.accepts).toHaveLength(PACKETS);
    expect(swap.advances).toHaveLength(PACKETS);
    expect(swap.claims).toHaveLength(PACKETS);
    expect(daemon.refusals, 'no leg B should have failed R5').toEqual([]);

    for (const claim of swap.claims) {
      expect(claim.recipient?.toLowerCase()).toBe(EVM_CHAIN_RECIPIENT);
      expect(claim.claimBytes.length).toBeGreaterThan(0);
      expect(claim.channelId).toBeDefined();
      expect(claim.swapSignerAddress).toBeDefined();
    }

    // The watermark advanced monotonically across the stream (spec §4).
    const cumulatives = swap.claims.map((c) =>
      BigInt(present(c.cumulativeAmount, 'claim.cumulativeAmount'))
    );
    for (let i = 1; i < cumulatives.length; i++) {
      const prev = present(cumulatives[i - 1], 'previous cumulative');
      const next = present(cumulatives[i], 'next cumulative');
      expect(next > prev).toBe(true);
    }

    // Every accept echoes the maker's quote tape for the fill it accepted.
    for (const accept of swap.accepts) {
      expect(accept.streamNonce).toBe(swap.streamNonce);
      expect(Number(accept.rate)).toBeGreaterThan(0);
      expect(BigInt(accept.targetAmount)).toBeGreaterThan(0n);
    }
  });

  // ---------------------------------------------------------------------
  // R-3 — the coupling itself: sha256(fulfillment) === the sender's condition
  // ---------------------------------------------------------------------
  it('R-3 [P1] a fresh fill returns the preimage of the condition the SENDER minted (spec R4/R6)', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const live = present(sender, 'the rolling sender');
    const session = await openSession(live, daemonForProbe(live));
    const outcome = await session.fill({ seq: 1, amount: 250_000n });
    expect(
      outcome.accepted,
      outcome.accepted ? '' : `${outcome.code}: ${outcome.message}`
    ).toBe(true);
    if (!outcome.accepted) return;

    expect(outcome.fulfillment.length).toBe(32);
    expect(Buffer.from(sha256(outcome.fulfillment)).toString('base64')).toBe(
      Buffer.from(sha256(outcome.preimage)).toString('base64')
    );
    expect(
      Buffer.from(outcome.fulfillment).equals(Buffer.from(outcome.preimage))
    ).toBe(true);
  });

  // ---------------------------------------------------------------------
  // R-4 — withhold: a sender that refuses leg B gets no fill and pays nothing
  // ---------------------------------------------------------------------
  it('R-4 [P1] withholding the leg-B preimage leaves leg A rejected — no claim, no debit (spec R5/R8)', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const live = present(sender, 'the rolling sender');
    const probe = daemonForProbe(live);
    const session = await openSession(live, probe);
    probe.reveal = false;
    const outcome = await session.fill({ seq: 1, amount: 250_000n });

    // Leg B was DELIVERED (so this is a real withhold, not the pre-swap#148
    // `F02 no route found`) …
    expect(probe.advances.length).toBe(1);
    // … but the sender never revealed, so leg A cannot fulfil and no claim
    // was accepted.
    expect(outcome.accepted).toBe(false);
    expect(probe.claims).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // R-5 — settlement: the leg-B claims build a valid EVM settlement bundle
  // ---------------------------------------------------------------------
  it('R-5 [P1] buildSettlementTx() over the LEG-B claims produces a valid EVM bundle', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const swap = present(result, 'the rolling swap result');
    expect(swap.claims.length).toBeGreaterThanOrEqual(1);

    // Config-drift guards — leg A and leg B are two different contracts
    // (issue #133), and a claim built against the wrong one is unredeemable.
    expect(TOKEN_NETWORK_ADDRESS).toBe(
      '0xCafac3dD18aC6c6e92c921884f9E4176737C052c'
    );
    expect(ROLLING_CHANNEL_ADDRESS).toBe(
      '0x0165878A594ca255338adfa4d48449f69242Eb8F'
    );

    const lastClaim = present(swap.claims.at(-1), 'the last leg-B claim');
    const signerConfig = {
      address: present(
        lastClaim.swapSignerAddress,
        'claim.swapSignerAddress'
      ).toLowerCase(),
      contractAddress: ROLLING_CHANNEL_ADDRESS.toLowerCase(),
      chainId: CHAIN_ID,
    };

    const settlement = buildSettlementTx({
      claims: swap.claims,
      signers: { [DOCKER_CHAIN_EVM]: signerConfig },
      recipients: { [DOCKER_CHAIN_EVM]: EVM_CHAIN_RECIPIENT },
      verifySignatures: false,
    });

    expect(settlement.bundles.length).toBeGreaterThanOrEqual(1);
    const bundle = present(settlement.bundles[0], 'the settlement bundle');
    expect(bundle.chainKind).toBe('evm');
    expect(bundle.chain).toBe(DOCKER_CHAIN_EVM);
    expect(bundle.channelId).toBe(lastClaim.channelId);
    expect(bundle.nonce).toBe(lastClaim.nonce);
    expect(bundle.cumulativeAmount).toBe(lastClaim.cumulativeAmount);
    expect(bundle.recipient).toBe(EVM_CHAIN_RECIPIENT);
    expect(bundle.unsignedTxBytes.length).toBeGreaterThan(0);
    // N fills netted into ONE bundle for the channel — the whole point of
    // rolling settlement (spec §8).
    expect(bundle.claimsMerged).toBe(swap.claims.length);

    const publicClient = createViemClient();
    const gasPrice = await publicClient.getGasPrice();
    const gasFilled = fillEvmSettlementTxGas(
      bundle,
      { nonce: 0n, gasPrice, gasLimit: 500_000n },
      signerConfig
    );
    expect(gasFilled.length).toBeGreaterThan(bundle.unsignedTxBytes.length);
  });

  // -------------------------------------------------------------------
  // Helpers — a fresh session per probe so one probe cannot perturb the
  // watermark the main stream's assertions read.
  // -------------------------------------------------------------------
  function daemonForProbe(live: LiveSender): LegBDaemon {
    const probe = createLegBDaemon();
    live.connector.setLocalDeliveryHandler(probe.handler);
    return probe;
  }

  async function openSession(
    live: LiveSender,
    probe: LegBDaemon
  ): Promise<RollingSession> {
    const opened = await openRollingSession({
      sender: live,
      daemon: probe,
      makerPubkey: PEER1_NOSTR_PUBKEY,
      makerIlpAddress: PEER1_ILP_ADDRESS,
      pair: PAIR,
      chainRecipient: EVM_CHAIN_RECIPIENT,
    });
    if (!opened.ok) {
      throw new Error(
        `RFQ refused: ${opened.code} ${opened.reason ?? ''} ${opened.message ?? ''}`
      );
    }
    return opened.session;
  }
});
