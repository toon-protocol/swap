/**
 * The maker's intake classification event (swap#152, ADR 0003's removal gate,
 * toon-meta#411 Stage 0).
 *
 * ADR 0003 gates removing the legacy intake on "no legacy traffic observed for
 * N consecutive days" — a sentence that is only measurable if every arrival at
 * the dispatch seam says which protocol served it. One `swap.intake.arrival`
 * line per arrival makes that a reading rather than a guess.
 *
 * Two modules classify, so the shape lives here rather than being spelled out
 * twice and drifting: `swap-node.ts` emits `legacy` / `rolling-fill` /
 * `refused` from the dispatch branches themselves, and `rolling-rfq.ts` emits
 * `rolling-rfq` from inside `handle()` — the only site that has already paid
 * for the gift-wrap unwrap that identifies the class.
 */

/** Log message every intake classification is emitted under. */
export const SWAP_INTAKE_EVENT = 'swap.intake.arrival';

/**
 * Which dispatch branch took the arrival:
 * - `legacy` — zero-condition gift wrap handed to the SDK swap handler;
 * - `rolling-rfq` — inner rumor kind:20033;
 * - `rolling-fill` — a coupled fill under a sender-chosen condition;
 * - `refused` — rejected before dispatch, carrying the reject reason.
 *
 * Canonical list (issue #171's intake ledger validates/reports against this
 * rather than a second, driftable copy of the four literals).
 */
export const SWAP_INTAKE_CLASSES = [
  'legacy',
  'rolling-rfq',
  'rolling-fill',
  'refused',
] as const;

export type SwapIntakeClass = (typeof SWAP_INTAKE_CLASSES)[number];

/** Minimal pair shape — satisfied by both `SwapPair` and an RFQ's requested pair. */
interface PairLike {
  from: { assetCode: string; chain: string };
  to: { assetCode: string; chain: string };
}

/**
 * `USDC:evm:8453→USDC:evm:8453` — the `pair` field of an intake event.
 *
 * `undefined` when the pair is not knowable at the point of classification
 * (an unreadable payload, or a fill whose session has already expired); the
 * JSON-line logger drops the key rather than printing a null.
 */
export function formatPairLabel(
  pair: PairLike | null | undefined
): string | undefined {
  if (!pair) return undefined;
  return `${pair.from.assetCode}:${pair.from.chain}→${pair.to.assetCode}:${pair.to.chain}`;
}
