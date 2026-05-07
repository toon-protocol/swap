/**
 * @toon-protocol/mill — public API (Story 12.4 AC-9).
 */

// Wallet + key derivation (Story 12.4)
export { deriveMillKeys } from './wallet.js';
export type { MillKeys, MillChainKind, DeriveMillKeysInput } from './wallet.js';

// Inventory (Story 12.4)
export { MillInventory } from './inventory.js';
export type { MillInventoryBalance, MillInventoryInit } from './inventory.js';

// Payment-channel signing (Story 12.4)
export type {
  PaymentChannelSigner,
  PaymentChannelSignParams,
  EvmPaymentChannelSignerConfig,
  MinaPaymentChannelSignerConfig,
  SolanaPaymentChannelSignerConfig,
} from './payment-channel-signer.js';
export {
  EvmPaymentChannelSigner,
  MinaPaymentChannelSigner,
  SolanaPaymentChannelSigner,
} from './payment-channel-signer.js';

// Channel state (Story 12.4)
export { MillChannelState } from './channel-state.js';
export type {
  ChannelEntry,
  MillChannelStateInit,
  ReserveParams,
  Reservation,
  ReleaseLogger,
} from './channel-state.js';

// Claim issuer (Story 12.4)
export { MultiChainClaimIssuer } from './claim-issuer.js';
export type {
  MultiChainClaimIssuerConfig,
  MillClaimIssuerLogger,
} from './claim-issuer.js';

// Errors (Story 12.4)
export { MillInventoryError, MillWalletError } from './errors.js';
export type { MillInventoryErrorCode, MillWalletErrorCode } from './errors.js';

// Runtime entrypoint (Story 12.7)
export { startMill } from './mill.js';
// NOTE: `buildSignerAddresses` is an @internal helper exposed for unit tests
// via the `./mill.js` module path (AC-5). It is intentionally NOT re-exported
// from the public barrel.
export type {
  MillConfig,
  MillInstance,
  MillHealthResponse,
  MillLogger,
  Publisher,
} from './mill.js';
export { MillStartError } from './errors.js';
export type { MillStartErrorCode } from './errors.js';

// Convenience re-export for operators (Story 12.7 AC-1) — do not wrap.
export { createSwapHandler } from '@toon-protocol/sdk';
export type { CreateSwapHandlerConfig } from '@toon-protocol/sdk';

// Re-export transport config from connector for convenience
export type { TransportConfig } from '@toon-protocol/connector';

// Settlement event payload (Story D3) — emitted when a Mill-issued claim is
// settled on-chain; consumed by the townhouse-web earnings aggregator (D4).
export { buildSettlementEvent } from './settlement-event.js';
export type {
  SettlementEvent,
  SettlementChain,
  BuildSettlementEventParams,
} from './settlement-event.js';
