/**
 * The `rolling/3` swap wire — what a taker and a maker say to each other
 * through a relay, with nothing but a paying client on either side.
 *
 * Every message is a JSON document. One of them is public; the rest are
 * private:
 *
 *   - An **order** ({@link SwapOrder}) is a plain, signed, addressable Nostr
 *     event ({@link SWAP_ORDER_KIND}) the maker publishes: the pair, the
 *     rate, how small and how large one fill may be, and every on-chain fact
 *     a taker needs to pay leg A and verify leg B. Discovery IS the order.
 *   - Everything after it — **accept**, **quote**, **fill**, **advance**,
 *     **refusal**, **done** — is a rumor of kind {@link SWAP_RUMOR_KIND},
 *     NIP-59 gift-wrapped to the counterparty (`nip59.ts`). The relay stores
 *     the wraps; a party that goes away drains them when it returns.
 *
 * A swap is a stream of fills. Fill `i` carries the taker's **cumulative**
 * leg-A claim; the advance that answers it carries the maker's cumulative
 * leg-B claim, re-priced at the maker's current rate. Both are
 * {@link SwapClaim}s — the same shape, verified by the same code
 * (`received-claim.ts`) — over the chains' standard balance-proof messages.
 * Exposure is one fill: a claim is money the moment the other side holds it,
 * so nothing here pretends to couple the two legs.
 *
 * What replaced `rolling/2`'s HTTP: the connector no longer verifies leg A
 * for the maker (it never opens a wrap), so the taker's claim rides in the
 * fill and the maker verifies it itself; and a refusal is a message, not an
 * HTTP status. What did not change: `PaymentAttribution` — the maker engine
 * still consumes "who paid, how much, on which chain"; only who fills it in
 * moved.
 */

export const SWAP_WIRE_PROTOCOL = 'rolling/3';

/**
 * Addressable (NIP-01 `30000–39999`) — one live order per (maker, pair),
 * replaced by `d`. Provisional; re-run toon-meta's kind-allocation check
 * (`docs/mesh-compute-job-protocol.md` §1.1) before this ships.
 */
export const SWAP_ORDER_KIND = 30032;
/** The rumor kind inside every swap gift wrap; `type` discriminates. */
export const SWAP_RUMOR_KIND = 20036;

export interface SwapWireAsset {
  assetCode: string;
  assetScale: number;
  chain: string;
}

export interface SwapWirePair {
  from: SwapWireAsset;
  to: SwapWireAsset;
}

/**
 * One leg's on-chain facts, from the maker's side: which chain, the maker's
 * address there (the participant a taker's channel is with, and the signer of
 * leg-B claims), the contract/program the channel lives under, the token.
 */
export interface SwapLegTerms {
  chain: string;
  /** The maker's on-chain address for `chain` (EVM address / Solana pubkey). */
  swapSignerAddress: string;
  /** EVM: the `TokenNetwork` — the EIP-712 `verifyingContract`. */
  verifyingContract?: string;
  /** Solana: the payment-channel program the claim message binds (ADR 0053). */
  programId?: string;
  /** The token (ERC-20 address / SPL mint). */
  token?: string;
}
/** @deprecated name from rolling/2 — the same shape serves both legs now. */
export type SwapLegBTerms = SwapLegTerms;

/** A signed cumulative balance proof, as either party sends it. */
export interface SwapClaim {
  chain: string;
  /** EVM: bytes32 hex; Solana: the channel PDA (base58). */
  channelId: string;
  /** Decimal string. */
  nonce: string;
  /** Decimal string — cumulative, never a delta. */
  cumulativeAmount: string;
  /** base64 — 65-byte `r‖s‖v` on EVM, 64-byte Ed25519 on Solana. */
  signature: string;
  /** The signer's on-chain address. */
  signer: string;
}

/** The public order (kind {@link SWAP_ORDER_KIND}, content = this JSON). */
export interface SwapOrder {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'order';
  /** Stable per (maker, pair) — the event's `d` tag. */
  orderId: string;
  pair: SwapWirePair;
  /** Indicative `R₀`: target whole-units per source whole-unit, decimal string. */
  rate: string;
  rateTimestamp: number;
  /** Bounds on one fill's delta, `pair.from` base units. */
  fill: { min: string; max: string };
  /** Target-unit capacity the maker can currently issue against. */
  maxAmount?: string;
  maxRateAgeMs?: number;
  /** Where the taker pays: the maker's facts on `pair.from.chain`. */
  legA: SwapLegTerms;
  /** Where the taker is paid: the maker's facts on `pair.to.chain`. */
  legB: SwapLegTerms;
  /** Unix ms; the wrap's NIP-40 `expiration` mirrors it in seconds. */
  expiresAt: number;
}

/** The taker opens a session against an order. */
export interface SwapAccept {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'accept';
  orderId: string;
  /** 16 bytes, lowercase hex — the session id every later message names. */
  streamNonce: string;
  pair: SwapWirePair;
  /** The taker's payout address on `pair.to.chain` — the leg-B channel counterparty. */
  chainRecipient: string;
  /** The taker's address on `pair.from.chain` — the leg-A channel counterparty. */
  payer: { chain: string; address: string };
  /** How much (in `pair.from` base units) the taker intends to swap. */
  sizeHint?: string;
  /** Re-quote a session this taker already opened; the quote says `lastSeq`. */
  resume?: boolean;
}

/** The maker answers an accept. */
export interface SwapQuote {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'quote';
  streamNonce: string;
  orderId: string;
  rate: string;
  rateTimestamp: number;
  /** Unix ms after which the first fill is refused (`quote_expired`). */
  expiresAt: number;
  fill: { min: string; max: string; chain: string };
  maxRateAgeMs?: number;
  maxAmount?: string;
  /** The highest fill seq this session has already been answered for. */
  lastSeq: number;
  legA: SwapLegTerms;
  legB: SwapLegTerms;
}

/** One fill: the taker's cumulative leg-A claim, one seq further. */
export interface SwapFill {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'fill';
  streamNonce: string;
  /** 1-based, strictly sequential per session. */
  seq: number;
  claim: SwapClaim;
}

/** The answer to a fill: the maker's cumulative leg-B claim. */
export interface SwapAdvance {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'advance';
  streamNonce: string;
  seq: number;
  claim: SwapClaim;
  claimId?: string;
  /** The taker's payout address the claim is for. */
  recipient: string;
  rate: string;
  rateTimestamp: number;
  /** What this fill was priced on: the verified delta plus any credit. */
  sourceAmount: string;
  /** `⌊sourceAmount·rate⌋` in target base units — this fill's delta. */
  targetAmount: string;
  /** Source units carried over from earlier refused-but-paid fills, now applied. */
  credited?: string;
  legB: SwapLegTerms;
  /** BIP-340 stream receipt over the quote tape (rolling-swap spec §7.2). */
  receipt?: unknown;
}

/** The taker closes a session (optional, informational). */
export interface SwapDone {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'done';
  streamNonce: string;
  lastSeq: number;
}

export const SWAP_REFUSAL_REASONS = {
  MALFORMED_REQUEST: 'malformed_request',
  UNKNOWN_PAIR: 'unknown_pair',
  UNKNOWN_ORDER: 'unknown_order',
  INVALID_RECIPIENT: 'invalid_recipient',
  UNKNOWN_SESSION: 'unknown_session',
  SESSION_EXPIRED: 'session_expired',
  QUOTE_EXPIRED: 'quote_expired',
  SESSION_CONFLICT: 'session_conflict',
  UNPAID: 'unpaid',
  PAYER_MISMATCH: 'payer_mismatch',
  CHAIN_MISMATCH: 'chain_mismatch',
  SEQ_GAP: 'seq_gap',
  /** The fill's claim failed verification; `detail.code` says which rung. */
  CLAIM_INVALID: 'claim_invalid',
  FILL_TOO_LARGE: 'fill_too_large',
  RATE_LIMITED: 'rate_limited',
  CHAIN_READ_FAILED: 'chain_read_failed',
  STALE_RATE: 'stale_rate',
  RATE_UNAVAILABLE: 'rate_unavailable',
  INSUFFICIENT_LIQUIDITY: 'insufficient_liquidity',
  FILL_TOO_SMALL: 'fill_too_small',
  CHANNEL_UNREDEEMED: 'channel_unredeemed',
  NO_CHANNEL_AVAILABLE: 'no_channel_available',
  PERSISTENCE_FAILED: 'persistence_failed',
  SIGNING_FAILED: 'signing_failed',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type SwapRefusalReason =
  (typeof SWAP_REFUSAL_REASONS)[keyof typeof SWAP_REFUSAL_REASONS];

/** Any maker answer that is not a quote or an advance. */
export interface SwapRefusal {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'refusal';
  reason: SwapRefusalReason;
  message: string;
  /** Whether the same message may succeed later without the taker changing it. */
  retry: boolean;
  streamNonce?: string;
  seq?: number;
  /** Total source units the maker owes this session from refused-but-paid fills. */
  credited?: string;
  detail?: Record<string, unknown>;
}

/** What a maker sends. */
export type SwapWireAnswer = SwapQuote | SwapAdvance | SwapRefusal;
/** What a taker sends (after the public order). */
export type SwapTakerMessage = SwapAccept | SwapFill | SwapDone;

// ---------------------------------------------------------------------------
// Parsers — never throw
// ---------------------------------------------------------------------------

export type SwapWireParse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const STREAM_NONCE_RE = /^[0-9a-f]{32}$/;
const DECIMAL_RE = /^[0-9]+$/;

export function isValidStreamNonce(value: unknown): value is string {
  return typeof value === 'string' && STREAM_NONCE_RE.test(value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAsset(v: unknown): v is SwapWireAsset {
  if (!isRecord(v)) return false;
  return (
    typeof v['assetCode'] === 'string' &&
    v['assetCode'].length > 0 &&
    typeof v['assetScale'] === 'number' &&
    Number.isInteger(v['assetScale']) &&
    v['assetScale'] >= 0 &&
    typeof v['chain'] === 'string' &&
    v['chain'].length > 0
  );
}

function isPair(v: unknown): v is SwapWirePair {
  return isRecord(v) && isAsset(v['from']) && isAsset(v['to']);
}

function isDecimal(v: unknown): v is string {
  return typeof v === 'string' && DECIMAL_RE.test(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isLegTerms(v: unknown): v is SwapLegTerms {
  if (!isRecord(v)) return false;
  if (
    !isNonEmptyString(v['chain']) ||
    !isNonEmptyString(v['swapSignerAddress'])
  )
    return false;
  for (const k of ['verifyingContract', 'programId', 'token'] as const) {
    if (v[k] !== undefined && !isNonEmptyString(v[k])) return false;
  }
  return true;
}

function protoAndType(
  raw: unknown,
  type: string
): SwapWireParse<Record<string, unknown>> {
  if (!isRecord(raw)) return { ok: false, error: 'body is not a JSON object' };
  if (raw['proto'] !== SWAP_WIRE_PROTOCOL) {
    return { ok: false, error: `proto must be "${SWAP_WIRE_PROTOCOL}"` };
  }
  if (raw['type'] !== type)
    return { ok: false, error: `type must be "${type}"` };
  return { ok: true, value: raw };
}

function parseStreamNonce(v: unknown): SwapWireParse<string> {
  if (typeof v !== 'string')
    return { ok: false, error: 'streamNonce must be a string' };
  const nonce = v.toLowerCase();
  if (!isValidStreamNonce(nonce))
    return { ok: false, error: 'streamNonce must be 16 bytes of hex' };
  return { ok: true, value: nonce };
}

/** Validate a claim's shape (not its signature — `received-claim.ts` does that). */
export function parseSwapClaim(raw: unknown): SwapWireParse<SwapClaim> {
  if (!isRecord(raw)) return { ok: false, error: 'claim must be an object' };
  if (!isNonEmptyString(raw['chain']))
    return { ok: false, error: 'claim.chain must be a string' };
  if (!isNonEmptyString(raw['channelId']))
    return { ok: false, error: 'claim.channelId must be a string' };
  if (!isDecimal(raw['nonce']))
    return { ok: false, error: 'claim.nonce must be a decimal integer string' };
  if (!isDecimal(raw['cumulativeAmount'])) {
    return {
      ok: false,
      error: 'claim.cumulativeAmount must be a decimal integer string',
    };
  }
  if (!isNonEmptyString(raw['signature']))
    return { ok: false, error: 'claim.signature must be base64' };
  if (!isNonEmptyString(raw['signer']))
    return { ok: false, error: 'claim.signer must be a string' };
  return {
    ok: true,
    value: {
      chain: raw['chain'],
      channelId: raw['channelId'],
      nonce: raw['nonce'],
      cumulativeAmount: raw['cumulativeAmount'],
      signature: raw['signature'],
      signer: raw['signer'],
    },
  };
}

export function parseSwapOrder(raw: unknown): SwapWireParse<SwapOrder> {
  const head = protoAndType(raw, 'order');
  if (!head.ok) return head;
  const r = head.value;
  if (!isNonEmptyString(r['orderId']))
    return { ok: false, error: 'orderId must be a string' };
  if (!isPair(r['pair']))
    return { ok: false, error: 'pair.from / pair.to must be assets' };
  if (
    typeof r['rate'] !== 'string' ||
    !/^[0-9]+(\.[0-9]+)?$/.test(r['rate']) ||
    Number(r['rate']) <= 0
  ) {
    return { ok: false, error: 'rate must be a positive decimal string' };
  }
  if (typeof r['rateTimestamp'] !== 'number')
    return { ok: false, error: 'rateTimestamp must be a number' };
  const fill = r['fill'];
  if (!isRecord(fill) || !isDecimal(fill['min']) || !isDecimal(fill['max'])) {
    return {
      ok: false,
      error: 'fill.min / fill.max must be decimal integer strings',
    };
  }
  if (BigInt(fill['min']) <= 0n || BigInt(fill['max']) < BigInt(fill['min'])) {
    return {
      ok: false,
      error: 'fill.min must be positive and fill.max >= fill.min',
    };
  }
  if (r['maxAmount'] !== undefined && !isDecimal(r['maxAmount'])) {
    return { ok: false, error: 'maxAmount must be a decimal integer string' };
  }
  if (
    r['maxRateAgeMs'] !== undefined &&
    typeof r['maxRateAgeMs'] !== 'number'
  ) {
    return { ok: false, error: 'maxRateAgeMs must be a number' };
  }
  if (!isLegTerms(r['legA']) || !isLegTerms(r['legB'])) {
    return {
      ok: false,
      error: 'legA / legB must name a chain and swapSignerAddress',
    };
  }
  if (typeof r['expiresAt'] !== 'number')
    return { ok: false, error: 'expiresAt must be a number' };
  return {
    ok: true,
    value: {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'order',
      orderId: r['orderId'],
      pair: r['pair'],
      rate: r['rate'],
      rateTimestamp: r['rateTimestamp'],
      fill: { min: fill['min'], max: fill['max'] },
      ...(r['maxAmount'] !== undefined && { maxAmount: r['maxAmount'] }),
      ...(r['maxRateAgeMs'] !== undefined && {
        maxRateAgeMs: r['maxRateAgeMs'],
      }),
      legA: r['legA'],
      legB: r['legB'],
      expiresAt: r['expiresAt'],
    },
  };
}

export function parseSwapAccept(raw: unknown): SwapWireParse<SwapAccept> {
  const head = protoAndType(raw, 'accept');
  if (!head.ok) return head;
  const r = head.value;
  if (!isNonEmptyString(r['orderId']))
    return { ok: false, error: 'orderId must be a string' };
  const nonce = parseStreamNonce(r['streamNonce']);
  if (!nonce.ok) return nonce;
  if (!isPair(r['pair']))
    return { ok: false, error: 'pair.from / pair.to must be assets' };
  if (!isNonEmptyString(r['chainRecipient'])) {
    return { ok: false, error: 'chainRecipient must be a non-empty string' };
  }
  const payer = r['payer'];
  if (
    !isRecord(payer) ||
    !isNonEmptyString(payer['chain']) ||
    !isNonEmptyString(payer['address'])
  ) {
    return {
      ok: false,
      error: 'payer.chain / payer.address must be non-empty strings',
    };
  }
  if (r['sizeHint'] !== undefined && !isDecimal(String(r['sizeHint']))) {
    return { ok: false, error: 'sizeHint must be a decimal integer string' };
  }
  if (r['resume'] !== undefined && typeof r['resume'] !== 'boolean') {
    return { ok: false, error: 'resume must be a boolean' };
  }
  return {
    ok: true,
    value: {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'accept',
      orderId: r['orderId'],
      streamNonce: nonce.value,
      pair: r['pair'],
      chainRecipient: r['chainRecipient'],
      payer: { chain: payer['chain'], address: payer['address'] },
      ...(r['sizeHint'] !== undefined && { sizeHint: String(r['sizeHint']) }),
      ...(r['resume'] !== undefined && { resume: r['resume'] }),
    },
  };
}

export function parseSwapFill(raw: unknown): SwapWireParse<SwapFill> {
  const head = protoAndType(raw, 'fill');
  if (!head.ok) return head;
  const r = head.value;
  const nonce = parseStreamNonce(r['streamNonce']);
  if (!nonce.ok) return nonce;
  const seq = r['seq'];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    return { ok: false, error: 'seq must be a positive integer' };
  }
  const claim = parseSwapClaim(r['claim']);
  if (!claim.ok) return claim;
  return {
    ok: true,
    value: {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'fill',
      streamNonce: nonce.value,
      seq,
      claim: claim.value,
    },
  };
}

export function parseSwapDone(raw: unknown): SwapWireParse<SwapDone> {
  const head = protoAndType(raw, 'done');
  if (!head.ok) return head;
  const r = head.value;
  const nonce = parseStreamNonce(r['streamNonce']);
  if (!nonce.ok) return nonce;
  const lastSeq = r['lastSeq'];
  if (
    typeof lastSeq !== 'number' ||
    !Number.isInteger(lastSeq) ||
    lastSeq < 0
  ) {
    return { ok: false, error: 'lastSeq must be a non-negative integer' };
  }
  return {
    ok: true,
    value: {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'done',
      streamNonce: nonce.value,
      lastSeq,
    },
  };
}

/** Parse anything a taker may send (maker side). */
export function parseSwapTakerMessage(
  raw: unknown
): SwapWireParse<SwapTakerMessage> {
  if (!isRecord(raw)) return { ok: false, error: 'body is not a JSON object' };
  switch (raw['type']) {
    case 'accept':
      return parseSwapAccept(raw);
    case 'fill':
      return parseSwapFill(raw);
    case 'done':
      return parseSwapDone(raw);
    default:
      return {
        ok: false,
        error: `unknown taker message type ${String(raw['type'])}`,
      };
  }
}

/** Parse a maker answer (taker side); an advance's claim is shape-checked. */
export function parseSwapWireAnswer(
  raw: unknown
): SwapWireParse<SwapWireAnswer> {
  if (!isRecord(raw)) return { ok: false, error: 'body is not a JSON object' };
  if (raw['proto'] !== SWAP_WIRE_PROTOCOL) {
    return { ok: false, error: `proto must be "${SWAP_WIRE_PROTOCOL}"` };
  }
  switch (raw['type']) {
    case 'quote': {
      const nonce = parseStreamNonce(raw['streamNonce']);
      if (!nonce.ok) return nonce;
      if (typeof raw['lastSeq'] !== 'number')
        return { ok: false, error: 'quote.lastSeq must be a number' };
      if (!isLegTerms(raw['legA']) || !isLegTerms(raw['legB'])) {
        return {
          ok: false,
          error: 'quote.legA / legB must name a chain and swapSignerAddress',
        };
      }
      const fill = raw['fill'];
      if (
        !isRecord(fill) ||
        !isDecimal(fill['min']) ||
        !isDecimal(fill['max']) ||
        !isNonEmptyString(fill['chain'])
      ) {
        return { ok: false, error: 'quote.fill must carry min/max/chain' };
      }
      return {
        ok: true,
        value: { ...(raw as unknown as SwapQuote), streamNonce: nonce.value },
      };
    }
    case 'advance': {
      const nonce = parseStreamNonce(raw['streamNonce']);
      if (!nonce.ok) return nonce;
      if (typeof raw['seq'] !== 'number')
        return { ok: false, error: 'advance.seq must be a number' };
      const claim = parseSwapClaim(raw['claim']);
      if (!claim.ok) return { ok: false, error: `advance.${claim.error}` };
      if (!isDecimal(raw['targetAmount']) || !isDecimal(raw['sourceAmount'])) {
        return {
          ok: false,
          error: 'advance.sourceAmount / targetAmount must be decimal strings',
        };
      }
      return {
        ok: true,
        value: {
          ...(raw as unknown as SwapAdvance),
          streamNonce: nonce.value,
          claim: claim.value,
        },
      };
    }
    case 'refusal': {
      if (
        typeof raw['reason'] !== 'string' ||
        typeof raw['message'] !== 'string'
      ) {
        return { ok: false, error: 'refusal.reason / message must be strings' };
      }
      return { ok: true, value: raw as unknown as SwapRefusal };
    }
    default:
      return { ok: false, error: `unknown answer type ${String(raw['type'])}` };
  }
}

// ---------------------------------------------------------------------------
// Payment attribution — the maker engine's one input about money
// ---------------------------------------------------------------------------

/**
 * "Who paid, how much, on which chain" for one fill. On `rolling/2` the
 * connector stated this in three headers; on `rolling/3` the maker fills it
 * in from its own verification of the taker's claim (`received-claim.ts`).
 * The engine consumes the struct either way.
 */
export interface PaymentAttribution {
  /** `evm:0x<64 hex>` or `solana:<base58>` — the leg-A channel key. */
  payer: string;
  /** What this fill's claim advanced the maker's cumulative by, base units. */
  amount: bigint;
  /** `evm` | `solana`. */
  chain: 'evm' | 'solana';
}

/** The channel key an attribution names, from a verified claim. */
export function attributionPayerKey(
  chain: 'evm' | 'solana',
  channelId: string
): string {
  return `${chain}:${chain === 'evm' ? channelId.toLowerCase() : channelId}`;
}
