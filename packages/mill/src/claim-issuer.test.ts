/**
 * `MultiChainClaimIssuer` tests — Story 12.4 AC-6, AC-8, AC-10, AC-11
 * (claim-issuer block).
 *
 * T-026 (concurrent issuance) + T-int-1 (structural compatibility with
 * createSwapHandler, AC-10) — test-design-epic-12 Story 12-4.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SwapPair } from '@toon-protocol/core';
// Type-only — keeps this package from taking a runtime cycle on @toon-protocol/sdk.
import type { ClaimIssuer } from '@toon-protocol/sdk';

import { MultiChainClaimIssuer } from './claim-issuer.js';
import { MillInventory } from './inventory.js';
import { MillChannelState } from './channel-state.js';
import { MillInventoryError, MillWalletError } from './errors.js';

// ---------------------------------------------------------------------------
// Fixtures (shared across cases in this file)
// ---------------------------------------------------------------------------

const SENDER_PUBKEY = 'b'.repeat(64);

const PAIR_USDC_TO_ETH: SwapPair = {
  from: { assetCode: 'USDC', chain: 'evm:base:8453', assetScale: 6 },
  to: { assetCode: 'ETH', chain: 'evm:base:8453', assetScale: 18 },
  rate: '0.0005',
};

function makeMockSigner(chainKind: 'evm' | 'mina' | 'solana' = 'evm') {
  return {
    chain: 'evm:base:8453',
    chainKind,
    signBalanceProof: vi.fn(async () => new Uint8Array([0x01, 0x02, 0x03])),
  };
}

function makeRumor() {
  // Minimal UnsignedEvent shape; fields only used as opaque context by the issuer.
  return {
    pubkey: SENDER_PUBKEY,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: '',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultiChainClaimIssuer (Story 12.4 AC-6, AC-8, AC-10)', () => {
  it('[P0] happy path: debit → sign → return { claim, claimId }', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signer = makeMockSigner('evm');
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { 'evm:base:8453': signer },
      channelState,
    });

    const result = await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      rumor: makeRumor(),
    });

    expect(result.claim).toBeInstanceOf(Uint8Array);
    expect(result.claim).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    expect(typeof result.claimId).toBe('string');
    expect(inventory.get('ETH', 'evm:base:8453')!.available).toBe(950n);
    expect(signer.signBalanceProof).toHaveBeenCalledTimes(1);
  });

  it('[P0] debit happens BEFORE the first await (microtask atomicity, AC-8)', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });

    const debitSpy = vi.spyOn(inventory, 'debit');
    const signer = {
      chain: 'evm:base:8453',
      chainKind: 'evm' as const,
      signBalanceProof: vi.fn(async () => new Uint8Array([0xaa])),
    };

    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { 'evm:base:8453': signer },
      channelState,
    });

    await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      rumor: makeRumor(),
    });

    const debitOrder = debitSpy.mock.invocationCallOrder[0];
    const signOrder = signer.signBalanceProof.mock.invocationCallOrder[0];
    expect(debitOrder).toBeDefined();
    expect(signOrder).toBeDefined();
    expect(debitOrder!).toBeLessThan(signOrder!);
  });

  it('[P0] insufficient inventory throws MillInventoryError(INSUFFICIENT_INVENTORY); signer NOT called', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 10n, total: 10n } },
    });
    const channelState = new MillChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signer = makeMockSigner('evm');
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { 'evm:base:8453': signer },
      channelState,
    });

    await expect(
      issuer.issueClaim({
        sourceAmount: 1n,
        targetAmount: 100n,
        pair: PAIR_USDC_TO_ETH,
        senderPubkey: SENDER_PUBKEY,
        rumor: makeRumor(),
      })
    ).rejects.toMatchObject({
      name: 'MillInventoryError',
      code: 'INSUFFICIENT_INVENTORY',
    });
    expect(signer.signBalanceProof).not.toHaveBeenCalled();
    // Silence unused-import.
    expect(MillInventoryError.name).toBe('MillInventoryError');
  });

  it('[P0] unsupported target chain throws MillWalletError(UNSUPPORTED_CHAIN); inventory NOT debited', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({ channels: {} });
    // No signer registered for 'evm:base:8453'
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: {},
      channelState,
    });

    await expect(
      issuer.issueClaim({
        sourceAmount: 1n,
        targetAmount: 50n,
        pair: PAIR_USDC_TO_ETH,
        senderPubkey: SENDER_PUBKEY,
        rumor: makeRumor(),
      })
    ).rejects.toMatchObject({
      name: 'MillWalletError',
      code: 'UNSUPPORTED_CHAIN',
    });
    expect(inventory.get('ETH', 'evm:base:8453')!.available).toBe(1_000n);
    expect(MillWalletError.name).toBe('MillWalletError');
  });

  it('[P1] signer throws → issuer reverses debit via inventory.credit; final throw code = SIGNING_FAILED', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signer = {
      chain: 'evm:base:8453',
      chainKind: 'evm' as const,
      signBalanceProof: vi.fn(async () => {
        throw new Error('hardware signer exploded');
      }),
    };
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { 'evm:base:8453': signer },
      channelState,
    });

    await expect(
      issuer.issueClaim({
        sourceAmount: 1n,
        targetAmount: 50n,
        pair: PAIR_USDC_TO_ETH,
        senderPubkey: SENDER_PUBKEY,
        rumor: makeRumor(),
      })
    ).rejects.toMatchObject({
      name: 'MillWalletError',
      code: 'SIGNING_FAILED',
    });

    expect(inventory.get('ETH', 'evm:base:8453')!.available).toBe(1_000n);
  });

  it('[P0] (T-026) 10 concurrent issueClaim calls produce 10 distinct claimIds and monotonic nonces; cumulativeAmount = sum(targetAmount)', async () => {
    const inventory = new MillInventory({
      balances: {
        'ETH:evm:base:8453': { available: 10_000n, total: 10_000n },
      },
    });
    const channelState = new MillChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signer = {
      chain: 'evm:base:8453',
      chainKind: 'evm' as const,
      signBalanceProof: vi.fn(async () => new Uint8Array([0xab])),
    };
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { 'evm:base:8453': signer },
      channelState,
    });

    const per = 50n;
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        issuer.issueClaim({
          sourceAmount: 100_000n,
          targetAmount: per,
          pair: PAIR_USDC_TO_ETH,
          senderPubkey: SENDER_PUBKEY,
          rumor: makeRumor(),
        })
      )
    );

    const ids = new Set(results.map((r) => r.claimId));
    expect(ids.size).toBe(N);
    expect(inventory.get('ETH', 'evm:base:8453')!.available).toBe(
      10_000n - per * BigInt(N)
    );
    const entry = channelState.get({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
    });
    expect(entry!.cumulativeAmount).toBe(per * BigInt(N));
    expect(entry!.nonce).toBe(BigInt(N));
  });

  it('[P0] (AC-10) MultiChainClaimIssuer is structurally assignable to ClaimIssuer from @toon-protocol/sdk', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1n, total: 1n } },
    });
    const channelState = new MillChannelState({ channels: {} });
    const issuer: ClaimIssuer = new MultiChainClaimIssuer({
      inventory,
      signers: {},
      channelState,
    });
    expect(typeof issuer.issueClaim).toBe('function');
  });

  it('[P1] custom newClaimId generator is honored (AC-6 contract)', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signer = makeMockSigner('evm');
    let counter = 0;
    const newClaimId = vi.fn(() => `test-claim-${++counter}`);
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { 'evm:base:8453': signer },
      channelState,
      newClaimId,
    });

    const r1 = await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      rumor: makeRumor(),
    });
    const r2 = await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      rumor: makeRumor(),
    });

    expect(r1.claimId).toBe('test-claim-1');
    expect(r2.claimId).toBe('test-claim-2');
    expect(newClaimId).toHaveBeenCalledTimes(2);
  });

  it('[P1] signer failure also rolls back the channel-state reservation (nonce + cumulativeAmount restored)', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signer = {
      chain: 'evm:base:8453',
      chainKind: 'evm' as const,
      signBalanceProof: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { 'evm:base:8453': signer },
      channelState,
    });

    await expect(
      issuer.issueClaim({
        sourceAmount: 1n,
        targetAmount: 50n,
        pair: PAIR_USDC_TO_ETH,
        senderPubkey: SENDER_PUBKEY,
        rumor: makeRumor(),
      })
    ).rejects.toMatchObject({
      name: 'MillWalletError',
      code: 'SIGNING_FAILED',
    });

    const entry = channelState.get({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
    });
    // Rollback should have restored the channel state to pre-reserve values.
    expect(entry!.nonce).toBe(0n);
    expect(entry!.cumulativeAmount).toBe(0n);
  });

  it('[P1] returned result includes a non-empty string claimId (default UUID path)', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signer = makeMockSigner('evm');
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { 'evm:base:8453': signer },
      channelState,
    });

    const result = await issuer.issueClaim({
      sourceAmount: 1n,
      targetAmount: 10n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      rumor: makeRumor(),
    });
    expect(typeof result.claimId).toBe('string');
    expect((result.claimId ?? '').length).toBeGreaterThan(0);
  });

  it('[P0] (T-int-1) structural compatibility: createSwapHandler accepts MultiChainClaimIssuer without throwing', async () => {
    // This test validates the AC-10 structural contract without bringing up
    // a full gift-wrapped packet — the Handler returned by createSwapHandler
    // is a closure over `config`, and the factory performs construction-time
    // shape validation on `config.claimIssuer`. End-to-end packet flow is
    // validated by Story 12.8 E2E tests (Docker SDK E2E infra).
    const { createSwapHandler } = await import('@toon-protocol/sdk');

    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signer = makeMockSigner('evm');
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { 'evm:base:8453': signer },
      channelState,
    });

    // 32-byte Uint8Array for the recipientSecretKey (not used here since we
    // do not invoke the handler with a real packet).
    const recipientSecretKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) recipientSecretKey[i] = i + 1;

    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [PAIR_USDC_TO_ETH],
      claimIssuer: issuer,
    });

    expect(typeof handler).toBe('function');
    // Direct issueClaim smoke so the structural path is also exercised.
    const result = await issuer.issueClaim({
      sourceAmount: 1_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      rumor: makeRumor(),
    });
    expect(result.claim).toBeInstanceOf(Uint8Array);
    expect(inventory.get('ETH', 'evm:base:8453')!.available).toBe(950n);
    expect(
      channelState.get({
        assetCode: 'ETH',
        chain: 'evm:base:8453',
        senderPubkey: SENDER_PUBKEY,
      })!.nonce
    ).toBe(1n);
  });
});
