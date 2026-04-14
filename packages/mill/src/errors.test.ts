/**
 * Unit tests for `MillInventoryError` / `MillWalletError` (Story 12.4 AC-2).
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
import { MillInventoryError, MillWalletError } from './errors.js';

describe('MillInventoryError contract (Story 12.4 AC-2)', () => {
  it('[P0] is an Error subclass with name="MillInventoryError"', () => {
    const err = new MillInventoryError('INSUFFICIENT_INVENTORY', 'low');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MillInventoryError);
    expect(err.name).toBe('MillInventoryError');
  });

  it('[P0] exposes readonly code literal "INSUFFICIENT_INVENTORY" (load-bearing for Story 12.3 handler)', () => {
    const err = new MillInventoryError(
      'INSUFFICIENT_INVENTORY',
      'Insufficient inventory for USDC:evm:base:8453'
    );
    expect(err.code).toBe('INSUFFICIENT_INVENTORY');
    expect(err.message).toContain('Insufficient');
  });

  it('[P1] accepts "UNKNOWN_PAIR" code literal', () => {
    const err = new MillInventoryError(
      'UNKNOWN_PAIR',
      'Pair not advertised'
    );
    expect(err.code).toBe('UNKNOWN_PAIR');
  });

  it('[P1] accepts "INVENTORY_NOT_INITIALIZED" code literal', () => {
    const err = new MillInventoryError(
      'INVENTORY_NOT_INITIALIZED',
      'no balance'
    );
    expect(err.code).toBe('INVENTORY_NOT_INITIALIZED');
  });

  it('[P2] preserves ES2022 `cause` option', () => {
    const root = new Error('root');
    const err = new MillInventoryError(
      'INSUFFICIENT_INVENTORY',
      'wrapped',
      { cause: root }
    );
    expect((err as { cause?: unknown }).cause).toBe(root);
  });
});

describe('MillWalletError contract (Story 12.4 AC-2)', () => {
  it('[P0] is an Error subclass with name="MillWalletError"', () => {
    const err = new MillWalletError('SIGNING_FAILED', 'sig');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MillWalletError);
    expect(err.name).toBe('MillWalletError');
  });

  it('[P1] accepts all five code literals', () => {
    for (const code of [
      'INVALID_MNEMONIC',
      'UNSUPPORTED_CHAIN',
      'DERIVATION_FAILED',
      'SIGNING_FAILED',
      'INVALID_CONFIG',
    ] as const) {
      const err = new MillWalletError(code, 'msg');
      expect(err.code).toBe(code);
      expect(err.name).toBe('MillWalletError');
    }
  });

  it('[P2] preserves ES2022 `cause` option', () => {
    const root = new Error('root');
    const err = new MillWalletError('DERIVATION_FAILED', 'wrapped', {
      cause: root,
    });
    expect((err as { cause?: unknown }).cause).toBe(root);
  });
});
