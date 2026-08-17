/**
 * Rolling-swap RFQ intake (rolling-swap spec §2.2, §10.3 step 2).
 *
 * ## Why this module exists
 *
 * Before it, the rolling protocol shipped in the released maker image but was
 * **unreachable on the wire**. `RollingSwapEngine.handleFill` rejects any fill
 * whose `streamNonce` is not in the {@link RollingSessionStore} (F06
 * `unknown_session`, `rolling-engine.ts`), and the only way to put a session in
 * that store was `SwapNodeInstance.registerRollingSession` — an in-process
 * method that `cli.ts` (what the container actually runs) never calls. So the
 * deployed maker could never have a session, and every real swap fell through
 * to the legacy SDK gift-wrap handler.
 *
 * This module is the missing transport: the **RFQ round trip** that mints a
 * session from an inbound packet.
 *
 * ## The wire contract
 *
 * Per spec §2.2 the RFQ request is a *paid ILP write carrying a NIP-59 gift
 * wrap*: `rumor kind:20033 → seal → kind:1059`, addressed to the maker's
 * kind:10032 pubkey. It therefore arrives on the **same** local-delivery packet
 * seam as a legacy swap request — zero/absent `executionCondition`, TOON-encoded
 * gift wrap in `data` — and is distinguished only by its INNER rumor kind. The
 * response (`rumor kind:20034`) is gift-wrapped back to the sender pubkey
 * recovered from the request's seal layer and returned synchronously as the
 * PREPARE's FULFILL `data` (base64 JSON of the kind:1059 wrap).
 *
 * The hot path is unaffected: fills stay plain, unwrapped ILP packets under the
 * shared condition (spec §2.2, "This keeps the hot path off Nostr").
 *
 * ## Capability discovery
 *
 * There is deliberately **no `rollingCapable` announce flag**. Spec §10.3 step 2
 * defines discovery as probe-by-RFQ: "A maker without it is legacy; `toon_swap`
 * keeps the legacy path until the RFQ succeeds." A maker that does not implement
 * this module answers a kind:20033 with a legacy-handler reject, which is
 * exactly the negative signal the sender needs. Advertising a flag would add a
 * second, unspecified source of truth that no client reads.
 *
 * swap#154 (toon-meta#411 Stage 5) retired the "legacy-handler reject" half of
 * that sentence for THIS maker: `handle()` is now terminal for every arrival
 * on this seam, and a kind:20032 request gets `LEGACY_PROTOCOL_REFUSED`
 * rather than a dispatch to a legacy handler that no longer exists.
 */

import type { SwapPair } from '@toon-protocol/core';
import type { NostrEvent, UnsignedEvent } from 'nostr-tools';
import {
  unwrapSwapPacketFromToon,
  wrapSwapPacket,
  findSwapPair,
} from '@toon-protocol/sdk';

import {
  ROLLING_PROTOCOL,
  buildRollingReject,
  type RollingSession,
} from './rolling-engine.js';
import type { LegBReturnPath } from './leg-b-return-path.js';
import { SWAP_INTAKE_EVENT, formatPairLabel } from './intake-event.js';
import type { SwapIntakeClass } from './intake-event.js';

/** Inner rumor kind of an RFQ request (spec §2.2). */
export const ROLLING_RFQ_REQUEST_KIND = 20033;
/** Inner rumor kind of an RFQ response (spec §2.2). */
export const ROLLING_RFQ_RESPONSE_KIND = 20034;

/** `streamNonce` — 16 bytes, lowercase hex (spec §2.1). */
const STREAM_NONCE_REGEX = /^[0-9a-f]{32}$/;

/** Default lifetime of a quote/session minted by an RFQ, when unconfigured. */
export const DEFAULT_RFQ_QUOTE_TTL_MS = 60_000;

/** `data.reason` discriminators emitted by RFQ rejects. */
export const ROLLING_RFQ_REJECT_REASONS = {
  /** Rumor is kind:20033 but its content violates the request shape. */
  MALFORMED_RFQ: 'malformed_rfq',
  /** The requested pair is not one this maker advertises. */
  UNSUPPORTED_PAIR: 'unsupported_pair',
  /** No rate available for the pair (feed down / stale beyond the bound). */
  RATE_UNAVAILABLE: 'rate_unavailable',
  /** Session store full, or the nonce collided with a live session. */
  SESSION_REJECTED: 'session_rejected',
  /**
   * The maker has no way to deliver leg B back to the sender: the RFQ did not
   * arrive on a BTP session it can reply on (or advertised a different
   * address than the one that session authenticated under) and the routing
   * table has no route to `senderIlpAddress`. Refusing here is what keeps the
   * failure free — see `leg-b-return-path.ts`.
   */
  NO_RETURN_PATH: 'no_return_path',
  /**
   * swap#154 (toon-meta#411 Stage 5) — the zero-condition arrival unwrapped
   * fine but its inner rumor is not kind:20033. Overwhelmingly this is the
   * retired legacy kind:20032 swap request; this maker serves the rolling
   * protocol only and there is no more fall-through to hand it to.
   */
  LEGACY_PROTOCOL_REFUSED: 'legacy_protocol_refused',
  /**
   * swap#154 — the arrival could not even be unwrapped as a NIP-59 gift wrap
   * addressed to this maker (wrong recipient, corrupt bytes, not TOON at
   * all). Distinct from {@link LEGACY_PROTOCOL_REFUSED}: unlike a readable
   * kind:20032, there is no positive evidence this was ever a swap request.
   */
  UNREADABLE_REQUEST: 'unreadable_request',
} as const;

/**
 * Leg-0 RFQ request: the `content` of the kind:20033 rumor, UTF-8 JSON.
 *
 * Field list is spec §2.2's RFQ-request row ("pair, size hint,
 * `chainRecipient`, `streamNonce`, sender chain-B pubkeys"); `senderIlpAddress`
 * is the concrete form of "sender chain-B pubkeys" this implementation needs,
 * because it is the ILP destination every leg-B PREPARE of the session is sent
 * to ({@link RollingSession.senderIlpAddress}).
 */
export interface RollingRfqRequest {
  proto: typeof ROLLING_PROTOCOL;
  type: 'rfq';
  /** Session id the sender mints (spec §2.1) — 16 bytes, lowercase hex. */
  streamNonce: string;
  /** The pair every fill in the session is priced against. */
  pair: { from: RollingRfqAsset; to: RollingRfqAsset };
  /** Sender's payout address on `pair.to.chain` — the leg-B claim recipient. */
  chainRecipient: string;
  /** ILP address the maker sends this session's leg-B PREPAREs to. */
  senderIlpAddress: string;
  /** Optional total notional hint, source-asset micro-units (decimal string). */
  sizeHint?: string;
}

export interface RollingRfqAsset {
  assetCode: string;
  assetScale: number;
  chain: string;
}

/**
 * Leg-0 RFQ response: the `content` of the kind:20034 rumor, UTF-8 JSON.
 * Field list is spec §2.2's RFQ-response row (quote `R₀`, `spread`,
 * `maxRateAge`, `minAmount`/`maxAmount`, quote expiry).
 */
export interface RollingRfqResponse {
  proto: typeof ROLLING_PROTOCOL;
  type: 'quote';
  streamNonce: string;
  /** `R₀` — target units per source unit, decimal string. */
  rate: string;
  /** Unix-ms tick time of the rate source for `rate`. */
  rateTimestamp: number;
  /** Unix-ms after which the quote — and the session — expire. */
  expiresAt: number;
  /** Maker's advertised two-sided spread, basis points. Omitted if unknown. */
  spreadBps?: number;
  /** Maker's own freshness bound on its rate source, ms (spec §4). */
  maxRateAge?: number;
  /** Per-packet bounds, source-asset micro-units (decimal strings). */
  minAmount?: string;
  maxAmount?: string;
  /**
   * The maker's on-chain signer for `pair.to.chain`. Lets the sender arm its
   * R5 leg-B verification before the first fill instead of trusting the
   * `swapSignerAddress` echoed on the first advance.
   */
  swapSignerAddress?: string;
}

function isPositiveIntString(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v) && v.length > 0;
}

function parseAsset(v: unknown): RollingRfqAsset | null {
  if (typeof v !== 'object' || v === null) return null;
  const rec = v as Record<string, unknown>;
  const assetCode = rec['assetCode'];
  const assetScale = rec['assetScale'];
  const chain = rec['chain'];
  if (typeof assetCode !== 'string' || assetCode.length === 0) return null;
  if (
    typeof assetScale !== 'number' ||
    !Number.isSafeInteger(assetScale) ||
    assetScale < 0
  ) {
    return null;
  }
  if (typeof chain !== 'string' || chain.length === 0) return null;
  return { assetCode, assetScale, chain };
}

/**
 * Parse the `content` of a kind:20033 rumor as an RFQ request.
 *
 * Returns `'malformed'` when the payload self-identifies as `rolling/1` (or is
 * simply unparseable) but violates the shape — the caller rejects with a
 * precise RFQ error rather than a generic one. Returns `null` only when the
 * content is not rolling traffic at all.
 */
export function parseRollingRfqRequest(
  content: string
): RollingRfqRequest | 'malformed' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return 'malformed';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'malformed';
  const rec = parsed as Record<string, unknown>;
  if (rec['proto'] !== ROLLING_PROTOCOL) return null;
  if (rec['type'] !== 'rfq') return 'malformed';

  const streamNonce = rec['streamNonce'];
  if (
    typeof streamNonce !== 'string' ||
    !STREAM_NONCE_REGEX.test(streamNonce)
  ) {
    return 'malformed';
  }
  const pairRaw = rec['pair'];
  if (typeof pairRaw !== 'object' || pairRaw === null) return 'malformed';
  const from = parseAsset((pairRaw as Record<string, unknown>)['from']);
  const to = parseAsset((pairRaw as Record<string, unknown>)['to']);
  if (!from || !to) return 'malformed';

  const chainRecipient = rec['chainRecipient'];
  if (typeof chainRecipient !== 'string' || chainRecipient.length === 0) {
    return 'malformed';
  }
  const senderIlpAddress = rec['senderIlpAddress'];
  if (typeof senderIlpAddress !== 'string' || senderIlpAddress.length === 0) {
    return 'malformed';
  }
  const sizeHint = rec['sizeHint'];
  if (sizeHint !== undefined && !isPositiveIntString(sizeHint)) {
    return 'malformed';
  }

  return {
    proto: ROLLING_PROTOCOL,
    type: 'rfq',
    streamNonce,
    pair: { from, to },
    chainRecipient,
    senderIlpAddress,
    ...(sizeHint !== undefined ? { sizeHint } : {}),
  };
}

/** Match an RFQ's requested pair against the maker's advertised pairs. */
export function findRfqPair(
  pairs: readonly SwapPair[],
  requested: RollingRfqRequest['pair']
): SwapPair | undefined {
  return pairs.find(
    (p) =>
      p.from.assetCode === requested.from.assetCode &&
      p.from.assetScale === requested.from.assetScale &&
      p.from.chain === requested.from.chain &&
      p.to.assetCode === requested.to.assetCode &&
      p.to.assetScale === requested.to.assetScale &&
      p.to.chain === requested.to.chain
  );
}

/** Optional, all-defaulted RFQ knobs (no new REQUIRED config key). */
export interface RollingRfqConfig {
  /**
   * How long the quoted `R₀` stays a valid basis for the sender's session
   * floor (spec §5), default {@link DEFAULT_RFQ_QUOTE_TTL_MS} — the 60s of the
   * spec's §11 worked example.
   *
   * This is deliberately NOT the session lifetime. Every fill is priced at a
   * fresh `R_i` and guarded by `maxRateAge` (spec §4), so an old quote is a
   * sender-side concern only; capping the session at the quote's expiry would
   * kill any stream that outlives one quote. Session lifetime stays the
   * `RollingSessionStore`'s TTL (`rolling.sessionTtlMs`, default 1h).
   */
  quoteTtlMs?: number;
  /** Advertised two-sided spread in bps. Omitted from the quote when unset. */
  spreadBps?: number;
}

/** A timestamped quote for one pair, as the intake needs it. */
export interface RfqQuote {
  rate: string;
  rateTimestamp: number;
}

export interface RollingRfqIntakeConfig {
  /** The maker's advertised pairs — the RFQ's pair must be one of them. */
  swapPairs: readonly SwapPair[];
  /** Quote source. Returning `null` fails the RFQ closed (rate_unavailable). */
  quote: (pair: SwapPair) => Promise<RfqQuote | null> | RfqQuote | null;
  /** Commits the session. Throwing → `session_rejected` (store full, etc.). */
  registerSession: (session: RollingSession) => void;
  /**
   * Resolve — and where possible install — the leg-B return path for the
   * session about to be minted (`leg-b-return-path.ts`). Called BEFORE
   * {@link registerSession}, so an `'unreachable'` verdict refuses the RFQ
   * without ever creating a session that could not be filled.
   *
   * Absent (or `'unavailable'`) leaves the pre-fix behaviour untouched.
   */
  bindReturnPath?: (args: {
    senderIlpAddress: string;
    sourcePeer?: string;
  }) => LegBReturnPath;
  /** Maker's Nostr secret key: unwraps the request, seals the response. */
  secretKey: Uint8Array;
  /** Per-chain on-chain signer addresses, keyed as `pair.to.chain`. */
  signerAddresses?: Readonly<Record<string, string>>;
  /** Maker's freshness bound per pair, ms — advertised in the quote (spec §4). */
  maxRateAgeMs?: (pair: SwapPair) => number | undefined;
  rfq?: RollingRfqConfig;
  now?: () => number;
  logger?: {
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    /** swap#152 — carries the `rolling-rfq` intake classification event. */
    info?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** Accept/reject shape the packet handler returns, structurally. */
export type RollingRfqOutcome =
  | { accept: true; data: string; message?: string }
  | {
      accept: false;
      code: string;
      message: string;
      data: string;
      rejectReason: { code: string; message: string };
    };

/**
 * Decide whether an inbound zero-condition local-delivery packet is an RFQ
 * request, and answer it — accept or reject, terminally (swap#154).
 *
 * A kind:20033 rumor mints a session and returns a quote. Everything else —
 * unreadable bytes, or a readable rumor whose kind is not 20033 (typically
 * the retired legacy kind:20032) — is a named reject. Every failure mode is
 * expressed as a returned reject; this never throws and never returns `null`.
 */
export function createRollingRfqIntake(config: RollingRfqIntakeConfig): {
  /**
   * TERMINAL (swap#154, toon-meta#411 Stage 5): every zero-condition arrival
   * on this seam ends here. A kind:20033 rumor mints a session and returns a
   * quote; anything else — the retired legacy kind:20032, an unknown kind, or
   * a payload that will not even unwrap — is a named reject. There is no more
   * legacy handler to fall through to, so this never returns `null`.
   */
  handle(
    dataB64: string,
    arrival?: { sourcePeer?: string }
  ): Promise<RollingRfqOutcome>;
} {
  const quoteTtlMs = config.rfq?.quoteTtlMs ?? DEFAULT_RFQ_QUOTE_TTL_MS;
  const spreadBps = config.rfq?.spreadBps;
  const now = config.now ?? Date.now;
  const logger = config.logger;

  const reject = (
    code: string,
    semantic: string,
    message: string,
    reason: string
  ): RollingRfqOutcome =>
    buildRollingReject({
      code,
      semantic,
      message,
      reason,
    }) as RollingRfqOutcome;

  /** One `swap.intake.arrival` line for a reject decided in this module. */
  const emitRefused = (sourcePeer: string | undefined, reason: string): void => {
    logger?.info?.(SWAP_INTAKE_EVENT, {
      class: 'refused' satisfies SwapIntakeClass,
      sender: sourcePeer,
      reason,
    });
  };

  return {
    async handle(
      dataB64: string,
      arrival?: { sourcePeer?: string }
    ): Promise<RollingRfqOutcome> {
      if (typeof dataB64 !== 'string' || dataB64.length === 0) {
        emitRefused(
          arrival?.sourcePeer,
          ROLLING_RFQ_REJECT_REASONS.UNREADABLE_REQUEST
        );
        return reject(
          'F06',
          'unreadable_request',
          'empty or missing swap request payload',
          ROLLING_RFQ_REJECT_REASONS.UNREADABLE_REQUEST
        );
      }

      // Unwrap to read the INNER rumor kind. The outer envelope of an RFQ and
      // of a legacy swap request are both kind:1059, so the kind is only
      // visible after NIP-59 decryption. Any failure here means the payload
      // is not even a gift wrap this maker can read at all — refuse, there is
      // no other handler left on this seam to try.
      let rumor: UnsignedEvent;
      let senderPubkey: string;
      try {
        const unwrapped = unwrapSwapPacketFromToon({
          toonData: Buffer.from(dataB64, 'base64'),
          recipientSecretKey: config.secretKey,
        });
        rumor = unwrapped.rumor;
        senderPubkey = unwrapped.senderPubkey;
      } catch {
        logger?.warn?.('swap.rfq.unreadable', { sender: arrival?.sourcePeer });
        emitRefused(
          arrival?.sourcePeer,
          ROLLING_RFQ_REJECT_REASONS.UNREADABLE_REQUEST
        );
        return reject(
          'F06',
          'unreadable_request',
          'could not decrypt or parse the swap request as a NIP-59 gift wrap',
          ROLLING_RFQ_REJECT_REASONS.UNREADABLE_REQUEST
        );
      }
      if (rumor?.kind !== ROLLING_RFQ_REQUEST_KIND) {
        // Best-effort pair label for operator diagnostics — the retired
        // legacy request shape tagged its pair the same way a rolling one
        // does. Absent (rather than failing the reject) when it doesn't
        // resolve, e.g. an unrecognized inner kind entirely.
        const legacyPair = formatPairLabel(
          findSwapPair(rumor, [...config.swapPairs]) ?? undefined
        );
        logger?.info?.(SWAP_INTAKE_EVENT, {
          class: 'refused' satisfies SwapIntakeClass,
          sender: arrival?.sourcePeer,
          reason: ROLLING_RFQ_REJECT_REASONS.LEGACY_PROTOCOL_REFUSED,
          ...(legacyPair !== undefined && { pair: legacyPair }),
        });
        return reject(
          'F06',
          'legacy_protocol_refused',
          `this maker only accepts rolling swap requests (kind:${ROLLING_RFQ_REQUEST_KIND}); ` +
            `kind:${rumor?.kind} is the retired legacy swap protocol and is no longer served`,
          ROLLING_RFQ_REJECT_REASONS.LEGACY_PROTOCOL_REFUSED
        );
      }

      const parsed = parseRollingRfqRequest(
        typeof rumor.content === 'string' ? rumor.content : ''
      );

      // swap#152 (ADR 0003's removal gate) — kind:20033 is unambiguous:
      // whatever `parsed` turns out to be, this arrival IS the `rolling-rfq`
      // class. Emitted here (not by the caller) because this is the only
      // place that has already paid for the unwrap; `sender` is the BTP peer
      // id, matching the ILP-level identity every other intake class logs
      // (never the gift-wrap's Nostr `senderPubkey`).
      const requestedPair =
        parsed === null || parsed === 'malformed'
          ? undefined
          : formatPairLabel(parsed.pair);
      logger?.info?.(SWAP_INTAKE_EVENT, {
        class: 'rolling-rfq' satisfies SwapIntakeClass,
        sender: arrival?.sourcePeer,
        ...(requestedPair !== undefined && { pair: requestedPair }),
      });

      if (parsed === null || parsed === 'malformed') {
        // Kind:20033 is unambiguously rolling traffic — reject with the
        // actionable RFQ-specific reason rather than a generic one.
        logger?.warn?.('swap.rfq.malformed', { senderPubkey });
        return reject(
          'F01',
          'invalid_request',
          'malformed rolling RFQ request',
          ROLLING_RFQ_REJECT_REASONS.MALFORMED_RFQ
        );
      }

      const pair = findRfqPair(config.swapPairs, parsed.pair);
      if (!pair) {
        logger?.debug?.('swap.rfq.unsupported_pair', {
          streamNonce: parsed.streamNonce,
        });
        return reject(
          'F06',
          'unsupported_pair',
          `pair ${parsed.pair.from.assetCode}:${parsed.pair.from.chain} → ` +
            `${parsed.pair.to.assetCode}:${parsed.pair.to.chain} is not advertised`,
          ROLLING_RFQ_REJECT_REASONS.UNSUPPORTED_PAIR
        );
      }

      let quote: RfqQuote | null;
      try {
        quote = await config.quote(pair);
      } catch {
        quote = null;
      }
      if (!quote || typeof quote.rate !== 'string' || quote.rate.length === 0) {
        logger?.warn?.('swap.rfq.rate_unavailable', {
          streamNonce: parsed.streamNonce,
        });
        return reject(
          'T99',
          'rate_unavailable',
          'no rate available for the requested pair',
          ROLLING_RFQ_REJECT_REASONS.RATE_UNAVAILABLE
        );
      }

      // Quote validity only. The session's own lifetime is left to the store's
      // TTL (see `RollingRfqConfig.quoteTtlMs`) by omitting `expiresAt` below.
      const quoteExpiresAt = now() + quoteTtlMs;

      // Leg-B deliverability, BEFORE anything is committed (spec §3 R4/R5:
      // a maker that cannot return leg B can never fulfil a fill, and every
      // such fill would burn a sender-minted condition for nothing). This is
      // the only point at which failing is free.
      const returnPath = config.bindReturnPath?.({
        senderIlpAddress: parsed.senderIlpAddress,
        ...(arrival?.sourcePeer !== undefined
          ? { sourcePeer: arrival.sourcePeer }
          : {}),
      });
      if (returnPath?.status === 'unreachable') {
        logger?.warn?.('swap.rfq.no_return_path', {
          streamNonce: parsed.streamNonce,
          senderIlpAddress: parsed.senderIlpAddress,
          sourcePeer: arrival?.sourcePeer,
          reason: returnPath.reason,
        });
        return reject(
          'F02',
          'unreachable',
          `no leg-B return path to ${parsed.senderIlpAddress}: ${returnPath.reason}. ` +
            'Connect to this maker over BTP.',
          ROLLING_RFQ_REJECT_REASONS.NO_RETURN_PATH
        );
      }

      // Commit the session BEFORE answering: a sender that receives a quote
      // must be able to send fill seq 1 immediately. Registering after the
      // response would open a window where the very first fill F06s.
      try {
        config.registerSession({
          streamNonce: parsed.streamNonce,
          pair,
          chainRecipient: parsed.chainRecipient,
          senderIlpAddress: parsed.senderIlpAddress,
          senderPubkey,
        });
      } catch (err) {
        logger?.warn?.('swap.rfq.session_rejected', {
          streamNonce: parsed.streamNonce,
          err: err instanceof Error ? err.message : String(err),
        });
        return reject(
          'T03',
          'session_rejected',
          'rolling session could not be registered',
          ROLLING_RFQ_REJECT_REASONS.SESSION_REJECTED
        );
      }

      const maxRateAge = config.maxRateAgeMs?.(pair);
      const swapSignerAddress = config.signerAddresses?.[pair.to.chain];
      const response: RollingRfqResponse = {
        proto: ROLLING_PROTOCOL,
        type: 'quote',
        streamNonce: parsed.streamNonce,
        rate: quote.rate,
        rateTimestamp: quote.rateTimestamp,
        expiresAt: quoteExpiresAt,
        ...(spreadBps !== undefined ? { spreadBps } : {}),
        ...(maxRateAge !== undefined ? { maxRateAge } : {}),
        ...(pair.minAmount !== undefined ? { minAmount: pair.minAmount } : {}),
        ...(pair.maxAmount !== undefined ? { maxAmount: pair.maxAmount } : {}),
        ...(swapSignerAddress !== undefined ? { swapSignerAddress } : {}),
      };

      // Gift-wrap the quote back to the RFQ's reply key (spec §2.2). The quote
      // and the session's `chainRecipient` are not broadcast in plaintext.
      let giftWrap: NostrEvent;
      try {
        giftWrap = wrapSwapPacket({
          rumor: {
            kind: ROLLING_RFQ_RESPONSE_KIND,
            content: JSON.stringify(response),
            tags: [],
            created_at: Math.floor(now() / 1000),
            pubkey: '',
          } as unknown as UnsignedEvent,
          senderSecretKey: config.secretKey,
          recipientPubkey: senderPubkey,
        }).giftWrap;
      } catch (err) {
        // The session is already registered and its TTL will reap it; the
        // sender simply never gets a usable quote.
        logger?.warn?.('swap.rfq.wrap_failed', {
          streamNonce: parsed.streamNonce,
          err: err instanceof Error ? err.message : String(err),
        });
        return reject(
          'T00',
          'application_error',
          'failed to seal the RFQ response',
          ROLLING_RFQ_REJECT_REASONS.SESSION_REJECTED
        );
      }

      logger?.debug?.('swap.rfq.session_registered', {
        streamNonce: parsed.streamNonce,
        pair: `${pair.from.assetCode}:${pair.from.chain}→${pair.to.assetCode}:${pair.to.chain}`,
        quoteExpiresAt,
        returnPath: returnPath?.status ?? 'unavailable',
        ...(returnPath && 'nextHop' in returnPath
          ? { returnNextHop: returnPath.nextHop }
          : {}),
      });

      return {
        accept: true,
        data: Buffer.from(JSON.stringify(giftWrap), 'utf8').toString('base64'),
      };
    },
  };
}
