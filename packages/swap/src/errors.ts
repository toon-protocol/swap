/**
 * Error classes for @toon-protocol/swap (Story 12.4 AC-2).
 *
 * Two shapes:
 *   - `SwapInventoryError` — raised from inventory operations (debit/credit).
 *     The `INSUFFICIENT_INVENTORY` code is load-bearing: Story 12.3's swap
 *     handler detects it via `err.code === 'INSUFFICIENT_INVENTORY'` and
 *     rejects with ILP `T04 Insufficient liquidity`. Do NOT rename.
 *   - `SwapWalletError` — raised from key derivation, signer lookup, and
 *     balance-proof signing. All other codes flow through the handler as
 *     ILP `T00 Internal error` (by design — the handler is a protocol
 *     boundary and does not leak swap-node-internal failure modes).
 */

export type SwapInventoryErrorCode =
  | 'INSUFFICIENT_INVENTORY'
  | 'UNKNOWN_PAIR'
  | 'INVENTORY_NOT_INITIALIZED';

export type SwapWalletErrorCode =
  | 'INVALID_MNEMONIC'
  | 'UNSUPPORTED_CHAIN'
  | 'DERIVATION_FAILED'
  | 'SIGNING_FAILED'
  | 'INVALID_CONFIG';

export class SwapInventoryError extends Error {
  public readonly code: SwapInventoryErrorCode;

  constructor(
    code: SwapInventoryErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'SwapInventoryError';
    this.code = code;
  }
}

export class SwapWalletError extends Error {
  public readonly code: SwapWalletErrorCode;

  constructor(
    code: SwapWalletErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'SwapWalletError';
    this.code = code;
  }
}

/**
 * Startup-time failure codes for `startSwapNode()` (Story 12.7 AC-11).
 *
 * `INVALID_CONFIG`         — config validation failed (missing/conflicting fields).
 * `SWAP_REQUIRES_MNEMONIC` — caller supplied `secretKey` only; swap node key
 *                            derivation (BIP-32) requires a BIP-39 mnemonic
 *                            (D12-011).
 * `MISSING_KEY`            — pair targets a chain family whose key was not
 *                            derived (operator forgot to list it in
 *                            `config.chains`).
 * `UNSUPPORTED_CHAIN_FAMILY` — pair targets a chain prefix the swap node does
 *                              not recognise.
 * `CONNECTOR_INIT_FAILED`  — failed to construct / start the embedded
 *                            connector.
 * `HANDLER_REGISTRATION_FAILED` — registering the kind:1059 swap handler
 *                                  on the registry failed.
 */
export type SwapNodeStartErrorCode =
  | 'INVALID_CONFIG'
  | 'SWAP_REQUIRES_MNEMONIC'
  | 'MISSING_KEY'
  | 'UNSUPPORTED_CHAIN_FAMILY'
  | 'CONNECTOR_INIT_FAILED'
  | 'HANDLER_REGISTRATION_FAILED';

export class SwapNodeStartError extends Error {
  public readonly code: SwapNodeStartErrorCode;

  constructor(
    code: SwapNodeStartErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(`[${code}] ${message}`, options as ErrorOptions | undefined);
    this.name = 'SwapNodeStartError';
    this.code = code;
  }
}
