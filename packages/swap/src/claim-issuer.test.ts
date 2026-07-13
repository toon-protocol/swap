/**
 * `MultiChainClaimIssuer` tests — Story 12.4 AC-6, AC-8, AC-10, AC-11
 * (claim-issuer block).
 *
 * T-026 (concurrent issuance) + T-int-1 (structural compatibility with
 * createSwapHandler, AC-10) — test-design-epic-12 Story 12-4.
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import type { SwapPair } from '@toon-protocol/core';
// Type-only — keeps this package from taking a runtime cycle on @toon-protocol/sdk.
import type { ClaimIssuer } from '@toon-protocol/sdk';

import { MultiChainClaimIssuer } from './claim-issuer.js';
import { SwapInventory } from './inventory.js';
import { SwapChannelState } from './channel-state.js';
import { SwapInventoryError, SwapWalletError } from './errors.js';

// ---------------------------------------------------------------------------
// Fixtures (shared across cases in this file)
// ---------------------------------------------------------------------------

const SENDER_PUBKEY = 'b'.repeat(64);

/**
 * Shared 20-byte lowercased EVM fixture recipient for Story 12.9 tests
 * and existing-test accommodation sweep (Task 7.1). Keeps the recipient
 * chain-format-valid so signer validation does not false-positive.
 */
const FIXTURE_EVM_RECIPIENT = '0x' + '11'.repeat(20);

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
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
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
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });

    expect(result.claim).toBeInstanceOf(Uint8Array);
    expect(result.claim).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    expect(typeof result.claimId).toBe('string');
    expect(inventory.get('ETH', 'evm:base:8453')!.available).toBe(950n);
    expect(signer.signBalanceProof).toHaveBeenCalledTimes(1);
  });

  it('[P0] debit happens BEFORE the first await (microtask atomicity, AC-8)', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
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
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });

    const debitOrder = debitSpy.mock.invocationCallOrder[0];
    const signOrder = signer.signBalanceProof.mock.invocationCallOrder[0];
    expect(debitOrder).toBeDefined();
    expect(signOrder).toBeDefined();
    expect(debitOrder!).toBeLessThan(signOrder!);
  });

  it('[P0] insufficient inventory throws SwapInventoryError(INSUFFICIENT_INVENTORY); signer NOT called', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 10n, total: 10n } },
    });
    const channelState = new SwapChannelState({
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
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        rumor: makeRumor(),
      })
    ).rejects.toMatchObject({
      name: 'SwapInventoryError',
      code: 'INSUFFICIENT_INVENTORY',
    });
    expect(signer.signBalanceProof).not.toHaveBeenCalled();
    // Silence unused-import.
    expect(SwapInventoryError.name).toBe('SwapInventoryError');
  });

  it('[P0] unsupported target chain throws SwapWalletError(UNSUPPORTED_CHAIN); inventory NOT debited', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({ channels: {} });
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
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        rumor: makeRumor(),
      })
    ).rejects.toMatchObject({
      name: 'SwapWalletError',
      code: 'UNSUPPORTED_CHAIN',
    });
    expect(inventory.get('ETH', 'evm:base:8453')!.available).toBe(1_000n);
    expect(SwapWalletError.name).toBe('SwapWalletError');
  });

  it('[P1] signer throws → issuer reverses debit via inventory.credit; final throw code = SIGNING_FAILED', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
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
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        rumor: makeRumor(),
      })
    ).rejects.toMatchObject({
      name: 'SwapWalletError',
      code: 'SIGNING_FAILED',
    });

    expect(inventory.get('ETH', 'evm:base:8453')!.available).toBe(1_000n);
  });

  it('[P0] (T-026) 10 concurrent issueClaim calls produce 10 distinct claimIds and monotonic nonces; cumulativeAmount = sum(targetAmount)', async () => {
    const inventory = new SwapInventory({
      balances: {
        'ETH:evm:base:8453': { available: 10_000n, total: 10_000n },
      },
    });
    const channelState = new SwapChannelState({
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
          chainRecipient: FIXTURE_EVM_RECIPIENT,
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
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1n, total: 1n } },
    });
    const channelState = new SwapChannelState({ channels: {} });
    const issuer: ClaimIssuer = new MultiChainClaimIssuer({
      inventory,
      signers: {},
      channelState,
    });
    expect(typeof issuer.issueClaim).toBe('function');
  });

  it('[P1] custom newClaimId generator is honored (AC-6 contract)', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
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
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });
    const r2 = await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });

    expect(r1.claimId).toBe('test-claim-1');
    expect(r2.claimId).toBe('test-claim-2');
    expect(newClaimId).toHaveBeenCalledTimes(2);
  });

  it('[P1] signer failure also rolls back the channel-state reservation (nonce + cumulativeAmount restored)', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
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
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        rumor: makeRumor(),
      })
    ).rejects.toMatchObject({
      name: 'SwapWalletError',
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
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
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
      chainRecipient: FIXTURE_EVM_RECIPIENT,
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

    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
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
      chainRecipient: FIXTURE_EVM_RECIPIENT,
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

// ---------------------------------------------------------------------------
// Story 12.6 AC-3 — settlement-context field round-trip from reservation
// to IssueClaimResult.
//
// When the issuer is constructed with a `signerAddresses` map, every
// `issueClaim()` result MUST expose channelId/nonce/cumulativeAmount/
// recipient/swapSignerAddress so the swap node's swap handler can emit them in
// FULFILL metadata (the load-bearing contract for `buildSettlementTx()`).
//
// When `signerAddresses` is omitted (legacy caller), the result MUST stay in
// the pre-12.6 shape ({ claim, claimId } only) — this is the "one story-cycle
// of compatibility" AC-3 calls out.
// ---------------------------------------------------------------------------

describe('Story 12.6 AC-3 — IssueClaimResult settlement-context fields', () => {
  const EVM_SWAP_SIGNER = '0x' + 'c'.repeat(40);
  const CHAIN = 'evm:base:8453';

  it('[P0] surfaces channelId/nonce/cumulativeAmount/recipient/swapSignerAddress when signerAddresses configured', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xdeadbeef',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signer = makeMockSigner('evm');
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { [CHAIN]: signer },
      channelState,
      signerAddresses: { [CHAIN]: EVM_SWAP_SIGNER },
    });

    const result = await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });

    // channelId copied verbatim from the reservation.
    expect(result.channelId).toBe('0xdeadbeef');
    // First claim increments nonce to 1 and sets cumulativeAmount to delta.
    expect(result.nonce).toBe(1n);
    expect(typeof result.nonce).toBe('bigint');
    expect(result.cumulativeAmount).toBe(50n);
    expect(typeof result.cumulativeAmount).toBe('bigint');
    // Story 12.9 AC-12: recipient = the sender's CHAIN-LAYER payout address
    // (e.g., 20-byte EVM), NOT the Nostr identity key. Pre-12.9 this assertion
    // incorrectly expected SENDER_PUBKEY, which was the defect that blocked
    // Story 12.8 session 3.
    expect(result.recipient).toBe(FIXTURE_EVM_RECIPIENT);
    // swap node signer address threaded through from config.
    expect(result.swapSignerAddress).toBe(EVM_SWAP_SIGNER);
  });

  it('[P0] monotonically increments nonce + cumulativeAmount across two sequential claims', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan2',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { [CHAIN]: makeMockSigner('evm') },
      channelState,
      signerAddresses: { [CHAIN]: EVM_SWAP_SIGNER },
    });

    const r1 = await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 30n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });
    const r2 = await issuer.issueClaim({
      sourceAmount: 50_000n,
      targetAmount: 20n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });

    expect(r1.nonce).toBe(1n);
    expect(r1.cumulativeAmount).toBe(30n);
    expect(r2.nonce).toBe(2n);
    // Balance proofs are CUMULATIVE — total running balance, not per-packet.
    expect(r2.cumulativeAmount).toBe(50n);
    // channelId + recipient + swapSignerAddress stable across claims.
    expect(r2.channelId).toBe(r1.channelId);
    expect(r2.recipient).toBe(r1.recipient);
    expect(r2.swapSignerAddress).toBe(r1.swapSignerAddress);
  });

  it('[P0] omits all settlement fields when signerAddresses NOT configured (legacy shape)', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan3',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { [CHAIN]: makeMockSigner('evm') },
      channelState,
      // no signerAddresses -> legacy path
    });

    const result = await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });

    // Legacy shape: no settlement fields present.
    expect(result.channelId).toBeUndefined();
    expect(result.nonce).toBeUndefined();
    expect(result.cumulativeAmount).toBeUndefined();
    expect(result.recipient).toBeUndefined();
    expect(result.swapSignerAddress).toBeUndefined();
    // But the base fields still work.
    expect(result.claim).toBeInstanceOf(Uint8Array);
    expect(typeof result.claimId).toBe('string');
  });

  it('[P1] omits settlement fields for a chain that has no entry in signerAddresses', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan4',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { [CHAIN]: makeMockSigner('evm') },
      channelState,
      // Map configured, but for a DIFFERENT chain.
      signerAddresses: { 'solana:mainnet': 'So1111111' },
    });

    const result = await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });

    // Chain-specific miss -> legacy shape for this claim.
    expect(result.swapSignerAddress).toBeUndefined();
    expect(result.channelId).toBeUndefined();
    expect(result.nonce).toBeUndefined();
    expect(result.cumulativeAmount).toBeUndefined();
    expect(result.recipient).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Story 12.9 AC-11, AC-12, AC-16 — chain-recipient threading through to the
// balance-proof signer. Reproduces the Story 12.8 session-3 defect in RED
// form: the signer MUST receive the 20-byte `chainRecipient`, NOT the 32-byte
// Nostr `senderPubkey`. Identity-layer keys (inventory / channel-state) stay
// keyed on `senderPubkey` (guardrail 8.3).
// ---------------------------------------------------------------------------

describe('Story 12.9 — chain-recipient threading to signBalanceProof', () => {
  const EVM_SWAP_SIGNER_FOR_SETTLEMENT = '0x' + 'c'.repeat(40);
  const CHAIN = 'evm:base:8453';

  function buildIssuer(opts?: {
    signBalanceProof?: (arg: unknown) => Promise<Uint8Array>;
    withSettlementAddresses?: boolean;
    settlementContracts?: Record<string, string>;
  }): {
    issuer: MultiChainClaimIssuer;
    signer: {
      signBalanceProof: Mock<[arg: unknown], Promise<Uint8Array>>;
    };
    inventory: SwapInventory;
    channelState: SwapChannelState;
  } {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
      channels: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: {
          channelId: '0xchan12_9',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signBalanceProof = vi.fn(
      opts?.signBalanceProof ?? (async () => new Uint8Array([0xde, 0xad]))
    );
    const signer = {
      chain: CHAIN,
      chainKind: 'evm' as const,
      signBalanceProof,
    };
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: { [CHAIN]: signer },
      channelState,
      ...(opts?.withSettlementAddresses === true
        ? {
            signerAddresses: { [CHAIN]: EVM_SWAP_SIGNER_FOR_SETTLEMENT },
          }
        : {}),
      ...(opts?.settlementContracts
        ? { settlementContracts: opts.settlementContracts }
        : {}),
    });
    return { issuer, signer, inventory, channelState };
  }

  it('[P0] v2 EIP-712: signer receives chainId (parsed from pair.to.chain) and verifyingContract (from settlementContracts) — connector#324 finding #1', async () => {
    const VERIFYING_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    const { issuer, signer } = buildIssuer({
      settlementContracts: { [CHAIN]: VERIFYING_CONTRACT },
    });
    await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });
    expect(signer.signBalanceProof).toHaveBeenCalledTimes(1);
    const arg = signer.signBalanceProof.mock.calls[0]![0] as {
      chainId?: bigint;
      verifyingContract?: string;
    };
    // 'evm:base:8453' → chainId 8453n.
    expect(arg.chainId).toBe(8453n);
    expect(arg.verifyingContract).toBe(VERIFYING_CONTRACT);
  });

  it('[P1] v2 EIP-712: verifyingContract is undefined when no settlementContracts entry is configured (EVM signer then fails closed)', async () => {
    const { issuer, signer } = buildIssuer();
    await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });
    const arg = signer.signBalanceProof.mock.calls[0]![0] as {
      chainId?: bigint;
      verifyingContract?: string;
    };
    expect(arg.chainId).toBe(8453n);
    expect(arg.verifyingContract).toBeUndefined();
  });

  it('[P0] T-10: signer receives 20-byte chainRecipient, NOT 32-byte senderPubkey (AC-11, AC-16a)', async () => {
    const { issuer, signer } = buildIssuer();
    await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });
    expect(signer.signBalanceProof).toHaveBeenCalledTimes(1);
    const arg = signer.signBalanceProof.mock.calls[0]![0] as {
      recipient: string;
    };
    expect(arg.recipient).toBe(FIXTURE_EVM_RECIPIENT);
    // Critical: MUST NOT be the 32-byte Nostr identity key. That was the defect.
    expect(arg.recipient).not.toBe(SENDER_PUBKEY);
    // And format-check: 20-byte lowercased 0x-prefixed hex.
    expect(arg.recipient).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('[P1] T-11: IssueClaimResult.recipient echoes chainRecipient when settlement context is emitted (AC-12, AC-16b)', async () => {
    const { issuer } = buildIssuer({ withSettlementAddresses: true });
    const result = await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });
    expect(result.recipient).toBe(FIXTURE_EVM_RECIPIENT);
    expect(result.recipient).not.toBe(SENDER_PUBKEY);
  });

  it('[P1] T-12: signer throw still releases reserve + re-credits inventory (AC-16c, guardrail 8.3)', async () => {
    const { issuer, channelState, inventory } = buildIssuer({
      signBalanceProof: async () => {
        throw new Error('signer boom');
      },
    });
    await expect(
      issuer.issueClaim({
        sourceAmount: 1n,
        targetAmount: 50n,
        pair: PAIR_USDC_TO_ETH,
        senderPubkey: SENDER_PUBKEY,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        rumor: makeRumor(),
      })
    ).rejects.toMatchObject({
      name: 'SwapWalletError',
      code: 'SIGNING_FAILED',
    });
    // Inventory re-credited.
    expect(inventory.get('ETH', CHAIN)!.available).toBe(1_000n);
    // Channel state rolled back (nonce + cumulativeAmount restored to pre-reserve).
    // This is the sender→channel sticky binding keyed on `senderPubkey`
    // (identity-layer), NOT on `chainRecipient`.
    const entry = channelState.get({
      assetCode: 'ETH',
      chain: CHAIN,
      senderPubkey: SENDER_PUBKEY,
    });
    expect(entry!.nonce).toBe(0n);
    expect(entry!.cumulativeAmount).toBe(0n);
  });

  it('[P2] T-13: inventory + channel-state still keyed by senderPubkey, NOT chainRecipient (guardrail 8.3)', async () => {
    // Reserve spy: the first argument of channelState.reserve MUST carry
    // the Nostr senderPubkey. If Story 12.9 regressed and rekeyed on
    // chainRecipient, this would fail.
    const { issuer, channelState } = buildIssuer();
    const reserveSpy = vi.spyOn(channelState, 'reserve');
    await issuer.issueClaim({
      sourceAmount: 100_000n,
      targetAmount: 50n,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    });
    expect(reserveSpy).toHaveBeenCalledTimes(1);
    const reserveArg = reserveSpy.mock.calls[0]![0] as {
      senderPubkey: string;
    };
    expect(reserveArg.senderPubkey).toBe(SENDER_PUBKEY);
    expect(reserveArg.senderPubkey).not.toBe(FIXTURE_EVM_RECIPIENT);
  });

  it('[P1] T-14: malformed chainRecipient is rejected at claim-issuer boundary BEFORE any state mutation (AC-2 third tier)', async () => {
    // Story 12.9 code-review pass #3: AC-2 codifies a THREE-tier validation
    // regime (sender / handler / claim-issuer). This test guards the third
    // tier: a malformed `chainRecipient` reaching the claim-issuer (e.g., a
    // direct caller that bypassed the swap-handler) MUST be rejected with
    // SwapWalletError('SIGNING_FAILED') BEFORE any inventory debit or
    // channel reservation occurs (no rollback needed because no state
    // change yet).
    const { issuer, signer, inventory, channelState } = buildIssuer();
    const reserveSpy = vi.spyOn(channelState, 'reserve');
    const debitSpy = vi.spyOn(inventory, 'debit');
    await expect(
      issuer.issueClaim({
        sourceAmount: 100_000n,
        targetAmount: 50n,
        pair: PAIR_USDC_TO_ETH,
        senderPubkey: SENDER_PUBKEY,
        // Not 20 bytes; this is the Nostr pubkey shape (32 bytes / 64 hex
        // chars). This is precisely the Story 12.8 defect value; the
        // claim-issuer boundary MUST now reject it.
        chainRecipient: SENDER_PUBKEY,
        rumor: makeRumor(),
      })
    ).rejects.toThrow(/missing or malformed/);
    // Pre-debit rejection: signer, inventory debit, and channelState.reserve
    // MUST NOT have been called.
    expect(signer.signBalanceProof).not.toHaveBeenCalled();
    expect(debitSpy).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
    // And the error class is the SwapWalletError('SIGNING_FAILED') family so
    // the Story 12.3 swap-handler can map it to ILP T00.
    await expect(
      issuer.issueClaim({
        sourceAmount: 100_000n,
        targetAmount: 50n,
        pair: PAIR_USDC_TO_ETH,
        senderPubkey: SENDER_PUBKEY,
        chainRecipient: SENDER_PUBKEY,
        rumor: makeRumor(),
      })
    ).rejects.toBeInstanceOf(SwapWalletError);
  });
});

// ---------------------------------------------------------------------------
// Issue #49 — rolling path: in-flight window reservation lifecycle
// ---------------------------------------------------------------------------

describe('MultiChainClaimIssuer — issueRollingClaim / commit / rollback (issue #49)', () => {
  const CHAIN49 = 'evm:base:8453';
  const KEY49 = `ETH:${CHAIN49}`;

  function buildRollingIssuer(opts?: {
    signBalanceProof?: (arg: unknown) => Promise<Uint8Array>;
    persistState?: () => void;
    windowBudget?: bigint;
    now?: () => number;
  }) {
    const inventory = new SwapInventory({
      balances: {
        [KEY49]: {
          available: 1_000n,
          total: 1_000n,
          ...(opts?.windowBudget !== undefined && {
            windowBudget: opts.windowBudget,
          }),
        },
      },
      ...(opts?.now && { clock: opts.now }),
    });
    const channelState = new SwapChannelState({
      channels: {
        [`ETH:${CHAIN49}:0xchan49`]: {
          channelId: '0xchan49',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const signBalanceProof = vi.fn(
      opts?.signBalanceProof ?? (async () => new Uint8Array([0x49]))
    );
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: {
        [CHAIN49]: {
          chain: CHAIN49,
          chainKind: 'evm' as const,
          signBalanceProof,
        },
      },
      channelState,
      ...(opts?.persistState && { persistState: opts.persistState }),
    });
    return { issuer, inventory, channelState, signBalanceProof };
  }

  function rollingParams(targetAmount = 50n) {
    return {
      sourceAmount: 100_000n,
      targetAmount,
      pair: PAIR_USDC_TO_ETH,
      senderPubkey: SENDER_PUBKEY,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor(),
    };
  }

  function window49(inventory: SwapInventory) {
    return inventory
      .windowSnapshot()
      .find((w) => w.assetCode === 'ETH' && w.chain === CHAIN49)!;
  }

  it('[P0] reserves the window (no permanent debit), returns a reservationId, honors reservationTtlMs', async () => {
    let now = 10_000;
    const { issuer, inventory } = buildRollingIssuer({ now: () => now });
    const result = await issuer.issueRollingClaim({
      ...rollingParams(),
      reservationTtlMs: 1_234,
    });
    expect(result.claim).toBeInstanceOf(Uint8Array);
    expect(result.reservationId.length).toBeGreaterThan(0);
    // available untouched; the amount is IN FLIGHT.
    expect(inventory.get('ETH', CHAIN49)!.available).toBe(1_000n);
    const w = window49(inventory);
    expect(w.inFlight).toBe(50n);
    expect(w.free).toBe(950n);
    const reservations = inventory.reservationsSnapshot();
    expect(reservations[result.reservationId]).toEqual({
      key: KEY49,
      amount: 50n,
      expiresAt: 10_000 + 1_234,
    });
    // TTL expiry frees the slot (crashed/stalled packet).
    now = 10_000 + 1_235;
    expect(window49(inventory).inFlight).toBe(0n);
    expect(window49(inventory).free).toBe(1_000n);
  });

  it('[P0] write-ahead: the reservation is durable BEFORE the claim is signed', async () => {
    const order: string[] = [];
    let reservationsAtPersist = -1;
    const stack = buildRollingIssuer({
      persistState: () => {
        order.push('persist');
        reservationsAtPersist = Object.keys(
          stack.inventory.reservationsSnapshot()
        ).length;
      },
      signBalanceProof: async () => {
        order.push('sign');
        return new Uint8Array([0x49]);
      },
    });
    await stack.issuer.issueRollingClaim(rollingParams());
    expect(order).toEqual(['persist', 'sign']);
    expect(reservationsAtPersist).toBe(1);
  });

  it('[P0] write-ahead persist failure → reservation + watermark rolled back, claim refused', async () => {
    let fail = true;
    const { issuer, inventory, channelState, signBalanceProof } =
      buildRollingIssuer({
        persistState: () => {
          if (fail) throw new Error('disk full');
        },
      });
    await expect(issuer.issueRollingClaim(rollingParams())).rejects.toThrow(
      /persist/i
    );
    expect(signBalanceProof).not.toHaveBeenCalled();
    expect(window49(inventory).inFlight).toBe(0n);
    const entry = channelState.get({
      assetCode: 'ETH',
      chain: CHAIN49,
      senderPubkey: SENDER_PUBKEY,
    })!;
    expect(entry.nonce).toBe(0n);
    fail = false;
    await expect(
      issuer.issueRollingClaim(rollingParams())
    ).resolves.toBeDefined();
  });

  it('[P0] signer failure → reservation released + watermark reversed (nothing leaks)', async () => {
    const { issuer, inventory, channelState } = buildRollingIssuer({
      signBalanceProof: async () => {
        throw new Error('signer exploded');
      },
    });
    await expect(issuer.issueRollingClaim(rollingParams())).rejects.toThrow(
      /signing failed/i
    );
    expect(window49(inventory).inFlight).toBe(0n);
    expect(window49(inventory).free).toBe(1_000n);
    expect(
      channelState.get({
        assetCode: 'ETH',
        chain: CHAIN49,
        senderPubkey: SENDER_PUBKEY,
      })!.nonce
    ).toBe(0n);
  });

  it('[P0] capacity refusal: windowBudget − inFlight − unsettled gates the reserve with INSUFFICIENT_INVENTORY (T04 vocabulary)', async () => {
    const { issuer, inventory } = buildRollingIssuer({ windowBudget: 70n });
    const first = await issuer.issueRollingClaim(rollingParams(50n));
    // 70 budget − 50 in flight = 20 free < 50.
    await expect(issuer.issueRollingClaim(rollingParams(50n))).rejects.toThrow(
      SwapInventoryError
    );
    await expect(
      issuer.issueRollingClaim(rollingParams(50n))
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_INVENTORY' });
    // Commit converts to unsettled — STILL occupies the window.
    issuer.commitRollingClaim({
      reservationId: first.reservationId,
      pair: PAIR_USDC_TO_ETH,
      targetAmount: 50n,
    });
    expect(window49(inventory).unsettled).toBe(50n);
    await expect(issuer.issueRollingClaim(rollingParams(50n))).rejects.toThrow(
      /window capacity/
    );
    // Settlement confirmation frees it.
    inventory.recordSettlement({
      assetCode: 'ETH',
      chain: CHAIN49,
      channelId: '0xchan49',
      cumulativeAmount: 50n,
    });
    await expect(
      issuer.issueRollingClaim(rollingParams(50n))
    ).resolves.toBeDefined();
  });

  it('[P0] rollbackRollingClaim releases exactly once (double unwind cannot double-decrement the watermark)', async () => {
    const persist = vi.fn();
    const { issuer, inventory, channelState } = buildRollingIssuer({
      persistState: persist,
    });
    const issued = await issuer.issueRollingClaim(rollingParams(50n));
    const persistsAfterIssue = persist.mock.calls.length;
    const rollback = () =>
      issuer.rollbackRollingClaim({
        reservationId: issued.reservationId,
        pair: PAIR_USDC_TO_ETH,
        senderPubkey: SENDER_PUBKEY,
        targetAmount: 50n,
      });
    rollback();
    const entry = () =>
      channelState.get({
        assetCode: 'ETH',
        chain: CHAIN49,
        senderPubkey: SENDER_PUBKEY,
      })!;
    expect(entry().nonce).toBe(0n);
    expect(entry().cumulativeAmount).toBe(0n);
    expect(window49(inventory).free).toBe(1_000n);
    expect(persist.mock.calls.length).toBe(persistsAfterIssue + 1);
    // Second unwind: logged no-op — watermark NOT decremented again, no persist.
    rollback();
    expect(entry().nonce).toBe(0n);
    expect(entry().cumulativeAmount).toBe(0n);
    expect(window49(inventory).free).toBe(1_000n);
    expect(persist.mock.calls.length).toBe(persistsAfterIssue + 1);
  });

  it('[P1] late commit (reservation TTL-expired mid-flight) still records the liability', async () => {
    let now = 0;
    const { issuer, inventory } = buildRollingIssuer({ now: () => now });
    const issued = await issuer.issueRollingClaim({
      ...rollingParams(50n),
      reservationTtlMs: 100,
    });
    now = 200; // reservation expired while leg B was in flight
    issuer.commitRollingClaim({
      reservationId: issued.reservationId,
      pair: PAIR_USDC_TO_ETH,
      targetAmount: 50n,
    });
    const w = window49(inventory);
    expect(w.inFlight).toBe(0n);
    // The revealed claim is redeemable regardless of the clock: liability
    // is recorded anyway.
    expect(w.unsettled).toBe(50n);
  });
});
