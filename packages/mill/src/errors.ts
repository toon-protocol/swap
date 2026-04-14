/**
 * Error classes for @toon-protocol/mill (Story 12.4 AC-2).
 *
 * Two shapes:
 *   - `MillInventoryError` — raised from inventory operations (debit/credit).
 *     The `INSUFFICIENT_INVENTORY` code is load-bearing: Story 12.3's swap
 *     handler detects it via `err.code === 'INSUFFICIENT_INVENTORY'` and
 *     rejects with ILP `T04 Insufficient liquidity`. Do NOT rename.
 *   - `MillWalletError` — raised from key derivation, signer lookup, and
 *     balance-proof signing. All other codes flow through the handler as
 *     ILP `T00 Internal error` (by design — the handler is a protocol
 *     boundary and does not leak Mill-internal failure modes).
 */

export type MillInventoryErrorCode =
  | 'INSUFFICIENT_INVENTORY'
  | 'UNKNOWN_PAIR'
  | 'INVENTORY_NOT_INITIALIZED';

export type MillWalletErrorCode =
  | 'INVALID_MNEMONIC'
  | 'UNSUPPORTED_CHAIN'
  | 'DERIVATION_FAILED'
  | 'SIGNING_FAILED'
  | 'INVALID_CONFIG';

export class MillInventoryError extends Error {
  public readonly code: MillInventoryErrorCode;

  constructor(
    code: MillInventoryErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'MillInventoryError';
    this.code = code;
  }
}

export class MillWalletError extends Error {
  public readonly code: MillWalletErrorCode;

  constructor(
    code: MillWalletErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'MillWalletError';
    this.code = code;
  }
}
