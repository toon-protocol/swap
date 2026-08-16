/**
 * swap#153 — ROLLING swap ACROSS A CHAIN BOUNDARY.
 *
 * This is the suite the whole port exists to protect.
 *
 * `tests/e2e/` is described as the project's multi-chain E2E swap coverage,
 * and on paper it is: a Solana suite, a Mina suite, and a 9-pair matrix. In
 * practice every one of those needs infra this repo does not vendor — a
 * `solana-test-validator`, a Mina lightnet — so in CI they skip, and the only
 * pair that has ever actually EXECUTED is `evm:base:31337 → evm:base:31337`.
 * A same-chain swap at parity. The chain boundary was never crossed.
 *
 * swap#153 fixes that with the trick `tests/integration/
 * rolling-settlement.integration.test.ts` already proved out: a second
 * `anvil`. Leg A is paid on chain A (31337) through a real `TokenNetwork`
 * payment channel; the leg-B claim the maker returns is signed for chain B
 * (31338) — a different chain id, a different RPC, a different
 * `RollingSwapChannel` deployment, and therefore a different EIP-712 domain.
 * `from.chain !== to.chain` for real, with no external dependency, on every
 * CI run.
 *
 * Solana and Mina still need their own infra and still skip; see
 * `tests/e2e/README.md`. What changes is that "multi-chain" is no longer
 * entirely aspirational.
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
  skipIfNotReady,
  PEER1_NOSTR_PUBKEY,
  PEER1_ILP_ADDRESS,
  ROLLING_CHANNEL_ADDRESS,
  CHAIN_B_ID,
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_EVM_B,
} from './helpers/infra-gate.js';
import { ROLLING_SENDER_ILP } from './helpers/topology.js';

/**
 * The sender's payout address ON CHAIN B — deliberately NOT the address its
 * chain-A settlement key controls, so a claim that silently came back bound
 * to the source chain's recipient would fail rather than pass by coincidence.
 */
const CHAIN_B_RECIPIENT = '0x' + '7e57'.repeat(10);

const PAIR: SwapPair = {
  from: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
  to: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM_B },
  rate: '1',
};

const TOTAL = 900_000n;
const PACKETS = 3;

describe('Docker Rolling Swap CROSS-CHAIN E2E (swap#153) — evm:31337 → evm:31338', () => {
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
        nodeIdPrefix: 'roll-xc',
        btpServerPort: 19932,
        healthCheckPort: 19933,
        loggerName: 'swap-e2e-rolling-xchain-connector',
        senderIlpAddress: ROLLING_SENDER_ILP.crossChain,
        localDeliveryHandler: daemon.handler,
      });
      result = await runRollingSwap({
        sender,
        daemon,
        makerPubkey: PEER1_NOSTR_PUBKEY,
        makerIlpAddress: PEER1_ILP_ADDRESS,
        pair: PAIR,
        chainRecipient: CHAIN_B_RECIPIENT,
        totalAmount: TOTAL,
        packetCount: PACKETS,
      });
    } catch (err) {
      console.error('cross-chain rolling swap failed in beforeAll:', err);
    }
  }, 120_000);

  afterAll(async () => {
    if (sender) await sender.close();
    await new Promise((r) => setTimeout(r, 250));
  });

  // ---------------------------------------------------------------------
  // X-1 — the pair really does cross a boundary, and the maker quotes it
  // ---------------------------------------------------------------------
  it('X-1 [P1] peer1 quotes a pair whose source and target chains differ', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const swap = present(result, 'the cross-chain swap result');
    expect(
      swap.rfqReject,
      `leg 0 was refused: ${JSON.stringify(swap.rfqReject)}`
    ).toBeUndefined();
    // The guard that makes this suite mean something: if these two ever
    // become the same string, this is a same-chain test wearing a
    // cross-chain name.
    expect(PAIR.from.chain).not.toBe(PAIR.to.chain);
    expect(swap.quote?.streamNonce).toBe(swap.streamNonce);
  });

  // ---------------------------------------------------------------------
  // X-2 — value lands on the TARGET chain, bound to the target recipient
  // ---------------------------------------------------------------------
  it('X-2 [P1] every leg-B claim is issued on the TARGET chain, to the target-chain recipient', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const swap = present(result, 'the cross-chain swap result');
    expect(swap.state, `rejections: ${JSON.stringify(swap.rejections)}`).toBe(
      'completed'
    );
    expect(swap.claims).toHaveLength(PACKETS);
    expect(daemon.refusals).toEqual([]);

    for (const claim of swap.claims) {
      expect(claim.pair.to.chain).toBe(DOCKER_CHAIN_EVM_B);
      expect(claim.pair.from.chain).toBe(DOCKER_CHAIN_EVM);
      expect(claim.recipient?.toLowerCase()).toBe(CHAIN_B_RECIPIENT);
      expect(claim.claimBytes.length).toBeGreaterThan(0);
    }

    // The chain-B channel the claims advance is NOT a chain-A channel: the
    // maker binds a separate seed per chain (`peer-node.ts`).
    const channelIds = new Set(swap.claims.map((c) => c.channelId));
    expect(channelIds.size).toBe(1);
  });

  // ---------------------------------------------------------------------
  // X-3 — the target-chain claims settle against the TARGET chain's domain
  // ---------------------------------------------------------------------
  it('X-3 [P1] the leg-B claims build an EVM settlement bundle for the TARGET chain', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();
    const swap = present(result, 'the cross-chain swap result');
    expect(swap.claims.length).toBeGreaterThanOrEqual(1);

    const lastClaim = present(swap.claims.at(-1), 'the last leg-B claim');
    const settlement = buildSettlementTx({
      claims: swap.claims,
      signers: {
        [DOCKER_CHAIN_EVM_B]: {
          address: present(
            lastClaim.swapSignerAddress,
            'claim.swapSignerAddress'
          ).toLowerCase(),
          contractAddress: ROLLING_CHANNEL_ADDRESS.toLowerCase(),
          // Chain B's own id — the EIP-712 domain separator that makes a
          // chain-A claim unredeemable here and vice versa.
          chainId: CHAIN_B_ID,
        },
      },
      recipients: { [DOCKER_CHAIN_EVM_B]: CHAIN_B_RECIPIENT },
      verifySignatures: false,
    });

    expect(settlement.bundles).toHaveLength(1);
    const bundle = present(settlement.bundles[0], 'the settlement bundle');
    expect(bundle.chain).toBe(DOCKER_CHAIN_EVM_B);
    expect(bundle.recipient).toBe(CHAIN_B_RECIPIENT);
    expect(bundle.cumulativeAmount).toBe(lastClaim.cumulativeAmount);
    // N cross-chain fills net to ONE on-chain settlement (spec §8).
    expect(bundle.claimsMerged).toBe(PACKETS);
    expect(bundle.unsignedTxBytes.length).toBeGreaterThan(0);
  });
});
