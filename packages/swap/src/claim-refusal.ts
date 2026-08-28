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
 * the client saw `{"code":"T00","message":"Internal error"}`.
 *
 * ## The seam (`@toon-protocol/sdk@3.2.0`, toon#205)
 *
 * The SDK now offers `CreateSwapHandlerConfig.onFailure`: a synchronous
 * classifier called *before* the handler rejects on any thrown failure, handed
 * the thrown value verbatim, the packet context, and the `defaultRejection` it
 * would otherwise emit. Returning a `SwapHandlerRejection` replaces the wire
 * code/message and may attach `data` and `rejectReason`.
 *
 * `createClaimRefusalMapper()` below is that classifier, and it does both
 * halves in one place — it logs the classified refusal AND returns the reject
 * that goes on the wire. It replaced (swap#146) the pre-3.2.0 workaround: an
 * `AsyncLocalStorage` slot plus a pair of wrappers that instrumented the claim
 * issuer to capture the throw and then sniffed the handler's response for the
 * literal `T00`/`Internal error` to know when to rewrite it.
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
 * | `claim_encrypt_failed` | T00  | `internal_error`    | the SDK's `encrypt` stage — see below                    |
 *
 * Every refusal also carries base64-JSON `data` whose `reason` field is the
 * authoritative discriminator — the same contract `buildStaleRateReject()`
 * and `buildRollingReject()` already publish.
 *
 * ## The encrypt stage is now observed, not inferred
 *
 * `swap_handler.encrypt_failed` is the SDK's *other* `T00 Internal error`, and
 * pre-3.2.0 it discarded its error object entirely. swap#137 could only
 * *infer* it: a blanket `T00 Internal error` from the handler after a claim
 * was issued successfully can have come from nowhere else. That inference is
 * gone. The SDK now hands us `stage: 'encrypt'` with `context.claimIssued:
 * true`, `context.claimId`, and the thrown value itself, so the refusal names
 * the real failure instead of deducing its existence.
 */

import type {
  SwapHandlerFailure,
  SwapHandlerRejection,
} from '@toon-protocol/sdk';

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
    describe: (d) =>
      `the maker issued the claim but could not encrypt it to the sender key from the gift wrap${d['err'] ? `: ${String(d['err'])}` : ''}`,
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
 * Classify whatever `MultiChainClaimIssuer.issueRollingClaim()` threw.
 *
 * `INSUFFICIENT_INVENTORY` is deliberately NOT handled here: callers (the
 * rolling engine; historically the SDK's `createSwapHandler`) already map it
 * to `T04 Insufficient liquidity` and log it at warn, so leaving it
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
// The SDK seam
// ---------------------------------------------------------------------------

/** The SDK's opaque catch-all default — the only reject we take over. */
const SDK_GENERIC_REJECT_CODE = 'T00';

/**
 * Build the `CreateSwapHandlerConfig.onFailure` classifier (SDK ≥ 3.2.0).
 *
 * Synchronous by contract — it runs on the reject path of a live packet — and
 * total: any stage it cannot improve on returns `undefined`, leaving the SDK's
 * own `defaultRejection` exactly as it was.
 *
 * What it claims, and what it deliberately does not:
 *
 * - **`issuer`** — classifies whatever `issueClaim()` threw, and logs it.
 *   `INSUFFICIENT_INVENTORY` is left entirely to the SDK (it already maps to
 *   `T04 Insufficient liquidity` and logs at warn), and so is any other
 *   already-classified failure — signalled by `defaultRejection.code !== 'T00'`
 *   — so that contract stays byte-identical for existing senders.
 * - **`encrypt`** — `claimIssued` is `true` here by construction: the claim
 *   exists and is now stranded. The thrown value comes with it, so the refusal
 *   names the real encryption failure.
 * - **`rate_provider` / `rate_conversion`** — untouched. Rate freshness is
 *   already refused upstream by `RateFreshnessGuard` (`rate-staleness.ts`)
 *   with its own `T99 stale_rate` contract, and the SDK's own defaults for
 *   these two stages already carry a specific message.
 */
export function createClaimRefusalMapper(options: {
  logger?: SwapNodeLogger;
}): (failure: SwapHandlerFailure) => SwapHandlerRejection | undefined {
  const logger = options.logger;

  const report = (refusal: ClaimRefusal, stage: string): void => {
    logger?.[refusal.level]?.('swap.claim.refused', {
      reason: refusal.reason,
      ilpCode: refusal.code,
      clientMessage: refusal.message,
      stage,
      ...(jsonSafe(refusal.detail) as Record<string, unknown>),
    });
  };

  const toRejection = (refusal: ClaimRefusal): SwapHandlerRejection => {
    const { code, message, data, rejectReason } =
      buildClaimRefusalReject(refusal);
    return { code, message, data, rejectReason };
  };

  return (failure: SwapHandlerFailure): SwapHandlerRejection | undefined => {
    if (failure.stage === 'issuer') {
      // The SDK owns the liquidity contract end to end.
      if (failure.code === 'INSUFFICIENT_INVENTORY') return undefined;
      const refusal = classifyClaimIssuerError(failure.error);
      report(refusal, failure.stage);
      // Anything the SDK already classified (its `/insufficient/i` message
      // fallback also lands on T04) keeps its own reject; we only take over
      // the opaque `T00 Internal error`.
      if (failure.defaultRejection.code !== SDK_GENERIC_REJECT_CODE) {
        return undefined;
      }
      return toRejection(refusal);
    }

    if (failure.stage === 'encrypt') {
      const refusal = buildRefusal(CLAIM_REFUSAL_REASONS.CLAIM_ENCRYPT_FAILED, {
        err: failure.message,
        ...(failure.code !== undefined && { code: failure.code }),
        ...(failure.context.claimId !== undefined && {
          claimId: failure.context.claimId,
        }),
      });
      report(refusal, failure.stage);
      return toRejection(refusal);
    }

    return undefined;
  };
}
