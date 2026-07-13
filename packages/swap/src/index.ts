/**
 * @toon-protocol/swap — public API (Story 12.4 AC-9).
 */

// Wallet + key derivation (Story 12.4)
export { deriveSwapNodeKeys } from './wallet.js';
export type {
  SwapNodeKeys,
  SwapNodeChainKind,
  DeriveSwapNodeKeysInput,
} from './wallet.js';

// Inventory (Story 12.4; issue #49 in-flight window reservation lifecycle)
export { SwapInventory, DEFAULT_RESERVATION_TTL_MS } from './inventory.js';
export type {
  SwapInventoryBalance,
  SwapInventoryInit,
  SwapInventoryReservation,
  SwapWindowSnapshotEntry,
} from './inventory.js';

// Payment-channel signing (Story 12.4)
export type {
  PaymentChannelSigner,
  PaymentChannelSignParams,
  EvmPaymentChannelSignerConfig,
  MinaPaymentChannelSignerConfig,
  SolanaPaymentChannelSignerConfig,
  ClaimBalanceProofDigestParams,
  CooperativeCloseDigestParams,
} from './payment-channel-signer.js';
export {
  EvmPaymentChannelSigner,
  MinaPaymentChannelSigner,
  SolanaPaymentChannelSigner,
  // v2 EIP-712 balance-proof digest helpers (connector#324 finding #1).
  claimBalanceProofDigestEvmV2,
  cooperativeCloseDigestEvmV2,
  eip712DomainSeparatorV2,
  EIP712_DOMAIN_TYPEHASH,
  CLAIM_BALANCE_PROOF_TYPEHASH,
  COOPERATIVE_CLOSE_TYPEHASH,
} from './payment-channel-signer.js';

// Channel state (Story 12.4)
export { SwapChannelState } from './channel-state.js';
export type {
  ChannelEntry,
  SwapChannelStateInit,
  ReserveParams,
  Reservation,
  ReleaseLogger,
} from './channel-state.js';

// Claim issuer (Story 12.4)
export { MultiChainClaimIssuer } from './claim-issuer.js';
export type {
  MultiChainClaimIssuerConfig,
  SwapClaimIssuerLogger,
  IssueRollingClaimParams,
  RollingIssueClaimResult,
} from './claim-issuer.js';

// State persistence (issue #46 — rolling-swap prerequisite P2)
export {
  JsonFileSwapStateStore,
  SwapStatePersister,
  PersistentSeenPacketIds,
  SwapStateStoreError,
  DEFAULT_PERSISTED_SEEN_IDS_CAP,
} from './state-store.js';
export type {
  SwapStateStore,
  SwapStateStoreErrorCode,
  SwapStatePersisterInit,
  PersistedSwapState,
  PersistedInventoryEntry,
  PersistedChannelEntry,
  PersistedReservationEntry,
} from './state-store.js';

// Errors (Story 12.4)
export { SwapInventoryError, SwapWalletError } from './errors.js';
export type { SwapInventoryErrorCode, SwapWalletErrorCode } from './errors.js';

// Runtime entrypoint (Story 12.7)
export { startSwapNode } from './swap-node.js';
// NOTE: `buildSignerAddresses` is an @internal helper exposed for unit tests
// via the `./swap-node.js` module path (AC-5). It is intentionally NOT re-exported
// from the public barrel.
export type {
  SwapNodeConfig,
  SwapNodeInstance,
  SwapNodeHealthResponse,
  SwapNodeHealthWindowEntry,
  SwapNodeLogger,
  Publisher,
} from './swap-node.js';
export { SwapNodeStartError } from './errors.js';
export type { SwapNodeStartErrorCode } from './errors.js';

// Maker staleness reject — maxRateAge (toon-protocol/swap#48, rolling-swap §4)
export {
  RateFreshnessGuard,
  withMaxRateAge,
  buildStaleRateReject,
  normalizeRateProvider,
  validateMaxRateAgeConfig,
  pairKey,
  StaleRateError,
  STALE_RATE_REJECT_CODE,
  STALE_RATE_REJECT_MESSAGE,
  STALE_RATE_REASON,
  STALE_RATE_SEMANTIC_REASON,
  RECOMMENDED_MAX_RATE_AGE_MS,
} from './rate-staleness.js';
export type {
  MaxRateAgeConfig,
  SwapRateProvider,
  SwapRateQuote,
  TimestampedRate,
  StaleRateRejectData,
  FreshnessVerdict,
  RateFreshnessGuardConfig,
  WithMaxRateAgeOptions,
  RateStalenessLogger,
} from './rate-staleness.js';

// Rolling coupled-leg engine (issue #47 — rolling-swap §3)
export {
  RollingSwapEngine,
  RollingSessionStore,
  createConnectorLegBSender,
  parseRollingFillPayload,
  buildRollingReject,
  ROLLING_PROTOCOL,
  ROLLING_REJECT_REASONS,
  ROLLING_FILL_CONTEXT_KIND,
  DEFAULT_ROLLING_SESSION_TTL_MS,
  DEFAULT_ROLLING_MAX_SESSIONS,
  DEFAULT_LEG_B_BUDGET_MS,
  DEFAULT_LEG_B_EXPIRY_MARGIN_MS,
  DEFAULT_MIN_LEG_B_TIME_MS,
  DEFAULT_RESERVATION_GRACE_MS,
} from './rolling-engine.js';
export type {
  RollingSwapEngineConfig,
  RollingSession,
  RollingSessionStoreConfig,
  RollingFillPayload,
  RollingAdvancePayload,
  RollingAcceptRecord,
  RollingFillRequest,
  RollingFillResponse,
  RollingRejectReason,
  RollingSeenPacketIds,
  LegBPrepare,
  LegBResult,
  LegBSender,
  ConnectorLegBSenderOptions,
} from './rolling-engine.js';

// HTTP rate provider — CLI `rateProvider` wiring (issue #47 AC-3)
export {
  createHttpRateProvider,
  DEFAULT_RATE_FETCH_TIMEOUT_MS,
} from './rate-provider.js';
export type { HttpRateProviderOptions } from './rate-provider.js';

// Convenience re-export for operators (Story 12.7 AC-1) — do not wrap.
export { createSwapHandler } from '@toon-protocol/sdk';
export type { CreateSwapHandlerConfig } from '@toon-protocol/sdk';

// Re-export transport config from connector for convenience
export type { TransportConfig } from '@toon-protocol/connector';

// Settlement event payload (Story D3) — emitted when a swap-node-issued claim is
// settled on-chain; consumed by the townhouse-web earnings aggregator (D4).
export { buildSettlementEvent } from './settlement-event.js';
export type {
  SettlementEvent,
  SettlementChain,
  BuildSettlementEventParams,
} from './settlement-event.js';
