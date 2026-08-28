/**
 * Issue #141 — Mina is DELIBERATELY left unrecycled, and says so.
 *
 * The Mina `PaymentChannel` zkApp publishes no cumulative-paid: the balances
 * live only inside `balanceCommitment = Poseidon(balanceA, balanceB, salt)`
 * with a per-packet random salt, and the connector itself tracks Mina
 * cumulative transferred off-chain for exactly that reason. Every readable
 * substitute (`nonceField` is a counter, `depositTotal` is the capacity
 * ceiling, `channelState` says "drained" without saying how much) can
 * OVERSTATE the watermark, which would both over-recycle inventory and
 * approve a #113 rebind that strips an unredeemed claim. So the node ships no
 * Mina reader at all — see `channel-reader.ts`.
 *
 * This test pins the resulting behavior so a later change cannot quietly
 * introduce an approximation: a Mina-only maker recycles NOTHING, reports the
 * reconciler as disabled, and explains the block on the operator surface.
 */

import { describe, it, expect } from 'vitest';
import { base58Encode } from '@toon-protocol/sdk';

import { startSwapNode } from './swap-node.js';
import type {
  SwapNodeMinaChainProvider,
  SwapNodeInstance,
} from './swap-node.js';
import type { MultiChainClaimIssuer } from './claim-issuer.js';
import type { AdminInventoryReport } from './admin-surface.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MINA_CHAIN = 'mina:devnet';
const ASSET = 'USDC';
const CHANNEL_ID = 'B62qmMinaChannelZkAppAddressFixture';
const RECIPIENT = base58Encode(new Uint8Array(32).fill(3));
const SENDER = 'a'.repeat(64);
const START_INVENTORY = 1_000_000n;
const SWAP_AMOUNT = 4_000n;

/** Non-null narrowing without `!` (the repo's eslint gate forbids it). */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}

async function bootMinaMaker(): Promise<{
  instance: SwapNodeInstance;
  issuer: MultiChainClaimIssuer;
}> {
  let issuer: MultiChainClaimIssuer | undefined;
  const minaProvider: SwapNodeMinaChainProvider = {
    chainType: 'mina',
    chainId: MINA_CHAIN,
    graphqlUrl: 'http://127.0.0.1:1/graphql',
    zkAppAddress: CHANNEL_ID,
  };
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    blsPort: 0,
    chains: ['evm', 'mina'],
    adminToken: 'operator-secret',
    reconcileIntervalMs: 0,
    swapPairs: [
      {
        from: { assetCode: ASSET, assetScale: 6, chain: 'evm:8453' },
        to: { assetCode: ASSET, assetScale: 6, chain: MINA_CHAIN },
        rate: '1.0',
      },
    ],
    channels: {
      [MINA_CHAIN]: [
        {
          channelId: CHANNEL_ID,
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [MINA_CHAIN]: START_INVENTORY },
    chainProviders: [
      minaProvider,
      // Leg A is paid on evm:8453, so the maker needs its EVM facts there.
      {
        chainType: 'evm',
        chainId: 'evm:8453',
        rpcUrl: 'http://127.0.0.1:1',
        registryAddress: '0x' + '11'.repeat(20),
        tokenAddress: '0x' + '22'.repeat(20),
        tokenNetworkAddress: '0x' + '33'.repeat(20),
      },
    ],
    __testHooks: {
      onClaimIssuerBuilt: (ci) => {
        issuer = ci;
      },
    },
  });
  if (!issuer) throw new Error('onClaimIssuerBuilt was never called');
  return { instance, issuer };
}

async function readAdminReport(
  instance: SwapNodeInstance
): Promise<AdminInventoryReport> {
  const res = await fetch(
    `http://127.0.0.1:${instance.blsPort}/admin/inventory`
  );
  expect(res.status).toBe(200);
  return (await res.json()) as AdminInventoryReport;
}

describe('issue #141 — a Mina maker stays unrecycled, visibly and on purpose', () => {
  it('[P0] the reconciler runs (the maker reads EVM for leg A) but the Mina pool is never recycled', async () => {
    const { instance } = await bootMinaMaker();
    try {
      const report = await readAdminReport(instance);
      // Leg A is paid on EVM, so an EVM reader exists and the reconciler is
      // armed — but it can read nothing about the Mina channel.
      expect(report.reconciler.enabled).toBe(true);
      const result = await instance.reconcileInventory();
      expect(result.channels.every((c) => c.redeemed === null)).toBe(true);
      expect(result.errors.join('\n')).toMatch(/mina/i);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] a reconcile pass credits nothing and states why', async () => {
    const { instance, issuer } = await bootMinaMaker();
    try {
      const pair = {
        from: { assetCode: ASSET, assetScale: 6, chain: 'evm:8453' },
        to: { assetCode: ASSET, assetScale: 6, chain: MINA_CHAIN },
        rate: '1.0',
      };
      const claim = await issuer.issueRollingClaim({
        sourceAmount: SWAP_AMOUNT,
        targetAmount: SWAP_AMOUNT,
        pair,
        senderPubkey: SENDER,
        chainRecipient: RECIPIENT,
        rumor: {},
      } as Parameters<MultiChainClaimIssuer['issueRollingClaim']>[0]);
      issuer.commitRollingClaim({
        reservationId: claim.reservationId,
        pair,
        targetAmount: SWAP_AMOUNT,
      });

      const result = await instance.reconcileInventory();
      // The Mina channel is observed but unreadable: nothing is credited.
      expect(result.channels).toHaveLength(1);
      expect(must(result.channels[0], 'the mina channel').redeemed).toBeNull();
      expect(must(result.errors[0], 'an explanation')).toMatch(/mina/i);

      // The liability stays booked — under-recycling is the safe failure.
      const pool = must((await readAdminReport(instance)).pools[0], 'pool');
      expect(pool.unsettled).toBe(SWAP_AMOUNT.toString());
      expect(pool.available).toBe(START_INVENTORY.toString());
      expect(pool.free).toBe((START_INVENTORY - SWAP_AMOUNT).toString());
    } finally {
      await instance.stop();
    }
  });
});
