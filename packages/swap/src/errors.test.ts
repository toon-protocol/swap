/**
 * Unit tests for `SwapInventoryError` / `SwapWalletError` (Story 12.4 AC-2).
 *
 * AC-2 declares specific code literal unions + ES2022 `cause` + `name`
 * preservation. Story 12.3's handler detects `INSUFFICIENT_INVENTORY`
 * exactly; any drift here is a cross-package break.
 *
 * Gap-fill coverage: the other `.test.ts` files only exercise the subset
 * of error codes they need. These tests pin the full contract of each
 * class so accidental rename / missing `code` / missing `name` fails here
 * first.
 */
import { describe, it, expect } from 'vitest';
import {
  SwapInventoryError,
  SwapWalletError,
  SwapNodeStartError,
} from './errors.js';

describe('SwapInventoryError contract (Story 12.4 AC-2)', () => {
  it('[P0] is an Error subclass with name="SwapInventoryError"', () => {
    const err = new SwapInventoryError('INSUFFICIENT_INVENTORY', 'low');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SwapInventoryError);
    expect(err.name).toBe('SwapInventoryError');
  });

  it('[P0] exposes readonly code literal "INSUFFICIENT_INVENTORY" (load-bearing for Story 12.3 handler)', () => {
    const err = new SwapInventoryError(
      'INSUFFICIENT_INVENTORY',
      'Insufficient inventory for USDC:evm:base:8453'
    );
    expect(err.code).toBe('INSUFFICIENT_INVENTORY');
    expect(err.message).toContain('Insufficient');
  });

  it('[P1] accepts "UNKNOWN_PAIR" code literal', () => {
    const err = new SwapInventoryError('UNKNOWN_PAIR', 'Pair not advertised');
    expect(err.code).toBe('UNKNOWN_PAIR');
  });

  it('[P1] accepts "INVENTORY_NOT_INITIALIZED" code literal', () => {
    const err = new SwapInventoryError(
      'INVENTORY_NOT_INITIALIZED',
      'no balance'
    );
    expect(err.code).toBe('INVENTORY_NOT_INITIALIZED');
  });

  it('[P2] preserves ES2022 `cause` option', () => {
    const root = new Error('root');
    const err = new SwapInventoryError('INSUFFICIENT_INVENTORY', 'wrapped', {
      cause: root,
    });
    expect((err as { cause?: unknown }).cause).toBe(root);
  });
});

describe('SwapWalletError contract (Story 12.4 AC-2)', () => {
  it('[P0] is an Error subclass with name="SwapWalletError"', () => {
    const err = new SwapWalletError('SIGNING_FAILED', 'sig');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SwapWalletError);
    expect(err.name).toBe('SwapWalletError');
  });

  it('[P1] accepts all five code literals', () => {
    for (const code of [
      'INVALID_MNEMONIC',
      'UNSUPPORTED_CHAIN',
      'DERIVATION_FAILED',
      'SIGNING_FAILED',
      'INVALID_CONFIG',
    ] as const) {
      const err = new SwapWalletError(code, 'msg');
      expect(err.code).toBe(code);
      expect(err.name).toBe('SwapWalletError');
    }
  });

  it('[P2] preserves ES2022 `cause` option', () => {
    const root = new Error('root');
    const err = new SwapWalletError('DERIVATION_FAILED', 'wrapped', {
      cause: root,
    });
    expect((err as { cause?: unknown }).cause).toBe(root);
  });
});

describe('SwapNodeStartError contract (Story 12.7 AC-11)', () => {
  it('[P0] is an Error subclass with name="SwapNodeStartError"', () => {
    const err = new SwapNodeStartError('INVALID_CONFIG', 'bad');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SwapNodeStartError);
    expect(err.name).toBe('SwapNodeStartError');
  });

  it('[P1] accepts every SwapNodeStartErrorCode literal', () => {
    for (const code of [
      'INVALID_CONFIG',
      'SWAP_REQUIRES_MNEMONIC',
      'MISSING_KEY',
      'UNSUPPORTED_CHAIN_FAMILY',
      'CONNECTOR_INIT_FAILED',
      'HANDLER_REGISTRATION_FAILED',
    ] as const) {
      const err = new SwapNodeStartError(code, 'msg');
      expect(err.code).toBe(code);
      expect(err.message).toContain(code);
    }
  });

  it('[P2] preserves ES2022 `cause` option', () => {
    const root = new Error('root');
    const err = new SwapNodeStartError(
      'HANDLER_REGISTRATION_FAILED',
      'wrapped',
      {
        cause: root,
      }
    );
    expect((err as { cause?: unknown }).cause).toBe(root);
  });
});
