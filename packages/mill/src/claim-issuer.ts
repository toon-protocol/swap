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
    const { pair, senderPubkey, targetAmount } = params;
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
      claim = await signer.signBalanceProof({
        channelId: reservation.channelId,
        cumulativeAmount: reservation.cumulativeAmount,
        nonce: reservation.nonce,
        recipient: senderPubkey,
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
    const millSignerAddress = this.signerAddresses[targetChain];
    if (millSignerAddress !== undefined) {
      result.channelId = reservation.channelId;
      result.nonce = reservation.nonce;
      result.cumulativeAmount = reservation.cumulativeAmount;
      result.recipient = senderPubkey;
      result.millSignerAddress = millSignerAddress;
    }
    return result;
  }
}
