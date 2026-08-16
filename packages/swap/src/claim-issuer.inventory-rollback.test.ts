/**
 * swap#136 defect 2 — a FAILED swap must be a no-op on the inventory.
 *
 * `issueClaim()`'s legacy hold is `inventory.debit()` (available −= n).
 * Its unwind used `inventory.credit()`, which is the operator-REFILL
 * primitive: available += n AND **total += n**. So every failed swap
 * ratcheted `total` upward — and `total` is what the maker advertises in
 * kind:10032 (`swap-node.ts`'s peer-info builder) and reports as `inventory`
 * on `/health`. Observed live: a maker configured with 15 000 000 reporting
 * 15 001 000 after one failed swap.
 *
 * The assertion here is deliberately "byte-identical to before the attempt"
 * across BOTH buckets, on every failure mode the issuer has.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SwapPair } from '@toon-protocol/core';

import { MultiChainClaimIssuer } from './claim-issuer.js';
import { SwapInventory } from './inventory.js';
import { SwapChannelState } from './channel-state.js';

const SENDER = 'b'.repeat(64);
const RECIPIENT = '0x' + '11'.repeat(20);
const CHAIN = 'evm:base:8453';
const POOL = `ETH:${CHAIN}`;

const PAIR: SwapPair = {
  from: { assetCode: 'USDC', chain: CHAIN, assetScale: 6 },
  to: { assetCode: 'ETH', chain: CHAIN, assetScale: 18 },
  rate: '0.0005',
};

function snapshotPool(inv: SwapInventory): {
  available: bigint;
  total: bigint;
  unsettled: bigint;
} {
  const b = inv.get('ETH', CHAIN);
  if (!b) throw new Error('pool missing');
  return { available: b.available, total: b.total, unsettled: b.unsettled };
}

function makeInventory(): SwapInventory {
  return new SwapInventory({
    balances: { [POOL]: { available: 15_000_000n, total: 15_000_000n } },
  });
}

function makeChannelState(): SwapChannelState {
  return new SwapChannelState({
    channels: {
      [`ETH:${CHAIN}:0xchan`]: {
        channelId: '0xchan',
        cumulativeAmount: 0n,
        nonce: 0n,
        updatedAt: 0,
      },
    },
  });
}

const ISSUE_PARAMS = {
  sourceAmount: 100_000n,
  targetAmount: 1_000n,
  pair: PAIR,
  senderPubkey: SENDER,
  chainRecipient: RECIPIENT,
  rumor: {
    pubkey: SENDER,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: '',
  },
};

describe('swap#136 — a failed issuance leaves the inventory byte-identical', () => {
  it('[P0] signer failure: available AND total are unchanged (credit-as-unwind leaked total)', async () => {
    const inventory = makeInventory();
    const before = snapshotPool(inventory);

    const issuer = new MultiChainClaimIssuer({
      inventory,
      channelState: makeChannelState(),
      signers: {
        [CHAIN]: {
          chain: CHAIN,
          chainKind: 'evm' as const,
          signBalanceProof: vi.fn(async () => {
            throw new Error('hsm offline');
          }),
        },
      },
    });

    await expect(issuer.issueClaim(ISSUE_PARAMS)).rejects.toThrow();
    expect(snapshotPool(inventory)).toEqual(before);
  });

  it('[P0] channel-reservation failure (the live "N unredeemed" refusal): inventory untouched', async () => {
    const inventory = makeInventory();
    const before = snapshotPool(inventory);

    // No channel provisioned for the pool at all → reserve() throws after the
    // debit has already been taken. This is the exact ordering that produced
    // the live "total: 15001000 vs configured 15000000" drift.
    const issuer = new MultiChainClaimIssuer({
      inventory,
      channelState: new SwapChannelState({ channels: {} }),
      signers: {
        [CHAIN]: {
          chain: CHAIN,
          chainKind: 'evm' as const,
          signBalanceProof: vi.fn(async () => new Uint8Array([1])),
        },
      },
    });

    await expect(issuer.issueClaim(ISSUE_PARAMS)).rejects.toThrow();
    expect(snapshotPool(inventory)).toEqual(before);
  });

  it('[P0] write-ahead persist failure: inventory untouched', async () => {
    const inventory = makeInventory();
    const before = snapshotPool(inventory);

    const issuer = new MultiChainClaimIssuer({
      inventory,
      channelState: makeChannelState(),
      signers: {
        [CHAIN]: {
          chain: CHAIN,
          chainKind: 'evm' as const,
          signBalanceProof: vi.fn(async () => new Uint8Array([1])),
        },
      },
      persistState: () => {
        throw new Error('disk full');
      },
    });

    await expect(issuer.issueClaim(ISSUE_PARAMS)).rejects.toThrow();
    expect(snapshotPool(inventory)).toEqual(before);
  });

  it('[P1] repeated failures do not ratchet total (the live symptom was cumulative)', async () => {
    const inventory = makeInventory();
    const before = snapshotPool(inventory);

    const issuer = new MultiChainClaimIssuer({
      inventory,
      channelState: makeChannelState(),
      signers: {
        [CHAIN]: {
          chain: CHAIN,
          chainKind: 'evm' as const,
          signBalanceProof: vi.fn(async () => {
            throw new Error('hsm offline');
          }),
        },
      },
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(issuer.issueClaim(ISSUE_PARAMS)).rejects.toThrow();
    }
    expect(snapshotPool(inventory)).toEqual(before);
    expect(snapshotPool(inventory).total).toBe(15_000_000n);
  });

  it('[P1] `credit` remains the operator refill (raises BOTH buckets) — refundDebit only restores available', () => {
    const inventory = makeInventory();

    inventory.debit('ETH', CHAIN, 1_000n);
    expect(snapshotPool(inventory)).toMatchObject({
      available: 14_999_000n,
      total: 15_000_000n,
    });

    inventory.refundDebit('ETH', CHAIN, 1_000n);
    expect(snapshotPool(inventory)).toMatchObject({
      available: 15_000_000n,
      total: 15_000_000n,
    });

    inventory.credit('ETH', CHAIN, 1_000n);
    expect(snapshotPool(inventory)).toMatchObject({
      available: 15_001_000n,
      total: 15_001_000n,
    });
  });
});
