/**
 * `MultiChainClaimIssuer` (Story 12.4 AC-6, AC-8, AC-10; issue #49 window).
 *
 * Implements the `ClaimIssuer` interface from `@toon-protocol/sdk` (type-only
 * import — no runtime cycle), plus the rolling-path reservation entrypoints.
 *
 * Two claim flows share one core (acquire inventory hold → reserve channel
 * state → write-ahead persist (issue #46) → await signer.signBalanceProof →
 * return { claim, claimId }; on signer failure everything is reversed and
 * the reversal re-persisted, best-effort):
 *
 * - {@link issueClaim} — LEGACY gift-wrap path: the inventory hold is a
 *   permanent `debit` (undone by `credit` only on rollback). Byte-for-byte
 *   the pre-#49 behavior.
 * - {@link issueRollingClaim} — rolling coupled-leg path (issue #49): the
 *   inventory hold is a TTL'd in-flight window **reservation**
 *   (`SwapInventory.reserve`). The caller then either
 *   {@link commitRollingClaim}s it (leg-B fulfilled → unsettled liability)
 *   or {@link rollbackRollingClaim}s it (leg-B failed → capacity released,
 *   exactly once). No permanent debit exists on this flow.
 *
 * Issue #46 crash-consistency: when `persistState` is configured, the
 * post-reserve watermark hits durable storage BEFORE the balance proof is
 * signed — so no claim a counterparty can ever hold is AHEAD of the stored
 * watermark. If the write-ahead persist throws, the hold + reservation are
 * rolled back and the claim is refused (`PERSISTENCE_FAILED` → ILP T00).
 * The same write-ahead ordering makes the WINDOW reservation durable before
 * its leg-B advance can be externalized (issue #49). See `state-store.ts`
 * for the full recovery rules.
 */

import type {
  ClaimIssuer,
  IssueClaimParams,
  IssueClaimResult,
} from '@toon-protocol/sdk';
import type { SwapPair } from '@toon-protocol/core';

import type { SwapInventory } from './inventory.js';
import type { SwapChannelState, Reservation } from './channel-state.js';
import type { PaymentChannelSigner } from './payment-channel-signer.js';
import { SwapWalletError } from './errors.js';

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
//     swap-handler (e.g., unit tests, internal swap node integrations);
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
    // do NOT add a base58 dep to the swap node package for this third tier.
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

/**
 * Inventory hold abstraction — how {@link MultiChainClaimIssuer.issueWithHold}
 * stays byte-equal across the legacy (debit/credit) and rolling
 * (reserve/release) flows. `undo()` reverses the hold and must be
 * exception-free.
 */
interface InventoryHold {
  undo(): void;
}

/** {@link MultiChainClaimIssuer.issueRollingClaim} params (issue #49). */
export interface IssueRollingClaimParams extends IssueClaimParams {
  /**
   * Window-reservation lifetime. The rolling engine sizes this to its
   * leg-B expiry budget + grace (spec R7 alignment); defaults to the
   * inventory's `defaultReservationTtlMs`.
   */
  reservationTtlMs?: number;
}

/** {@link MultiChainClaimIssuer.issueRollingClaim} result (issue #49). */
export interface RollingIssueClaimResult extends IssueClaimResult {
  /** Handle for {@link MultiChainClaimIssuer.commitRollingClaim} / {@link MultiChainClaimIssuer.rollbackRollingClaim}. */
  reservationId: string;
}

export interface SwapClaimIssuerLogger {
  debug?: (...a: unknown[]) => void;
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
}

export interface MultiChainClaimIssuerConfig {
  inventory: SwapInventory;
  signers: Record<string, PaymentChannelSigner>;
  channelState: SwapChannelState;
  logger?: SwapClaimIssuerLogger;
  newClaimId?: () => string;
  /**
   * Per-chain on-chain signer addresses. Keyed by target-chain string (e.g.
   * `'evm:base:8453'`). Required for Story 12.6 settlement-context metadata
   * in the FULFILL path so the sender can verify claims against the correct
   * swap node signer address.
   *
   * TODO(12.7): `startSwapNode()` will populate this from the derived wallet.
   * Until then, callers must supply the map explicitly.
   */
  signerAddresses?: Record<string, string>;
  /**
   * Issue #46 — synchronous write-ahead persistence hook, wired by
   * `startSwapNode()` to `SwapStatePersister.persist`. Called (a) after
   * debit+reserve and BEFORE signing, so the stored watermark is always >=
   * any handed-out claim, and (b) best-effort after a signer-failure
   * rollback. When omitted, the issuer behaves exactly as before
   * (in-memory only).
   */
  persistState?: () => void;
}

export class MultiChainClaimIssuer implements ClaimIssuer {
  private readonly inventory: SwapInventory;
  private readonly signers: Record<string, PaymentChannelSigner>;
  private readonly channelState: SwapChannelState;
  private readonly logger?: SwapClaimIssuerLogger;
  private readonly newClaimId: () => string;
  private readonly signerAddresses: Record<string, string>;
  private readonly persistState?: () => void;

  constructor(config: MultiChainClaimIssuerConfig) {
    // Constructor-time config validation uses INVALID_CONFIG so it does not
    // collide with the per-call UNSUPPORTED_CHAIN code (which signals a
    // missing signer for a specific pair at claim time — a runtime routing
    // issue, not a static setup bug).
    if (!config.inventory) {
      throw new SwapWalletError(
        'INVALID_CONFIG',
        'MultiChainClaimIssuer requires an inventory'
      );
    }
    if (!config.signers || typeof config.signers !== 'object') {
      throw new SwapWalletError(
        'INVALID_CONFIG',
        'MultiChainClaimIssuer requires a signers map'
      );
    }
    if (!config.channelState) {
      throw new SwapWalletError(
        'INVALID_CONFIG',
        'MultiChainClaimIssuer requires a channelState'
      );
    }
    this.inventory = config.inventory;
    this.signers = config.signers;
    this.channelState = config.channelState;
    this.logger = config.logger;
    this.signerAddresses = config.signerAddresses ?? {};
    if (config.persistState) this.persistState = config.persistState;
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

  /**
   * LEGACY gift-wrap path: permanent-debit inventory hold. Behavior is
   * byte-for-byte the pre-#49 `issueClaim` (issue #49 keeps the legacy
   * path on debit/credit; only the rolling flow moved to reservations).
   */
  async issueClaim(params: IssueClaimParams): Promise<IssueClaimResult> {
    const { pair, targetAmount } = params;
    const targetAsset = pair.to.assetCode;
    const targetChain = pair.to.chain;
    const { result } = await this.issueWithHold(params, () => {
      // 2. Debit inventory SYNCHRONOUSLY (before any await). Throws
      //    SwapInventoryError('INSUFFICIENT_INVENTORY') when reserves are
      //    exhausted — Story 12.3's handler maps this to ILP T04.
      this.inventory.debit(targetAsset, targetChain, targetAmount);
      return {
        undo: () =>
          this.inventory.credit(targetAsset, targetChain, targetAmount),
      };
    });
    return result;
  }

  /**
   * Rolling coupled-leg path (issue #49): the inventory hold is a TTL'd
   * in-flight window reservation sized to the leg-B amount. The reservation
   * is durable (write-ahead persist) BEFORE the signed claim — and therefore
   * before the leg-B advance — can leave the process. The caller MUST
   * resolve the returned `reservationId` via {@link commitRollingClaim}
   * (leg-B fulfilled) or {@link rollbackRollingClaim} (anything else); an
   * unresolved reservation (process crash) expires at `reservationTtlMs`
   * and frees its window slot (state-store crash rule 6).
   *
   * A window-capacity shortage throws
   * `SwapInventoryError('INSUFFICIENT_INVENTORY')` — same benign T04
   * vocabulary as a legacy reserves shortage.
   */
  async issueRollingClaim(
    params: IssueRollingClaimParams
  ): Promise<RollingIssueClaimResult> {
    const { pair, targetAmount, reservationTtlMs } = params;
    const targetAsset = pair.to.assetCode;
    const targetChain = pair.to.chain;
    let reservationId = '';
    const { result } = await this.issueWithHold(params, () => {
      const reserved = this.inventory.reserve({
        assetCode: targetAsset,
        chain: targetChain,
        amount: targetAmount,
        ...(reservationTtlMs !== undefined && { ttlMs: reservationTtlMs }),
      });
      reservationId = reserved.reservationId;
      return {
        undo: () => {
          this.inventory.releaseReservation(reserved.reservationId);
        },
      };
    });
    return { ...result, reservationId };
  }

  /** Shared issueClaim core — see the class docblock for the two flows. */
  private async issueWithHold(
    params: IssueClaimParams,
    acquireHold: () => InventoryHold
  ): Promise<{ result: IssueClaimResult }> {
    const { pair, senderPubkey, chainRecipient, targetAmount } = params;
    const targetChain = pair.to.chain;
    const targetAsset = pair.to.assetCode;

    // 1. Look up signer by target chain.
    const signer = this.signers[targetChain];
    if (!signer) {
      throw new SwapWalletError(
        'UNSUPPORTED_CHAIN',
        `No signer for chain: ${targetChain}`
      );
    }

    // Story 12.9 AC-2 (claim-issuer boundary): validate `chainRecipient`
    // format against `pair.to.chain` BEFORE any inventory debit or channel
    // reservation so a malformed value cannot leak state changes. Third
    // defensive tier; sender + handler already validate. No inventory
    // rollback is needed because this runs before the hold.
    if (
      typeof chainRecipient !== 'string' ||
      !validateClaimIssuerChainRecipient(chainRecipient, targetChain)
    ) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        `chainRecipient is missing or malformed for chain ${targetChain}`
      );
    }

    // 2. Acquire the inventory hold SYNCHRONOUSLY (before any await):
    //    legacy = permanent debit; rolling = in-flight window reservation.
    const hold = acquireHold();

    // 3. Reserve channel state SYNCHRONOUSLY. On failure, reverse the hold.
    let reservation: Reservation;
    try {
      reservation = this.channelState.reserve({
        assetCode: targetAsset,
        chain: targetChain,
        senderPubkey,
        cumulativeDelta: targetAmount,
      });
    } catch (err) {
      hold.undo();
      throw err;
    }

    // 3b. Issue #46 — WRITE-AHEAD persist. The reservation (nonce +
    //     cumulative watermark + inventory hold) MUST be durable before the
    //     signed claim can leave the process. Synchronous, so no other
    //     issueClaim can interleave between reserve and persist. On failure:
    //     roll back hold + reservation and refuse the claim — handing out a
    //     claim ahead of the stored watermark is the exact desync this
    //     hook exists to prevent.
    if (this.persistState) {
      try {
        this.persistState();
      } catch (err) {
        hold.undo();
        this.channelState.release({
          assetCode: targetAsset,
          chain: targetChain,
          senderPubkey,
          cumulativeDelta: targetAmount,
        });
        this.logger?.error?.('swap.issueClaim.persist_failed', {
          err,
          chain: targetChain,
          asset: targetAsset,
        });
        throw new SwapWalletError(
          'PERSISTENCE_FAILED',
          'Write-ahead persist of channel watermark failed; claim not issued',
          { cause: err }
        );
      }
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
      hold.undo();
      this.channelState.release({
        assetCode: targetAsset,
        chain: targetChain,
        senderPubkey,
        cumulativeDelta: targetAmount,
      });
      // Issue #46 — re-persist the rolled-back state, best-effort. If THIS
      // persist fails (or the process crashes before it runs), disk keeps
      // the pre-rollback snapshot: an over-reservation, which is safe — the
      // next boot's watermark is ahead of (never behind) any handed-out
      // claim. See state-store.ts crash rule 3.
      if (this.persistState) {
        try {
          this.persistState();
        } catch (persistErr) {
          this.logger?.error?.('swap.issueClaim.rollback_persist_failed', {
            err: persistErr,
            chain: targetChain,
            asset: targetAsset,
          });
        }
      }
      this.logger?.error?.('swap.issueClaim.signing_failed', {
        err,
        chain: targetChain,
        asset: targetAsset,
      });
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'Balance-proof signing failed',
        { cause: err }
      );
    }

    const claimId = this.newClaimId();
    this.logger?.debug?.('swap.issueClaim.ok', {
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
    return { result };
  }

  /**
   * Rolling-engine accept (issue #49): the leg-B FULFILL revealed the
   * preimage, so the counterparty holds a redeemable claim — convert the
   * in-flight reservation into unsettled channel liability. Persisted
   * best-effort (the claim is already externalized at this point; a failed
   * persist under-reports liability by at most this packet until the next
   * snapshot — state-store crash rule 6's bounded window).
   *
   * A `'late'` commit (reservation TTL-expired mid-flight) is logged and
   * still recorded: liability follows the revealed claim, not the clock.
   */
  commitRollingClaim(params: {
    reservationId: string;
    pair: SwapPair;
    targetAmount: bigint;
  }): void {
    const targetChain = params.pair.to.chain;
    const targetAsset = params.pair.to.assetCode;
    const status = this.inventory.commitReservation({
      reservationId: params.reservationId,
      assetCode: targetAsset,
      chain: targetChain,
      amount: params.targetAmount,
    });
    if (status === 'late') {
      this.logger?.warn?.('swap.commitRollingClaim.late', {
        reservationId: params.reservationId,
        chain: targetChain,
        asset: targetAsset,
        targetAmount: params.targetAmount.toString(),
        reason:
          'reservation TTL-expired before the leg-B FULFILL; liability recorded anyway (a revealed claim is redeemable regardless of the local clock)',
      });
    }
    if (this.persistState) {
      try {
        this.persistState();
      } catch (persistErr) {
        this.logger?.error?.('swap.commitRollingClaim.persist_failed', {
          err: persistErr,
          chain: targetChain,
          asset: targetAsset,
        });
      }
    }
    this.logger?.debug?.('swap.commitRollingClaim.ok', {
      chain: targetChain,
      asset: targetAsset,
      status,
      targetAmount: params.targetAmount.toString(),
    });
  }

  /**
   * Rolling-engine unwind (swap#47 AC-4, reshaped by issue #49): fully
   * reverse a previously issued rolling claim after the coupled leg-B
   * PREPARE failed (reject / timeout / withheld preimage) — release the
   * window reservation + reverse the channel watermark + best-effort
   * re-persist.
   *
   * Exactly-once: the reservation release is the idempotency gate. If the
   * reservation is already gone (double unwind, or a TTL prune raced the
   * unwind), NOTHING is reversed — in particular the channel watermark is
   * not double-decremented — and the call is a logged no-op.
   *
   * Safety: per rolling-swap §3 R8, a channel claim attached to a PREPARE
   * that terminates in a REJECT MUST NOT advance the redeemable watermark on
   * the receiving side — so reusing the released nonce is protocol-correct.
   * The residual exposure to a Byzantine counterparty that banks the voided
   * claim anyway is the spec's designed per-window bound (§3.1), not a gap
   * introduced here. If the re-persist fails (or the process crashes before
   * it), disk keeps the pre-rollback snapshot — a safe over-reservation
   * (state-store crash rule 3).
   */
  rollbackRollingClaim(params: {
    reservationId: string;
    pair: SwapPair;
    senderPubkey: string;
    targetAmount: bigint;
  }): void {
    const targetChain = params.pair.to.chain;
    const targetAsset = params.pair.to.assetCode;
    const released = this.inventory.releaseReservation(params.reservationId);
    if (!released) {
      this.logger?.warn?.('swap.rollbackRollingClaim.already_released', {
        reservationId: params.reservationId,
        chain: targetChain,
        asset: targetAsset,
      });
      return;
    }
    this.channelState.release({
      assetCode: targetAsset,
      chain: targetChain,
      senderPubkey: params.senderPubkey,
      cumulativeDelta: params.targetAmount,
    });
    if (this.persistState) {
      try {
        this.persistState();
      } catch (persistErr) {
        this.logger?.error?.('swap.rollbackRollingClaim.persist_failed', {
          err: persistErr,
          chain: targetChain,
          asset: targetAsset,
        });
      }
    }
    this.logger?.info?.('swap.rollbackRollingClaim.ok', {
      chain: targetChain,
      asset: targetAsset,
      targetAmount: params.targetAmount.toString(),
    });
  }
}
