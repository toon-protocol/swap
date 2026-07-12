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
import { MillInventory } from './inventory.js';
import { MillChannelState } from './channel-state.js';
import { MillInventoryError, MillWalletError } from './errors.js';

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
      chainRecipient: FIXTURE_EVM_RECIPIENT,
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
        chainRecipient: FIXTURE_EVM_RECIPIENT,
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
        chainRecipient: FIXTURE_EVM_RECIPIENT,
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
        chainRecipient: FIXTURE_EVM_RECIPIENT,
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
        chainRecipient: FIXTURE_EVM_RECIPIENT,
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
// recipient/swapSignerAddress so the Mill's swap handler can emit them in
// FULFILL metadata (the load-bearing contract for `buildSettlementTx()`).
//
// When `signerAddresses` is omitted (legacy caller), the result MUST stay in
// the pre-12.6 shape ({ claim, claimId } only) — this is the "one story-cycle
// of compatibility" AC-3 calls out.
// ---------------------------------------------------------------------------

describe('Story 12.6 AC-3 — IssueClaimResult settlement-context fields', () => {
  const EVM_MILL_SIGNER = '0x' + 'c'.repeat(40);
  const CHAIN = 'evm:base:8453';

  it('[P0] surfaces channelId/nonce/cumulativeAmount/recipient/swapSignerAddress when signerAddresses configured', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
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
      signerAddresses: { [CHAIN]: EVM_MILL_SIGNER },
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
    // Mill signer address threaded through from config.
    expect(result.swapSignerAddress).toBe(EVM_MILL_SIGNER);
  });

  it('[P0] monotonically increments nonce + cumulativeAmount across two sequential claims', async () => {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
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
      signerAddresses: { [CHAIN]: EVM_MILL_SIGNER },
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
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
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
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
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
  const EVM_MILL_SIGNER_FOR_SETTLEMENT = '0x' + 'c'.repeat(40);
  const CHAIN = 'evm:base:8453';

  function buildIssuer(opts?: {
    signBalanceProof?: (arg: unknown) => Promise<Uint8Array>;
    withSettlementAddresses?: boolean;
  }): {
    issuer: MultiChainClaimIssuer;
    signer: {
      signBalanceProof: Mock<[arg: unknown], Promise<Uint8Array>>;
    };
    inventory: MillInventory;
    channelState: MillChannelState;
  } {
    const inventory = new MillInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new MillChannelState({
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
            signerAddresses: { [CHAIN]: EVM_MILL_SIGNER_FOR_SETTLEMENT },
          }
        : {}),
    });
    return { issuer, signer, inventory, channelState };
  }

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
      name: 'MillWalletError',
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
    // MillWalletError('SIGNING_FAILED') BEFORE any inventory debit or
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
    // And the error class is the MillWalletError('SIGNING_FAILED') family so
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
    ).rejects.toBeInstanceOf(MillWalletError);
  });
});
