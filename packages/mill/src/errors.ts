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

/**
 * Startup-time failure codes for `startMill()` (Story 12.7 AC-11).
 *
 * `INVALID_CONFIG`         — config validation failed (missing/conflicting fields).
 * `MILL_REQUIRES_MNEMONIC` — caller supplied `secretKey` only; Mill key
 *                            derivation (BIP-32) requires a BIP-39 mnemonic
 *                            (D12-011).
 * `MISSING_KEY`            — pair targets a chain family whose key was not
 *                            derived (operator forgot to list it in
 *                            `config.chains`).
 * `UNSUPPORTED_CHAIN_FAMILY` — pair targets a chain prefix the Mill does
 *                              not recognise.
 * `CONNECTOR_INIT_FAILED`  — failed to construct / start the embedded
 *                            connector.
 * `HANDLER_REGISTRATION_FAILED` — registering the kind:1059 swap handler
 *                                  on the registry failed.
 */
export type MillStartErrorCode =
  | 'INVALID_CONFIG'
  | 'MILL_REQUIRES_MNEMONIC'
  | 'MISSING_KEY'
  | 'UNSUPPORTED_CHAIN_FAMILY'
  | 'CONNECTOR_INIT_FAILED'
  | 'HANDLER_REGISTRATION_FAILED';

export class MillStartError extends Error {
  public readonly code: MillStartErrorCode;

  constructor(
    code: MillStartErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(`[${code}] ${message}`, options as ErrorOptions | undefined);
    this.name = 'MillStartError';
    this.code = code;
  }
}
