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
    const exported = swapNode as unknown as Record<string, unknown>;
    // Their paired types (`CreateSwapHandlerConfig`, `WithMaxRateAgeOptions`)
    // are erased at runtime and cannot be asserted here — `pnpm typecheck`
    // against this file's `import * as swapNode` is what pins those.
    for (const name of ['createSwapHandler', 'withMaxRateAge']) {
      expect(exported[name]).toBeUndefined();
    }

    // MultiChainClaimIssuer and SwapInventory survive as the leg-B signer and
    // the rolling window's capital — only their legacy methods are gone.
    // (`SwapInventory.credit` is `private`, so it leaves the typed surface
    // without leaving the prototype; there is nothing to assert on it here.)
    const prototypeOf = (ctor: unknown): Record<string, unknown> =>
      (ctor as { prototype: Record<string, unknown> }).prototype;
    expect(
      prototypeOf(swapNode.MultiChainClaimIssuer)['issueClaim']
    ).toBeUndefined();
    for (const name of ['debit', 'refundDebit']) {
      expect(prototypeOf(swapNode.SwapInventory)[name]).toBeUndefined();
    }
  });
});
