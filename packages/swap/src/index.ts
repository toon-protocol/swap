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
export {
  buildInventoryReport,
  handleAdminRequest,
  isAdminPath,
  ADMIN_PATHS,
} from './admin-surface.js';
export type {
  AdminInventoryReport,
  AdminPoolView,
  AdminChannelView,
  AdminSurfaceDeps,
  AdminRequest,
  AdminResponse,
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
  PersistentSeenEventIds,
  SwapStateStoreError,
  DEFAULT_PERSISTED_SEEN_IDS_CAP,
} from './state-store.js';
export type {
  SwapStateStore,
  SwapStateStoreErrorCode,
  SwapStatePersisterInit,
  SwapStateExtras,
  PersistedSwapState,
  PersistedInventoryEntry,
  PersistedChannelEntry,
  PersistedReservationEntry,
  PersistedMakerSession,
  PersistedInboundEntry,
  PersistedOrderEntry,
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
  SwapNodeRelayConfig,
} from './swap-node.js';
export {
  validateConfig as validateSwapNodeConfig,
  buildSignerAddresses,
  parseEvmChainId,
  DEFAULT_RELAY_DESTINATION,
  DEFAULT_ORDER_FILL,
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
// The rolling/3 wire — what a taker and a maker say to each other through a relay
// ---------------------------------------------------------------------------
export {
  SWAP_WIRE_PROTOCOL,
  SWAP_ORDER_KIND,
  SWAP_RUMOR_KIND,
  SWAP_REFUSAL_REASONS,
  isValidStreamNonce,
  parseSwapOrder,
  parseSwapAccept,
  parseSwapFill,
  parseSwapDone,
  parseSwapClaim,
  parseSwapTakerMessage,
  parseSwapWireAnswer,
  attributionPayerKey,
} from './wire.js';
export type {
  SwapWireAsset,
  SwapWirePair,
  SwapLegTerms,
  SwapLegBTerms,
  SwapClaim,
  SwapOrder,
  SwapAccept,
  SwapQuote,
  SwapFill,
  SwapAdvance,
  SwapDone,
  SwapRefusal,
  SwapRefusalReason,
  SwapWireAnswer,
  SwapTakerMessage,
  SwapWireParse,
  PaymentAttribution,
} from './wire.js';
export {
  MakerEngine,
  makerRefusal,
  chainFamily,
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
} from './maker-engine.js';

// The relay plane: identity, gift wraps, reads, paid writes, the maker loop
export {
  deriveNostrIdentity,
  nostrIdentityFromSecret,
  NOSTR_COIN_TYPE,
} from './nostr-keys.js';
export type { NostrIdentity, DeriveNostrIdentityInput } from './nostr-keys.js';
export {
  wrapGiftWrap,
  unwrapGiftWrap,
  eventExpiration,
  GiftWrapAddressError,
  GiftWrapDecryptError,
  GIFT_WRAP_KIND,
  SEAL_KIND,
} from './nip59.js';
export type {
  UnwrappedGiftWrap,
  WrapGiftWrapInput,
  WrappedGiftWrap,
  Rumor,
} from './nip59.js';
export { RelaySubscription } from './relay-subscription.js';
export type {
  NostrFilter,
  RelaySubscriptionOptions,
  MinimalWebSocket,
  WebSocketFactory,
  DrainResult,
} from './relay-subscription.js';
export { createRelayWriter, createRelayClient } from './relay-writer.js';
export type {
  RelayWriter,
  RelayWriterConfig,
  RelayWriteResult,
  RelayWriteAccepted,
  RelayWriteRefused,
  RelayClientConfig,
  RelayClient,
  PaidSender,
} from './relay-writer.js';
export {
  verifyInboundClaim,
  createReadBudgets,
  createRpcChannelSlotReader,
} from './received-claim.js';
export type {
  InboundClaim,
  ChannelFacts,
  InboundWatermark,
  CounterpartySlot,
  ChannelSlotReader,
  ReadBudget,
  VerifyInboundClaimInput,
  VerifyInboundClaimResult,
  InboundClaimRejectionCode,
} from './received-claim.js';
export {
  SwapMakerLoop,
  DEFAULT_ORDER_TTL_MS,
  DEFAULT_ORDER_REFRESH_MS,
  DEFAULT_MAX_CHAIN_READS_PER_MIN,
  INBOX_SUB_ID,
} from './swap-maker.js';
export type {
  SwapMakerLoopConfig,
  SwapMakerLoopHealth,
  RelayReader,
  SwapMakerLoopLogger,
} from './swap-maker.js';
export {
  SwapTaker,
  SwapTakerError,
  defaultChannelFunder,
  DEFAULT_ANSWER_TIMEOUT_MS,
  DEFAULT_MAX_RESENDS,
  DEFAULT_TAKER_SESSION_TTL_MS,
  ORDERS_SUB_ID,
  TAKER_INBOX_SUB_ID,
} from './swap-taker.js';
export type {
  SwapTakerConfig,
  SwapTakerLogger,
  SwapOrderListing,
  ChannelFunder,
  Redeemer,
} from './swap-taker.js';
export {
  JsonFileTakerStateStore,
  InMemoryTakerStateStore,
  emptyTakerState,
  validateTakerState,
} from './taker-state.js';
export {
  createRedeemer,
  ed25519VerifyIx,
  claimFromChannelIx,
  closeChannelIx,
  settleChannelIx,
} from './redeem.js';
export type { RedeemerConfig, SolanaSettler } from './redeem.js';
export {
  createGasStationRedeemer,
  GasStationRefusal,
  DEFAULT_GAS_STATION_DESTINATION,
  SOLANA_GAS_STATION_KIND,
  EVM_GAS_STATION_KIND,
} from './gas-station-redeem.js';
export type {
  GasStationRedeemerConfig,
  ForwarderDomain,
} from './gas-station-redeem.js';
export { createTakerRuntime } from './taker-runtime.js';
export type { TakerRuntime, TakerRuntimeConfig } from './taker-runtime.js';
export type {
  TakerStateStore,
  PersistedTakerState,
  TakerSessionState,
  TakerChannelWatermark,
} from './taker-state.js';
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

// Re-export transport config from connector for convenience

// Settlement event payload (Story D3) — emitted when a swap-node-issued claim is
// settled on-chain; consumed by the townhouse-web earnings aggregator (D4).
export { buildSettlementEvent } from './settlement-event.js';
export type {
  SettlementEvent,
  SettlementChain,
  BuildSettlementEventParams,
} from './settlement-event.js';
