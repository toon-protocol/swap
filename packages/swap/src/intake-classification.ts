/**
 * Per-protocol-class accounting for what the maker's dispatch seam ADMITS
 * (issue #152 — Stage 0 of the legacy-swap-removal plan, ADR 0003).
 *
 * ## Why this exists
 *
 * ADR 0003 removes the legacy claim-in-FULFILL swap path, and every removal
 * stage gates on an exit criterion of the form *"no legacy traffic observed
 * for N consecutive days"*. That sentence was **not measurable**. swap#137
 * gave the maker a real logger, but everything it emits is a **refusal** —
 * `swap.claim.refused`, `swap.channelState.reserve_refused`,
 * `swap.packet.dispatch_failed`. Nothing on the success path ever said WHICH
 * protocol served a swap, so a maker serving legacy all day and a maker
 * serving none looked identical in `docker logs`.
 *
 * This module supplies the missing reading, and **only** the reading: it
 * changes no routing decision and no packet outcome. The classification it
 * publishes already existed implicitly in `handlePacket`'s branch structure
 * (`swap-node.ts`, the issue #47 dispatch matrix); all that was missing was a
 * name for the branch and somewhere to put it.
 *
 * ## The four classes
 *
 * | class          | what arrived                                                      |
 * | -------------- | ----------------------------------------------------------------- |
 * | `legacy`       | zero-condition gift wrap that reached the legacy fall-through      |
 * | `rolling-rfq`  | zero-condition gift wrap whose inner rumor is kind:20033           |
 * | `rolling-fill` | a coupled fill under a real 32-byte sender-chosen condition        |
 * | `refused`      | the dispatch table itself rejected the shape, before any handler   |
 *
 * `legacy` and `rolling-rfq` differ **only** by the inner rumor kind of an
 * otherwise byte-identical envelope (20032 vs 20033), which is exactly why
 * the class has to be recorded at the seam: nothing downstream can still tell
 * them apart. The recorded `innerKind` carries the discriminator verbatim.
 *
 * A class is the **row of the dispatch table the packet landed on**, not its
 * eventual outcome. A rolling fill the engine later rejects is still
 * `rolling-fill`; `accepted:false` and the reject `code` say what happened to
 * it. `refused` is reserved for the seam's own pre-dispatch rejects, whose
 * `reason` discriminator is the one that was already on the wire.
 *
 * ## Two readings, deliberately
 *
 * 1. **A log line per arrival** — one `swap.intake` JSON record at `info`,
 *    through the swap#137 console logger. This is the durable reading: it
 *    survives a Watchtower recreate because it is in the container's log
 *    stream, and it is what a windowed count is taken over:
 *
 *    ```
 *    docker logs --since 24h swap-node \
 *      | grep '"event":"swap.intake"' | grep -c '"class":"legacy"'
 *    ```
 *
 * 2. **`GET /admin/intake`** — the same counts without shell-parsing, on the
 *    swap#138 operator surface (see `admin-surface.ts`). These counters are
 *    **in-process**: the box recreates the maker on every `:release` move and
 *    the totals start again from zero. That is why the report always carries
 *    `since` and `windowSec` — a reset is then *visible* rather than silent,
 *    which is the property issue #152 actually requires. For a multi-day gate
 *    reading, count log lines; the HTTP surface answers "what has this
 *    process seen".
 *
 * ## What is never recorded
 *
 * The gift wrap is sealed and stays sealed. Only routing metadata is emitted:
 * the arrival peer / source ILP address, the requested pair, the inner rumor
 * kind, the sender's Nostr pubkey, and the packet's own (already-plaintext)
 * amount and destination. No rumor content, no `chainRecipient`, no claim, no
 * key material. Free-form strings that originate with a counterparty are
 * length-capped before they are recorded, so a hostile sender cannot flood
 * the log line or the peer table.
 *
 * ## No new config key
 *
 * Nothing here is configurable. swap#134 crash-looped the live maker by
 * adding a required config key, and `:release` auto-deploys on green main —
 * so this stage adds none, optional or otherwise. Verbosity is the existing
 * optional `SWAP_LOG_LEVEL` env var and nothing else.
 */

/** `event` field of the intake log record. Grep target for the gate reading. */
export const SWAP_INTAKE_EVENT = 'swap.intake';

/** The dispatch-table row a packet landed on. */
export type SwapIntakeClass =
  | 'legacy'
  | 'rolling-rfq'
  | 'rolling-fill'
  | 'refused';

/** Every class, in report order. */
export const SWAP_INTAKE_CLASSES: readonly SwapIntakeClass[] = [
  'legacy',
  'rolling-rfq',
  'rolling-fill',
  'refused',
];

/**
 * Reason recorded for an arrival that was classified but never reached a
 * class-specific branch — defensive only; every seam path classifies.
 */
export const UNCLASSIFIED_REASON = 'unclassified_arrival';

/** Cap on any counterparty-supplied string that reaches a log line. */
const MAX_FIELD_CHARS = 96;

/** Cap on distinct peers tracked per class, so the table cannot grow unbounded. */
const DEFAULT_MAX_TRACKED_PEERS = 50;

/** Cap on distinct refusal reasons tracked (they are ours, so this is slack). */
const MAX_TRACKED_REASONS = 32;

function clip(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= MAX_FIELD_CHARS
    ? value
    : value.slice(0, MAX_FIELD_CHARS) + '…';
}

/** An asset as it appears on either side of a requested pair. */
export interface IntakePairSide {
  assetCode: string;
  chain: string;
}

/**
 * Render a requested pair as the single `from>to` token both the log line and
 * the report use — e.g. `USDC:evm:84532>USDC:solana:devnet`.
 */
export function formatIntakePair(pair: {
  from: IntakePairSide;
  to: IntakePairSide;
}): string {
  return `${pair.from.assetCode}:${pair.from.chain}>${pair.to.assetCode}:${pair.to.chain}`;
}

/**
 * Recover the requested pair from a rumor's `swap-from` / `swap-to` tags.
 *
 * Both the legacy kind:20032 rumor (`buildSwapRumor`, `@toon-protocol/sdk`)
 * and any future shape that adopts the same tags are covered; the values are
 * already `assetCode:chain`, so this is a tag read and not a payload parse.
 * Returns `undefined` when either tag is missing, which is how a non-swap
 * rumor that happens to land on the seam is reported.
 */
export function intakePairFromTags(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  let from: string | undefined;
  let to: string | undefined;
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    const [name, value] = tag as unknown[];
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    if (name === 'swap-from' && from === undefined) from = value;
    else if (name === 'swap-to' && to === undefined) to = value;
  }
  if (from === undefined || to === undefined) return undefined;
  return `${clip(from) ?? ''}>${clip(to) ?? ''}`;
}

/** What `handlePacket` knows about an arrival before it classifies it. */
export interface SwapIntakeOrigin {
  /** Packet amount, source-asset micro-units (already plaintext on the wire). */
  amount?: string;
  /** ILP destination the PREPARE named. */
  destination?: string;
  /** Sender's ILP address, when the connector reports one. */
  sourceAccount?: string;
  /** Peer id the BTP session authenticated under, when the connector has it. */
  sourcePeer?: string;
}

/** Everything a branch can add once it knows which row it is on. */
export interface SwapIntakeDetails {
  /** Refusal discriminator, for `refused` (and for a rejected class outcome). */
  reason?: string;
  /** `from>to`, when the requested pair could be read. */
  pair?: string;
  /** Gift-wrap sender pubkey, when the wrap opened. */
  senderPubkey?: string;
  /** Sender's own advertised ILP address (rolling RFQ carries one). */
  senderIlpAddress?: string;
  /**
   * Inner rumor kind — the ONLY thing separating legacy (20032) from a
   * rolling RFQ (20033). `null` when the wrap could not be opened.
   */
  innerKind?: number | null;
}

/** Handle for one arrival. `finish` is idempotent and records exactly once. */
export interface SwapIntakeArrival {
  /** Name the dispatch row. Last call wins; a later refinement may add detail. */
  classify(cls: SwapIntakeClass, details?: SwapIntakeDetails): void;
  /** Add detail without changing the class (used by the RFQ sniff). */
  note(details: SwapIntakeDetails): void;
  /** Emit the single record for this arrival. Safe to call more than once. */
  finish(response?: { accept?: boolean; code?: string }): void;
}

export interface SwapIntakeClassCounts {
  total: number;
  accepted: number;
  rejected: number;
  /** ISO timestamp of the most recent arrival of this class, or `null`. */
  lastAt: string | null;
}

export interface SwapIntakePeerCount {
  peer: string;
  count: number;
  lastAt: string;
}

export interface SwapIntakeReport {
  generatedAt: string;
  /** Process start — the counters cover `[since, generatedAt]` and no longer. */
  since: string;
  windowSec: number;
  total: number;
  classes: Record<SwapIntakeClass, SwapIntakeClassCounts>;
  /** Non-zero refusal/reject discriminators only. */
  reasons: Record<string, number>;
  /** Who is still on the legacy path — the whole point of the stage. */
  legacyPeers: SwapIntakePeerCount[];
  /** `true` when the peer table hit its cap and stopped admitting new keys. */
  legacyPeersTruncated: boolean;
  /** Says plainly that these totals are in-process. */
  note: string;
}

const REPORT_NOTE =
  'counts are in-process and restart at zero when the container is recreated (Watchtower moves :release); ' +
  '`since` is this process’s start. For a multi-day gate reading count the `swap.intake` log lines instead: ' +
  'docker logs --since 24h <container> | grep \'"event":"swap.intake"\' | grep -c \'"class":"legacy"\'';

export interface SwapIntakeMeterOptions {
  /**
   * Where the per-arrival record goes. `info`, so the swap#137 default level
   * shows it without any env change. Absent ⇒ counters only.
   */
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
  /** Distinct legacy peers tracked before the table stops growing. */
  maxTrackedPeers?: number;
}

export interface SwapIntakeMeter {
  /** Open an arrival. Always pair with exactly one `finish()`. */
  begin(origin?: SwapIntakeOrigin): SwapIntakeArrival;
  /** Snapshot for `GET /admin/intake`. */
  report(): SwapIntakeReport;
}

function emptyCounts(): SwapIntakeClassCounts {
  return { total: 0, accepted: 0, rejected: 0, lastAt: null };
}

/**
 * Build the meter the swap node's dispatch seam records through.
 *
 * Nothing in here can fail a packet: `finish()` swallows every error from the
 * logger, exactly as `logger.ts` does, because an accounting record must
 * never be able to change a swap's outcome.
 */
export function createSwapIntakeMeter(
  options: SwapIntakeMeterOptions = {}
): SwapIntakeMeter {
  const now = options.now ?? Date.now;
  const maxPeers = options.maxTrackedPeers ?? DEFAULT_MAX_TRACKED_PEERS;
  const startedAt = now();

  const classes: Record<SwapIntakeClass, SwapIntakeClassCounts> = {
    legacy: emptyCounts(),
    'rolling-rfq': emptyCounts(),
    'rolling-fill': emptyCounts(),
    refused: emptyCounts(),
  };
  const reasons = new Map<string, number>();
  const legacyPeers = new Map<string, { count: number; lastAt: number }>();
  let legacyPeersTruncated = false;
  let total = 0;

  const bump = (
    cls: SwapIntakeClass,
    accepted: boolean,
    at: number,
    peer: string | undefined,
    reason: string | undefined
  ): void => {
    const counts = classes[cls];
    counts.total += 1;
    if (accepted) counts.accepted += 1;
    else counts.rejected += 1;
    counts.lastAt = new Date(at).toISOString();
    total += 1;

    if (reason !== undefined) {
      const prior = reasons.get(reason);
      if (prior !== undefined) reasons.set(reason, prior + 1);
      else if (reasons.size < MAX_TRACKED_REASONS) reasons.set(reason, 1);
    }

    if (cls === 'legacy' && peer !== undefined) {
      const entry = legacyPeers.get(peer);
      if (entry) {
        entry.count += 1;
        entry.lastAt = at;
      } else if (legacyPeers.size < maxPeers) {
        legacyPeers.set(peer, { count: 1, lastAt: at });
      } else {
        legacyPeersTruncated = true;
      }
    }
  };

  return {
    begin(origin: SwapIntakeOrigin = {}): SwapIntakeArrival {
      let cls: SwapIntakeClass | undefined;
      const details: SwapIntakeDetails = {};
      let done = false;

      const merge = (extra?: SwapIntakeDetails): void => {
        if (!extra) return;
        if (extra.reason !== undefined) details.reason = extra.reason;
        if (extra.pair !== undefined) details.pair = extra.pair;
        if (extra.senderPubkey !== undefined)
          details.senderPubkey = extra.senderPubkey;
        if (extra.senderIlpAddress !== undefined)
          details.senderIlpAddress = extra.senderIlpAddress;
        if (extra.innerKind !== undefined) details.innerKind = extra.innerKind;
      };

      return {
        classify(next: SwapIntakeClass, extra?: SwapIntakeDetails): void {
          cls = next;
          merge(extra);
        },
        note(extra: SwapIntakeDetails): void {
          merge(extra);
        },
        finish(response?: { accept?: boolean; code?: string }): void {
          if (done) return;
          done = true;
          const at = now();
          const resolved: SwapIntakeClass = cls ?? 'refused';
          if (cls === undefined && details.reason === undefined) {
            details.reason = UNCLASSIFIED_REASON;
          }
          const accepted = response?.accept === true;
          // A peer id is the connector's authenticated arrival identity; the
          // source ILP address is what the sender claims. Prefer the former.
          const peer = clip(origin.sourcePeer) ?? clip(origin.sourceAccount);
          bump(resolved, accepted, at, peer, details.reason);

          const info = options.logger?.info;
          if (!info) return;
          try {
            info(SWAP_INTAKE_EVENT, {
              class: resolved,
              accepted,
              ...(response?.code !== undefined ? { code: response.code } : {}),
              ...(details.reason !== undefined
                ? { reason: details.reason }
                : {}),
              peer: peer ?? null,
              ...(clip(origin.sourceAccount) !== undefined
                ? { sourceAccount: clip(origin.sourceAccount) }
                : {}),
              ...(details.senderIlpAddress !== undefined
                ? { senderIlpAddress: clip(details.senderIlpAddress) }
                : {}),
              ...(details.senderPubkey !== undefined
                ? { senderPubkey: clip(details.senderPubkey) }
                : {}),
              ...(details.innerKind !== undefined
                ? { innerKind: details.innerKind }
                : {}),
              pair: details.pair ?? null,
              ...(origin.amount !== undefined ? { amount: origin.amount } : {}),
              ...(origin.destination !== undefined
                ? { destination: clip(origin.destination) }
                : {}),
            });
          } catch {
            // Accounting must never take a packet — or the node — down.
          }
        },
      };
    },

    report(): SwapIntakeReport {
      const at = now();
      const peers: SwapIntakePeerCount[] = [...legacyPeers.entries()]
        .map(([peer, v]) => ({
          peer,
          count: v.count,
          lastAt: new Date(v.lastAt).toISOString(),
        }))
        .sort((a, b) => b.count - a.count || a.peer.localeCompare(b.peer));
      return {
        generatedAt: new Date(at).toISOString(),
        since: new Date(startedAt).toISOString(),
        windowSec: Math.max(0, Math.floor((at - startedAt) / 1000)),
        total,
        classes: {
          legacy: { ...classes.legacy },
          'rolling-rfq': { ...classes['rolling-rfq'] },
          'rolling-fill': { ...classes['rolling-fill'] },
          refused: { ...classes.refused },
        },
        reasons: Object.fromEntries(reasons),
        legacyPeers: peers,
        legacyPeersTruncated,
        note: REPORT_NOTE,
      };
    },
  };
}
