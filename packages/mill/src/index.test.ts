/**
 * Public-API export tests — Story 12.4 AC-9.
 *
 * Mirrors `packages/sdk/src/index.test.ts` — any accidental rename or
 * removal in `src/index.ts` surfaces here as a test failure.
 */
import { describe, it, expect } from 'vitest';

import * as mill from './index.js';

describe('@toon-protocol/mill public API exports (Story 12.4 AC-9)', () => {
  it('[P2] exports deriveMillKeys function', () => {
    expect(typeof mill.deriveMillKeys).toBe('function');
  });

  it('[P2] exports MillInventory class', () => {
    expect(typeof mill.MillInventory).toBe('function');
  });

  it('[P2] exports MillChannelState class', () => {
    expect(typeof mill.MillChannelState).toBe('function');
  });

  it('[P2] exports EvmPaymentChannelSigner class', () => {
    expect(typeof mill.EvmPaymentChannelSigner).toBe('function');
  });

  it('[P2] exports MinaPaymentChannelSigner class', () => {
    expect(typeof mill.MinaPaymentChannelSigner).toBe('function');
  });

  it('[P2] exports SolanaPaymentChannelSigner class', () => {
    expect(typeof mill.SolanaPaymentChannelSigner).toBe('function');
  });

  it('[P2] exports MultiChainClaimIssuer class', () => {
    expect(typeof mill.MultiChainClaimIssuer).toBe('function');
  });

  it('[P2] exports MillInventoryError class', () => {
    expect(typeof mill.MillInventoryError).toBe('function');
  });

  it('[P2] exports MillWalletError class', () => {
    expect(typeof mill.MillWalletError).toBe('function');
  });

  it('[P2] exports startMill (Story 12.7)', () => {
    expect(typeof mill.startMill).toBe('function');
  });

  it('[P2] exports MillStartError class (Story 12.7)', () => {
    expect(typeof mill.MillStartError).toBe('function');
  });

  it('[P2] re-exports createSwapHandler from @toon-protocol/sdk (Story 12.7)', () => {
    expect(typeof mill.createSwapHandler).toBe('function');
  });
});
