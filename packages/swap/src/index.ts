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
  // Issue #138 — chain-corroborated settle-and-recycle outcome.
  ChainRedemptionResult,
  // swap#142 — chain-corroborated NEW-capital credit outcome.
  FundingCreditResult,
} from './inventory.js';

// Chain-truth inventory reconciliation + operator surface (issue #138)
export {
  SwapInventoryReconciler,
  parseChannelStoredKey,
  DEFAULT_RECONCILE_INTERVAL_MS,
} from './inventory-reconciler.js';
export type {
  SwapInventoryReconcilerConfig,
  SwapInventoryReconcilerLogger,
  ChannelStateSnapshotSource,
  ChannelRedemptionObservation,
  PoolReconcileTotals,
  ReconcileResult,
  ReconcileOptions,
  // swap#142 — the pool's on-chain capital position.
  ChannelFundingObservation,
  PoolFundingReading,
} from './inventory-reconciler.js';
export { buildInventoryReport, registerAdminRoutes } from './admin-surface.js';
export type {
  AdminInventoryReport,
  AdminPoolView,
  AdminChannelView,
  AdminSurfaceDeps,
} from './admin-surface.js';

// Payment-channel signing (Story 12.4)
export type {
  PaymentChannelSigner,
  PaymentChannelSignParams,
  EvmPaymentChannelSignerConfig,
  MinaPaymentChannelSignerConfig,
  SolanaPaymentChannelSignerConfig,
  TokenNetworkBalanceProofSignerConfig,
} from './payment-channel-signer.js';
export {
  EvmPaymentChannelSigner,
  MinaPaymentChannelSigner,
  SolanaPaymentChannelSigner,
  TokenNetworkBalanceProofSigner,
  TOKEN_NETWORK_BALANCE_PROOF_TYPES,
  tokenNetworkBalanceProofDigest,
  solanaBalanceProofMessage,
  SOLANA_BALANCE_PROOF_DOMAIN_TAG,
  SOLANA_BALANCE_PROOF_MESSAGE_SIZE,
} from './payment-channel-signer.js';

// Channel state (Story 12.4)
export { SwapChannelState } from './channel-state.js';
export type {
  ChannelEntry,
  SwapChannelStateInit,
  ReserveParams,
  Reservation,
  ReleaseLogger,
  // Issue #113 — the `SwapChannelStateInit.onChainReader` seam.
  ChannelOnChainReader,
  // swap#136 — structured rebind refusals (channelId + unredeemed delta).
  ChannelRebindRefusal,
  // swap#142 — the optional funding-read capability on the reader seam.
  ChannelFundingPosition,
} from './channel-state.js';
export {
  describeChannelRebindRefusal,
  channelFundedTotal,
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
export type {
  SwapInventoryErrorCode,
  SwapWalletErrorCode,
  SwapWalletErrorDetails,
} from './errors.js';

// swap#136 — claim-refusal contract (the diagnosable replacement for the SDK
// swap handler's blanket `T00 Internal error`).
export {
  CLAIM_REFUSAL_REASONS,
  classifyClaimIssuerError,
  buildClaimRefusalReject,
  createClaimRefusalMapper,
} from './claim-refusal.js';
export type {
  ClaimRefusal,
  ClaimRefusalReason,
  ClaimRefusalReject,
} from './claim-refusal.js';

// swap#136 — the process-level structured logger the CLI installs.
export {
  createConsoleLogger,
  resolveLogLevel,
  DEFAULT_SWAP_LOG_LEVEL,
  SWAP_LOG_LEVEL_ENV,
} from './logger.js';
export type { SwapLogLevel, ConsoleLoggerOptions } from './logger.js';

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
  SwapNodeChainProvider,
  SwapNodeEvmChainProvider,
  SwapNodeSolanaChainProvider,
  SwapNodeMinaChainProvider,
} from './swap-node.js';
export {
  validateConfig as validateSwapNodeConfig,
  buildSignerAddresses,
  parseEvmChainId,
} from './swap-node.js';
export { SwapNodeStartError } from './errors.js';
export type { SwapNodeStartErrorCode } from './errors.js';

// Maker staleness reject — maxRateAge (toon-protocol/swap#48, rolling-swap §4)
export {
  RateFreshnessGuard,
  buildStaleRateReject,
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
  RateStalenessLogger,
} from './rate-staleness.js';

// ---------------------------------------------------------------------------
// The rolling/2 wire — what a taker speaks to a maker behind a Rust connector
// ---------------------------------------------------------------------------
export {
  SWAP_WIRE_PROTOCOL,
  SWAP_REFUSAL_REASONS,
  SWAP_REFUSAL_STATUS,
  PAYMENT_HEADER_PAYER,
  PAYMENT_HEADER_AMOUNT,
  PAYMENT_HEADER_CHAIN,
  isValidStreamNonce,
  parseSwapRfqRequest,
  parseSwapFillRequest,
  parseSwapWireAnswer,
  readPaymentAttribution,
} from './wire.js';
export type {
  SwapWireAsset,
  SwapWirePair,
  SwapRfqRequest,
  SwapLegBTerms,
  SwapQuote,
  SwapFillRequest,
  SwapAdvance,
  SwapRefusal,
  SwapRefusalReason,
  SwapWireAnswer,
  SwapWireParse,
  PaymentAttribution,
} from './wire.js';
export {
  MakerEngine,
  defaultValidateRecipient,
  DEFAULT_QUOTE_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_MAX_SESSIONS,
  SWAP_FILL_CONTEXT_KIND,
} from './maker-engine.js';
export type {
  MakerEngineConfig,
  MakerEngineLogger,
  MakerSession,
  MakerAnswer,
} from './maker-engine.js';
export {
  registerMakerRoutes,
  MAKER_RFQ_PATH,
  MAKER_FILL_PATH,
} from './maker-app.js';
export type { MakerAppDeps, MakerAppLogger } from './maker-app.js';
export { deriveSolanaChannelPda, findProgramAddress } from './solana-pda.js';
export {
  createSolanaLegBChannelProvisioner,
  decodeSolanaChannelAccount,
  DEFAULT_SOLANA_CHALLENGE_DURATION_SECONDS,
} from './solana-leg-b-channel.js';
export type {
  SolanaLegBChannelProvisioner,
  SolanaLegBChannelProvisionerConfig,
  SolanaChannelAccount,
  EnsuredSolanaChannel,
} from './solana-leg-b-channel.js';
export {
  createEvmLegBChannelProvisioner,
  deriveEvmChannelId,
  sortEvmParticipants,
  DEFAULT_EVM_SETTLEMENT_TIMEOUT_SECONDS,
} from './evm-leg-b-channel.js';
export type {
  EvmLegBChannelProvisioner,
  EvmLegBChannelProvisionerConfig,
  EvmChannelSlot,
  EnsuredEvmChannel,
} from './evm-leg-b-channel.js';
export {
  createHttpRateProvider,
  DEFAULT_RATE_FETCH_TIMEOUT_MS,
} from './rate-provider.js';
export type { HttpRateProviderOptions } from './rate-provider.js';

// Convenience re-export for operators (Story 12.7 AC-1) — do not wrap.
export { createSwapHandler } from '@toon-protocol/sdk';
export type { CreateSwapHandlerConfig } from '@toon-protocol/sdk';

// Re-export transport config from connector for convenience

// Settlement event payload (Story D3) — emitted when a swap-node-issued claim is
// settled on-chain; consumed by the townhouse-web earnings aggregator (D4).
export { buildSettlementEvent } from './settlement-event.js';
export type {
  SettlementEvent,
  SettlementChain,
  BuildSettlementEventParams,
} from './settlement-event.js';
