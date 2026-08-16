/**
 * swap#136 — turning a swallowed claim-issuance failure into a diagnosable
 * refusal, on both the log side and the wire side.
 *
 * ## The defect
 *
 * The SDK swap handler (`@toon-protocol/sdk`, `createSwapHandler`) wraps its
 * `claimIssuer.issueClaim()` call in a catch that recognises exactly one
 * condition — `INSUFFICIENT_INVENTORY` → `T04 Insufficient liquidity` — and
 * collapses *everything else* into:
 *
 * ```js
 * logger.error({ event: 'swap_handler.issuer_failed', error: message });
 * return ctx.reject('T00', 'Internal error');
 * ```
 *
 * Live on devnet the thrown message was a perfectly actionable
 * `0x0124a370…: 1000 unredeemed` (from `channel-state.ts`'s `reserve()`), and
 * the client saw `{"code":"T00","message":"Internal error"}`. The SDK is a
 * pinned dependency, so this module reclaims both halves on our side:
 *
 *   - **logs** — the issuer wrapper below logs the classified refusal with a
 *     real logger before the SDK ever sees the error;
 *   - **wire** — the handler wrapper rewrites the SDK's generic
 *     `T00 Internal error` into the classified code/message/`data`, using the
 *     refusal captured for *that packet* (an `AsyncLocalStorage` slot, so
 *     concurrent `handlePacket` calls cannot cross-contaminate).
 *
 * ## Code choices
 *
 * Consistent with the refusals already in this repo — `INSUFFICIENT_INVENTORY`
 * → T04/`insufficient_funds` (SDK), `stale_rate` → T99/`stale_rate`
 * (`rate-staleness.ts`), rolling-engine refusals → F-class for "don't retry"
 * and T-class for "retry later" (`rolling-engine.ts`) — and with the semantic
 * reasons the connector's `REJECT_CODE_MAP` actually knows:
 *
 * | reason                 | wire | semantic            | why                                                     |
 * |------------------------|------|---------------------|---------------------------------------------------------|
 * | `channel_unredeemed`   | T04  | `insufficient_funds`| maker's channel capital is locked in an unredeemed claim; the sender fixes it by redeeming → T-class, retryable |
 * | `no_channel_available` | F99  | `application_error` | no channel is provisioned for this sender at all — retrying now cannot help; pick another maker |
 * | `persist_failed`       | T00  | `internal_error`    | genuinely internal and transient (disk), but now says so |
 * | `signing_failed`       | T00  | `internal_error`    | genuinely internal, but now says so                      |
 * | `claim_encrypt_failed` | T00  | `internal_error`    | see the SDK note below                                   |
 *
 * Every refusal also carries base64-JSON `data` whose `reason` field is the
 * authoritative discriminator — the same contract `buildStaleRateReject()`
 * and `buildRollingReject()` already publish.
 *
 * ## Still owed by the SDK
 *
 * `swap_handler.encrypt_failed` (the SDK's *other* `T00 Internal error`)
 * discards its error object entirely — it never reaches a caller-supplied
 * seam, so no wrapper on this side can recover the message. What we can do,
 * and do below, is *identify* it: a T00/`Internal error` from the SDK handler
 * after a claim was issued successfully can only have come from the encrypt
 * branch. We log that and name it on the wire. The real fix — surfacing the
 * error and rejecting with something better than `T00 Internal error` —
 * belongs in `packages/sdk/src/swap-handler.ts` upstream.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { SwapNodeLogger } from './swap-node.js';

// ---------------------------------------------------------------------------
// Refusal contract
// ---------------------------------------------------------------------------

/** `data.reason` discriminators — the client's authoritative marker. */
export const CLAIM_REFUSAL_REASONS = {
  /** Every provisioned channel still carries unredeemed value. */
  CHANNEL_UNREDEEMED: 'channel_unredeemed',
  /** No channel is provisioned for this sender on the target chain. */
  NO_CHANNEL_AVAILABLE: 'no_channel_available',
  /** Write-ahead persist of the channel watermark failed; claim NOT issued. */
  PERSIST_FAILED: 'persist_failed',
  /** Balance-proof signing failed. */
  SIGNING_FAILED: 'signing_failed',
  /** The claim was issued but could not be encrypted to the sender (SDK). */
  CLAIM_ENCRYPT_FAILED: 'claim_encrypt_failed',
  /** Anything else the issuer threw. */
  CLAIM_ISSUE_FAILED: 'claim_issue_failed',
} as const;

export type ClaimRefusalReason =
  (typeof CLAIM_REFUSAL_REASONS)[keyof typeof CLAIM_REFUSAL_REASONS];

export interface ClaimRefusal {
  reason: ClaimRefusalReason;
  /** ILP wire code returned to the client. */
  code: string;
  /** Semantic reason for the connector's `REJECT_CODE_MAP`. */
  semantic: string;
  /** Actionable prose, prefixed with `reason` so message-only surfaces work. */
  message: string;
  /** Extra machine-readable fields folded into the reject `data`. */
  detail: Record<string, unknown>;
  /** Severity for the maker's own log line. */
  level: 'warn' | 'error';
}

interface RefusalShape {
  code: string;
  semantic: string;
  level: 'warn' | 'error';
  /** Prose after the `reason: ` prefix. */
  describe: (detail: Record<string, unknown>) => string;
}

const SHAPES: Record<ClaimRefusalReason, RefusalShape> = {
  [CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED]: {
    code: 'T04',
    semantic: 'insufficient_funds',
    level: 'warn',
    describe: (d) =>
      `the maker's payment channel${d['channelId'] ? ` ${String(d['channelId'])}` : ''} on ${String(d['chain'] ?? 'the target chain')} still has ${String(d['unredeemed'] ?? '?')} unredeemed unit(s); redeem or settle the previous claim before swapping again`,
  },
  [CLAIM_REFUSAL_REASONS.NO_CHANNEL_AVAILABLE]: {
    code: 'F99',
    semantic: 'application_error',
    level: 'warn',
    describe: (d) =>
      `the maker has no payment channel provisioned for this sender on ${String(d['chain'] ?? 'the target chain')}`,
  },
  [CLAIM_REFUSAL_REASONS.PERSIST_FAILED]: {
    code: 'T00',
    semantic: 'internal_error',
    level: 'error',
    describe: () =>
      'the maker could not durably persist the channel watermark, so no claim was issued; retry shortly',
  },
  [CLAIM_REFUSAL_REASONS.SIGNING_FAILED]: {
    code: 'T00',
    semantic: 'internal_error',
    level: 'error',
    describe: (d) =>
      `the maker could not sign the balance proof on ${String(d['chain'] ?? 'the target chain')}`,
  },
  [CLAIM_REFUSAL_REASONS.CLAIM_ENCRYPT_FAILED]: {
    code: 'T00',
    semantic: 'internal_error',
    level: 'error',
    describe: () =>
      'the maker issued the claim but could not encrypt it to the sender key from the gift wrap',
  },
  [CLAIM_REFUSAL_REASONS.CLAIM_ISSUE_FAILED]: {
    code: 'T00',
    semantic: 'internal_error',
    level: 'error',
    describe: (d) =>
      `claim issuance failed${d['err'] ? `: ${String(d['err'])}` : ''}`,
  },
};

function buildRefusal(
  reason: ClaimRefusalReason,
  detail: Record<string, unknown>
): ClaimRefusal {
  const shape = SHAPES[reason];
  return {
    reason,
    code: shape.code,
    semantic: shape.semantic,
    message: `${reason}: ${shape.describe(detail)}`,
    detail,
    level: shape.level,
  };
}

/** Serialize bigints so a refusal survives `JSON.stringify` into reject `data`. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = jsonSafe(v);
    }
    return out;
  }
  return value;
}

/**
 * Classify whatever `MultiChainClaimIssuer.issueClaim()` threw.
 *
 * `INSUFFICIENT_INVENTORY` is deliberately NOT handled here: the SDK already
 * maps it to `T04 Insufficient liquidity` and logs it at warn, so leaving it
 * alone keeps that byte-identical contract for existing senders.
 */
export function classifyClaimIssuerError(err: unknown): ClaimRefusal {
  const code = (err as { code?: string } | undefined)?.code;
  const details = (err as { details?: Record<string, unknown> } | undefined)
    ?.details;
  const message = err instanceof Error ? err.message : String(err);

  if (details?.['reason'] === CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED) {
    const refusals = Array.isArray(details['refusals'])
      ? (details['refusals'] as Record<string, unknown>[])
      : [];
    const first =
      refusals.find((r) => r['reason'] === 'unredeemed') ?? refusals[0];
    return buildRefusal(CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED, {
      chain: details['chain'],
      assetCode: details['assetCode'],
      ...(first?.['channelId'] !== undefined && {
        channelId: first['channelId'],
      }),
      ...(first?.['unredeemed'] !== undefined && {
        unredeemed: String(first['unredeemed']),
      }),
      refusals: jsonSafe(refusals),
    });
  }
  if (details?.['reason'] === CLAIM_REFUSAL_REASONS.NO_CHANNEL_AVAILABLE) {
    return buildRefusal(CLAIM_REFUSAL_REASONS.NO_CHANNEL_AVAILABLE, {
      chain: details['chain'],
      assetCode: details['assetCode'],
    });
  }
  if (code === 'PERSISTENCE_FAILED') {
    return buildRefusal(CLAIM_REFUSAL_REASONS.PERSIST_FAILED, { err: message });
  }
  if (code === 'SIGNING_FAILED') {
    return buildRefusal(CLAIM_REFUSAL_REASONS.SIGNING_FAILED, {
      err: message,
    });
  }
  return buildRefusal(CLAIM_REFUSAL_REASONS.CLAIM_ISSUE_FAILED, {
    ...(code !== undefined && { code }),
    err: message,
  });
}

/** The SDK's generic swallow-everything reject, verbatim. */
const SDK_GENERIC_REJECT_MESSAGE = 'Internal error';
const SDK_GENERIC_REJECT_CODE = 'T00';

/** Reject-response shape the connector's PaymentHandlerAdapter consumes. */
export interface ClaimRefusalReject {
  accept: false;
  code: string;
  message: string;
  data: string;
  rejectReason: { code: string; message: string };
}

/** Build the wire reject for a classified refusal. */
export function buildClaimRefusalReject(
  refusal: ClaimRefusal
): ClaimRefusalReject {
  return {
    accept: false,
    code: refusal.code,
    message: refusal.message,
    data: Buffer.from(
      JSON.stringify({
        reason: refusal.reason,
        ...(jsonSafe(refusal.detail) as Record<string, unknown>),
      }),
      'utf8'
    ).toString('base64'),
    rejectReason: { code: refusal.semantic, message: refusal.message },
  };
}

// ---------------------------------------------------------------------------
// Per-packet capture + the two wrappers
// ---------------------------------------------------------------------------

interface CaptureSlot {
  refusal?: ClaimRefusal;
  issued: boolean;
}

/** Minimal structural view of the SDK's `ClaimIssuer` (avoids a value import). */
export interface IssueClaimLike<P, R> {
  issueClaim(params: P): Promise<R>;
}

export interface ClaimRefusalDiagnostics {
  /**
   * Wrap the claim issuer handed to `createSwapHandler`. Logs the classified
   * refusal and records it for the in-flight packet, then rethrows unchanged
   * so the SDK's own `INSUFFICIENT_INVENTORY` handling is untouched.
   */
  instrument<P, R>(issuer: IssueClaimLike<P, R>): IssueClaimLike<P, R>;
  /**
   * Wrap the SDK handler so its generic `T00 Internal error` is replaced by
   * the refusal captured for that same packet.
   */
  wrap<C, T>(handler: (ctx: C) => Promise<T>): (ctx: C) => Promise<T>;
}

export function createClaimRefusalDiagnostics(options: {
  logger?: SwapNodeLogger;
}): ClaimRefusalDiagnostics {
  const store = new AsyncLocalStorage<CaptureSlot>();
  const logger = options.logger;

  return {
    instrument<P, R>(issuer: IssueClaimLike<P, R>): IssueClaimLike<P, R> {
      return {
        issueClaim: async (params: P): Promise<R> => {
          try {
            const result = await issuer.issueClaim(params);
            const slot = store.getStore();
            if (slot) slot.issued = true;
            return result;
          } catch (err) {
            // Leave the SDK's own liquidity contract alone.
            if (
              (err as { code?: string } | undefined)?.code !==
              'INSUFFICIENT_INVENTORY'
            ) {
              const refusal = classifyClaimIssuerError(err);
              const slot = store.getStore();
              if (slot) slot.refusal = refusal;
              logger?.[refusal.level]?.('swap.claim.refused', {
                reason: refusal.reason,
                ilpCode: refusal.code,
                clientMessage: refusal.message,
                ...(jsonSafe(refusal.detail) as Record<string, unknown>),
              });
            }
            throw err;
          }
        },
      };
    },

    wrap<C, T>(handler: (ctx: C) => Promise<T>): (ctx: C) => Promise<T> {
      return async (ctx: C): Promise<T> => {
        const slot: CaptureSlot = { issued: false };
        const result = await store.run(slot, () => handler(ctx));
        const r = result as unknown as {
          accept?: boolean;
          code?: string;
          message?: string;
        };
        if (
          r?.accept !== false ||
          r.code !== SDK_GENERIC_REJECT_CODE ||
          r.message !== SDK_GENERIC_REJECT_MESSAGE
        ) {
          return result;
        }
        if (slot.refusal) {
          return buildClaimRefusalReject(slot.refusal) as unknown as T;
        }
        if (slot.issued) {
          // Nothing threw out of `issueClaim` and the claim was produced, so
          // the SDK's only remaining `T00 Internal error` branch is
          // `swap_handler.encrypt_failed` — whose error object the SDK
          // discards, hence the inference. See this file's header.
          const refusal = buildRefusal(
            CLAIM_REFUSAL_REASONS.CLAIM_ENCRYPT_FAILED,
            {}
          );
          logger?.error?.('swap.claim.refused', {
            reason: refusal.reason,
            ilpCode: refusal.code,
            clientMessage: refusal.message,
            note: 'inferred from the SDK handler response; the SDK discards the underlying encrypt error',
          });
          return buildClaimRefusalReject(refusal) as unknown as T;
        }
        return result;
      };
    },
  };
}
