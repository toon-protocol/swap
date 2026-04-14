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
