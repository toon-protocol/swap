/**
 * `MultiChainClaimIssuer` (Story 12.4 AC-6, AC-8, AC-10).
 *
 * Implements the `ClaimIssuer` interface from `@toon-protocol/sdk` (type-only
 * import — no runtime cycle). Flow: debit inventory → reserve channel state
 * → await signer.signBalanceProof → return { claim, claimId }. On signer
 * failure, both inventory and channel state are reversed.
 */

import type {
  ClaimIssuer,
  IssueClaimParams,
  IssueClaimResult,
} from '@toon-protocol/sdk';

import type { MillInventory } from './inventory.js';
import type { MillChannelState, Reservation } from './channel-state.js';
import type { PaymentChannelSigner } from './payment-channel-signer.js';
import { MillWalletError } from './errors.js';

// ---------------------------------------------------------------------------
// Story 12.9 AC-2 — claim-issuer (pre-sign) chain-recipient validation
// ---------------------------------------------------------------------------
//
// AC-2 requires that `chainRecipient` be validated against `pair.to.chain` at
// THREE boundaries: sender (pre-send), swap-handler (post-unwrap), and
// claim-issuer (pre-sign). The sender and handler already do this; this
// block adds the third boundary as defense-in-depth, guarding against:
//   - future non-EVM signers (Solana, Mina) that may not enforce shape;
//   - direct callers of `MultiChainClaimIssuer.issueClaim()` that bypass the
//     swap-handler (e.g., unit tests, internal Mill integrations);
//   - any downstream regression that silently relaxes handler-side validation.
//
// Rules MUST stay byte-for-byte in sync with
// `validateChainAddress(value, chain, 'address')` in
// `packages/sdk/src/stream-swap.ts` and `validateChainRecipient()` in
// `packages/sdk/src/swap-handler.ts` (guardrail 8.5).

const CLAIM_ISSUER_EVM_ADDRESS_REGEX = /^0x[0-9a-f]{40}$/;
const CLAIM_ISSUER_BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

function validateClaimIssuerChainRecipient(
  value: string,
  chain: string
): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (chain.startsWith('evm:')) {
    return CLAIM_ISSUER_EVM_ADDRESS_REGEX.test(value);
  }
  if (chain.startsWith('solana:')) {
    // Shape-only (regex + length) at the claim-issuer boundary. A full
    // base58-decode check already runs at sender + handler; we deliberately
    // do NOT add a base58 dep to the mill package for this third tier.
    if (!CLAIM_ISSUER_BASE58_REGEX.test(value)) return false;
    return value.length >= 32 && value.length <= 44;
  }
  if (chain.startsWith('mina:')) {
    return CLAIM_ISSUER_BASE58_REGEX.test(value) && value.length >= 32;
  }
  // Unknown chain: permit non-empty; the signer lookup below will surface
  // UNSUPPORTED_CHAIN before any signing actually happens.
  return value.length > 0;
}

export interface MillClaimIssuerLogger {
  debug?: (...a: unknown[]) => void;
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
}

export interface MultiChainClaimIssuerConfig {
  inventory: MillInventory;
  signers: Record<string, PaymentChannelSigner>;
  channelState: MillChannelState;
  logger?: MillClaimIssuerLogger;
  newClaimId?: () => string;
  /**
   * Per-chain on-chain signer addresses. Keyed by target-chain string (e.g.
   * `'evm:base:8453'`). Required for Story 12.6 settlement-context metadata
   * in the FULFILL path so the sender can verify claims against the correct
   * Mill signer address.
   *
   * TODO(12.7): `startMill()` will populate this from the derived wallet.
   * Until then, callers must supply the map explicitly.
   */
  signerAddresses?: Record<string, string>;
}

export class MultiChainClaimIssuer implements ClaimIssuer {
  private readonly inventory: MillInventory;
  private readonly signers: Record<string, PaymentChannelSigner>;
  private readonly channelState: MillChannelState;
  private readonly logger?: MillClaimIssuerLogger;
  private readonly newClaimId: () => string;
  private readonly signerAddresses: Record<string, string>;

  constructor(config: MultiChainClaimIssuerConfig) {
    // Constructor-time config validation uses INVALID_CONFIG so it does not
    // collide with the per-call UNSUPPORTED_CHAIN code (which signals a
    // missing signer for a specific pair at claim time — a runtime routing
    // issue, not a static setup bug).
    if (!config.inventory) {
      throw new MillWalletError(
        'INVALID_CONFIG',
        'MultiChainClaimIssuer requires an inventory'
      );
    }
    if (!config.signers || typeof config.signers !== 'object') {
      throw new MillWalletError(
        'INVALID_CONFIG',
        'MultiChainClaimIssuer requires a signers map'
      );
    }
    if (!config.channelState) {
      throw new MillWalletError(
        'INVALID_CONFIG',
        'MultiChainClaimIssuer requires a channelState'
      );
    }
    this.inventory = config.inventory;
    this.signers = config.signers;
    this.channelState = config.channelState;
    this.logger = config.logger;
    this.signerAddresses = config.signerAddresses ?? {};
    this.newClaimId =
      config.newClaimId ??
      (() => {
        // Node 20+ exposes crypto.randomUUID on globalThis.crypto.
        const c = globalThis.crypto as
          | { randomUUID?: () => string }
          | undefined;
        if (c && typeof c.randomUUID === 'function') {
          return c.randomUUID();
        }
        // Defensive fallback (should not execute on Node 20+).
        return `claim_${Date.now().toString(36)}_${Math.floor(
          Math.random() * 1e9
        ).toString(36)}`;
      });
  }

  async issueClaim(params: IssueClaimParams): Promise<IssueClaimResult> {
    const { pair, senderPubkey, chainRecipient, targetAmount } = params;
    const targetChain = pair.to.chain;
    const targetAsset = pair.to.assetCode;

    // 1. Look up signer by target chain.
    const signer = this.signers[targetChain];
    if (!signer) {
      throw new MillWalletError(
        'UNSUPPORTED_CHAIN',
        `No signer for chain: ${targetChain}`
      );
    }

    // Story 12.9 AC-2 (claim-issuer boundary): validate `chainRecipient`
    // format against `pair.to.chain` BEFORE any inventory debit or channel
    // reservation so a malformed value cannot leak state changes. Third
    // defensive tier; sender + handler already validate. No inventory
    // rollback is needed because this runs before the debit.
    if (
      typeof chainRecipient !== 'string' ||
      !validateClaimIssuerChainRecipient(chainRecipient, targetChain)
    ) {
      throw new MillWalletError(
        'SIGNING_FAILED',
        `chainRecipient is missing or malformed for chain ${targetChain}`
      );
    }

    // 2. Debit inventory SYNCHRONOUSLY (before any await). Throws
    //    MillInventoryError('INSUFFICIENT_INVENTORY') when reserves are
    //    exhausted — Story 12.3's handler maps this to ILP T04.
    this.inventory.debit(targetAsset, targetChain, targetAmount);

    // 3. Reserve channel state SYNCHRONOUSLY. On failure, reverse the debit.
    let reservation: Reservation;
    try {
      reservation = this.channelState.reserve({
        assetCode: targetAsset,
        chain: targetChain,
        senderPubkey,
        cumulativeDelta: targetAmount,
      });
    } catch (err) {
      this.inventory.credit(targetAsset, targetChain, targetAmount);
      throw err;
    }

    // 4. Sign the balance proof. On throw, reverse inventory + channel state.
    let claim: Uint8Array;
    try {
      // Story 12.9 AC-11: the balance-proof `recipient` is the sender's
      // chain-specific payout address (e.g., 20-byte EVM address), NOT the
      // 32-byte Nostr `senderPubkey`. The EVM signer enforces the 20-byte
      // shape; passing `senderPubkey` caused the Story 12.8 schema-drift
      // blocker. `senderPubkey` remains in use below for inventory and
      // channel-state keying — that binding is identity-layer and unchanged.
      claim = await signer.signBalanceProof({
        channelId: reservation.channelId,
        cumulativeAmount: reservation.cumulativeAmount,
        nonce: reservation.nonce,
        recipient: chainRecipient,
      });
    } catch (err) {
      this.inventory.credit(targetAsset, targetChain, targetAmount);
      this.channelState.release({
        assetCode: targetAsset,
        chain: targetChain,
        senderPubkey,
        cumulativeDelta: targetAmount,
      });
      this.logger?.error?.('mill.issueClaim.signing_failed', {
        err,
        chain: targetChain,
        asset: targetAsset,
      });
      throw new MillWalletError(
        'SIGNING_FAILED',
        'Balance-proof signing failed',
        { cause: err }
      );
    }

    const claimId = this.newClaimId();
    this.logger?.debug?.('mill.issueClaim.ok', {
      claimId,
      chain: targetChain,
      asset: targetAsset,
      nonce: reservation.nonce.toString(),
    });

    // Story 12.6: include settlement-context fields when the caller has
    // provided a signer-address map. Absent signer address = legacy caller,
    // metadata stays in the pre-12.6 shape.
    const result: IssueClaimResult = { claim, claimId };
    const swapSignerAddress = this.signerAddresses[targetChain];
    if (swapSignerAddress !== undefined) {
      result.channelId = reservation.channelId;
      result.nonce = reservation.nonce;
      result.cumulativeAmount = reservation.cumulativeAmount;
      // Story 12.9 AC-12: echo the sender-supplied chain-layer payout
      // address, not the Nostr identity key. The sender's AC-7 equality
      // check asserts `metadata.recipient === params.chainRecipient`.
      result.recipient = chainRecipient;
      result.swapSignerAddress = swapSignerAddress;
    }
    return result;
  }
}
