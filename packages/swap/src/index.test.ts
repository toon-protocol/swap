/**
 * Public-API export tests — Story 12.4 AC-9.
 *
 * Mirrors `packages/sdk/src/index.test.ts` — any accidental rename or
 * removal in `src/index.ts` surfaces here as a test failure.
 */
import { describe, it, expect } from 'vitest';

import * as swapNode from './index.js';

describe('@toon-protocol/swap public API exports (Story 12.4 AC-9)', () => {
  it('[P2] exports deriveSwapNodeKeys function', () => {
    expect(typeof swapNode.deriveSwapNodeKeys).toBe('function');
  });

  it('[P2] exports SwapInventory class', () => {
    expect(typeof swapNode.SwapInventory).toBe('function');
  });

  it('[P2] exports SwapChannelState class', () => {
    expect(typeof swapNode.SwapChannelState).toBe('function');
  });

  it('[P2] exports EvmPaymentChannelSigner class', () => {
    expect(typeof swapNode.EvmPaymentChannelSigner).toBe('function');
  });

  it('[P2] exports MinaPaymentChannelSigner class', () => {
    expect(typeof swapNode.MinaPaymentChannelSigner).toBe('function');
  });

  it('[P2] exports SolanaPaymentChannelSigner class', () => {
    expect(typeof swapNode.SolanaPaymentChannelSigner).toBe('function');
  });

  it('[P2] exports MultiChainClaimIssuer class', () => {
    expect(typeof swapNode.MultiChainClaimIssuer).toBe('function');
  });

  it('[P2] exports SwapInventoryError class', () => {
    expect(typeof swapNode.SwapInventoryError).toBe('function');
  });

  it('[P2] exports SwapWalletError class', () => {
    expect(typeof swapNode.SwapWalletError).toBe('function');
  });

  it('[P2] exports startSwapNode (Story 12.7)', () => {
    expect(typeof swapNode.startSwapNode).toBe('function');
  });

  it('[P2] exports SwapNodeStartError class (Story 12.7)', () => {
    expect(typeof swapNode.SwapNodeStartError).toBe('function');
  });

  it('[P0] (toon-meta#411 Stage 6) does NOT re-export the withdrawn legacy API surface', () => {
    const legacy = swapNode as unknown as Record<string, unknown>;
    expect(legacy['createSwapHandler']).toBeUndefined();
    expect(legacy['CreateSwapHandlerConfig']).toBeUndefined();
    expect(legacy['withMaxRateAge']).toBeUndefined();
    expect(legacy['WithMaxRateAgeOptions']).toBeUndefined();
    // MultiChainClaimIssuer and SwapInventory survive as the leg-B signer and
    // the rolling window's capital — only their legacy methods are gone.
    expect(
      (
        swapNode.MultiChainClaimIssuer.prototype as unknown as Record<
          string,
          unknown
        >
      )['issueClaim']
    ).toBeUndefined();
    expect(
      (swapNode.SwapInventory.prototype as unknown as Record<string, unknown>)[
        'debit'
      ]
    ).toBeUndefined();
    expect(
      (swapNode.SwapInventory.prototype as unknown as Record<string, unknown>)[
        'refundDebit'
      ]
    ).toBeUndefined();
  });
});
