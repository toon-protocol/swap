/**
 * The `rolling/2` swap wire — what a taker and a maker exchange when the
 * maker is an **app behind a Rust connector's route termination**.
 *
 * Two HTTP exchanges, both carried as sealed ILP envelopes through the
 * maker's connector (`POST /ilp` on its client edge, or the BTP carriage):
 *
 *   1. **RFQ** — `POST <rfq route>` with a {@link SwapRfqRequest} body. The
 *      route is priced at 0, so it needs no claim. The maker answers a
 *      {@link SwapQuote}: the rate, how big one fill is, where to send it,
 *      and every fact the taker needs to verify and redeem leg-B claims.
 *   2. **Fill** — `POST <fill route>` with a {@link SwapFillRequest} body.
 *      The route is priced at the fill size; the connector verifies the
 *      taker's leg-A claim on chain, delivers the request to the maker with
 *      `X-TOON-Payer` / `X-TOON-Amount` / `X-TOON-Chain` (connector ADR 0040),
 *      and the maker's answer — a {@link SwapAdvance} carrying the cumulative
 *      leg-B balance proof — rides home sealed in the FULFILL.
 *
 * Why this replaced `rolling/1`'s coupled legs: the Rust connector refuses a
 * zero-condition packet outright (PF-01), derives a route termination's
 * fulfilment itself (ADR 0019), and delivers a packet to a client session
 * unpaid — so neither the gift-wrapped RFQ nor the maker-originated,
 * condition-coupled leg-B PREPARE can exist on it. A packet carries its
 * claim (ADR 0042): leg A is paid before the maker is asked, and the taker's
 * exposure is exactly one fill — the same `δ·W` (W = 1) bound rolling/1's
 * residual-exposure analysis already accepted. See
 * `docs/rust-connector-migration.md`.
 *
 * Every body is JSON. A maker answer that is not a quote or an advance is a
 * {@link SwapRefusal} with a non-2xx HTTP status; because the connector
 * FULFILLs any answer the app gives (PF-23), the HTTP status inside the
 * sealed response — not the ILP outcome — is what tells a taker its fill
 * was refused. Refusals of a *paid* fill record the payment as
 * {@link SwapRefusal.credited} and the maker applies it to the session's
 * next accepted fill.
 */

export const SWAP_WIRE_PROTOCOL = 'rolling/2';

export interface SwapWireAsset {
  assetCode: string;
  assetScale: number;
  chain: string;
}

export interface SwapWirePair {
  from: SwapWireAsset;
  to: SwapWireAsset;
}

/** `POST <rfq route>` body. */
export interface SwapRfqRequest {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'rfq';
  /** 16 bytes, lowercase hex — the session id every fill names. */
  streamNonce: string;
  pair: SwapWirePair;
  /** The taker's payout address on `pair.to.chain` — bound into every leg-B claim. */
  chainRecipient: string;
  /** Optional: how much (in `pair.from` base units) the taker intends to swap. */
  sizeHint?: string;
}

/** What the taker needs to verify and redeem a leg-B claim on `chain`. */
export interface SwapLegBTerms {
  chain: string;
  /** The maker's on-chain signer for `chain` (EVM address / Solana pubkey). */
  swapSignerAddress: string;
  /** EVM: the `RollingSwapChannel` — the EIP-712 v2 `verifyingContract`. */
  verifyingContract?: string;
  /** Solana: the payment-channel program the claim message binds (ADR 0053). */
  programId?: string;
  /** The token the claim pays out in (ERC-20 address / SPL mint). */
  token?: string;
}

/** `200` answer to an RFQ. */
export interface SwapQuote {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'quote';
  streamNonce: string;
  /** `R₀`: target whole-units per source whole-unit, decimal string. */
  rate: string;
  /** Unix ms the rate was observed. */
  rateTimestamp: number;
  /** Unix ms after which fills against this quote are refused (`quote_expired`). */
  expiresAt: number;
  fill: {
    /** ILP destination of the maker's priced fill route. */
    destination: string;
    /**
     * The fill size in `pair.from` base units — the fill route's price. May
     * be absent when the maker does not know its own route price; the
     * taker then reads it from the connector's self-description.
     */
    amount?: string;
    /** Which chain family the connector must be paid on for this pair. */
    chain: string;
  };
  /** Maker's freshness bound on its own rate feed, if it enforces one. */
  maxRateAgeMs?: number;
  /** Target-unit capacity the maker can currently issue against. */
  maxAmount?: string;
  legB: SwapLegBTerms;
}

/** `POST <fill route>` body. */
export interface SwapFillRequest {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'fill';
  streamNonce: string;
  /** 1-based, strictly sequential per session. */
  seq: number;
}

/** `200` answer to a fill: the cumulative leg-B balance proof. */
export interface SwapAdvance {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'advance';
  streamNonce: string;
  seq: number;
  /** base64 signature over the chain's balance-proof message. */
  claim: string;
  claimId?: string;
  /** EVM: bytes32 hex; Solana: the channel PDA (base58). */
  channelId: string;
  nonce: string;
  cumulativeAmount: string;
  recipient: string;
  swapSignerAddress: string;
  rate: string;
  rateTimestamp: number;
  /** What this fill was priced on: the connector-stated charge plus any credit. */
  sourceAmount: string;
  /** `⌊sourceAmount·rate⌋` in target base units — this fill's delta. */
  targetAmount: string;
  /** Source units carried over from earlier refused-but-paid fills, now applied. */
  credited?: string;
  legB: SwapLegBTerms;
  /** BIP-340 stream receipt over the quote tape (rolling-swap spec §7.2). */
  receipt?: unknown;
}

export const SWAP_REFUSAL_REASONS = {
  MALFORMED_REQUEST: 'malformed_request',
  UNKNOWN_PAIR: 'unknown_pair',
  INVALID_RECIPIENT: 'invalid_recipient',
  UNKNOWN_SESSION: 'unknown_session',
  SESSION_EXPIRED: 'session_expired',
  QUOTE_EXPIRED: 'quote_expired',
  SESSION_CONFLICT: 'session_conflict',
  UNPAID: 'unpaid',
  PAYER_MISMATCH: 'payer_mismatch',
  CHAIN_MISMATCH: 'chain_mismatch',
  SEQ_GAP: 'seq_gap',
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

/** Any non-2xx answer. `reason` is the machine discriminator. */
export interface SwapRefusal {
  proto: typeof SWAP_WIRE_PROTOCOL;
  type: 'refusal';
  reason: SwapRefusalReason;
  message: string;
  /** Whether the same request may succeed later without the taker changing it. */
  retry: boolean;
  streamNonce?: string;
  seq?: number;
  /** Total source units the maker owes this session from refused-but-paid fills. */
  credited?: string;
  detail?: Record<string, unknown>;
}

export type SwapWireAnswer = SwapQuote | SwapAdvance | SwapRefusal;

/** The HTTP status a refusal reason travels under. */
export const SWAP_REFUSAL_STATUS: Record<SwapRefusalReason, number> = {
  malformed_request: 400,
  unknown_pair: 404,
  invalid_recipient: 400,
  unknown_session: 404,
  session_expired: 410,
  quote_expired: 410,
  session_conflict: 409,
  unpaid: 402,
  payer_mismatch: 403,
  chain_mismatch: 422,
  seq_gap: 409,
  stale_rate: 503,
  rate_unavailable: 503,
  insufficient_liquidity: 503,
  fill_too_small: 422,
  channel_unredeemed: 503,
  no_channel_available: 503,
  persistence_failed: 503,
  signing_failed: 500,
  internal_error: 500,
};

const STREAM_NONCE_RE = /^[0-9a-f]{32}$/;

export function isValidStreamNonce(value: unknown): value is string {
  return typeof value === 'string' && STREAM_NONCE_RE.test(value);
}

function isAsset(v: unknown): v is SwapWireAsset {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a['assetCode'] === 'string' &&
    a['assetCode'].length > 0 &&
    typeof a['assetScale'] === 'number' &&
    Number.isInteger(a['assetScale']) &&
    a['assetScale'] >= 0 &&
    typeof a['chain'] === 'string' &&
    a['chain'].length > 0
  );
}

export type SwapWireParse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Parse and validate an RFQ body. Never throws. */
export function parseSwapRfqRequest(
  raw: unknown
): SwapWireParse<SwapRfqRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'body is not a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  if (r['proto'] !== SWAP_WIRE_PROTOCOL) {
    return { ok: false, error: `proto must be "${SWAP_WIRE_PROTOCOL}"` };
  }
  if (r['type'] !== 'rfq') return { ok: false, error: 'type must be "rfq"' };
  const streamNonce = r['streamNonce'];
  if (typeof streamNonce !== 'string') {
    return { ok: false, error: 'streamNonce must be a string' };
  }
  const nonce = streamNonce.toLowerCase();
  if (!isValidStreamNonce(nonce)) {
    return { ok: false, error: 'streamNonce must be 16 bytes of hex' };
  }
  const pair = r['pair'] as Record<string, unknown> | undefined;
  if (
    typeof pair !== 'object' ||
    pair === null ||
    !isAsset(pair['from']) ||
    !isAsset(pair['to'])
  ) {
    return { ok: false, error: 'pair.from / pair.to must be assets' };
  }
  const chainRecipient = r['chainRecipient'];
  if (typeof chainRecipient !== 'string' || chainRecipient.length === 0) {
    return { ok: false, error: 'chainRecipient must be a non-empty string' };
  }
  const sizeHint = r['sizeHint'];
  if (sizeHint !== undefined && !/^[0-9]+$/.test(String(sizeHint))) {
    return { ok: false, error: 'sizeHint must be a decimal integer string' };
  }
  return {
    ok: true,
    value: {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'rfq',
      streamNonce: nonce,
      pair: { from: pair['from'], to: pair['to'] },
      chainRecipient,
      ...(sizeHint !== undefined && { sizeHint: String(sizeHint) }),
    },
  };
}

/** Parse and validate a fill body. Never throws. */
export function parseSwapFillRequest(
  raw: unknown
): SwapWireParse<SwapFillRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'body is not a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  if (r['proto'] !== SWAP_WIRE_PROTOCOL) {
    return { ok: false, error: `proto must be "${SWAP_WIRE_PROTOCOL}"` };
  }
  if (r['type'] !== 'fill') return { ok: false, error: 'type must be "fill"' };
  const streamNonce = r['streamNonce'];
  if (typeof streamNonce !== 'string') {
    return { ok: false, error: 'streamNonce must be a string' };
  }
  const nonce = streamNonce.toLowerCase();
  if (!isValidStreamNonce(nonce)) {
    return { ok: false, error: 'streamNonce must be 16 bytes of hex' };
  }
  const seq = r['seq'];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    return { ok: false, error: 'seq must be a positive integer' };
  }
  return {
    ok: true,
    value: { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: nonce, seq },
  };
}

/** Parse a maker answer (taker side). Never throws. */
export function parseSwapWireAnswer(raw: unknown): SwapWireParse<SwapWireAnswer> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'body is not a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  if (r['proto'] !== SWAP_WIRE_PROTOCOL) {
    return { ok: false, error: `proto must be "${SWAP_WIRE_PROTOCOL}"` };
  }
  switch (r['type']) {
    case 'quote':
    case 'advance':
    case 'refusal':
      return { ok: true, value: r as unknown as SwapWireAnswer };
    default:
      return { ok: false, error: `unknown answer type ${String(r['type'])}` };
  }
}

/** The three ADR 0040 headers as the connector states them, or null. */
export interface PaymentAttribution {
  /** `evm:0x<64 hex>` or `solana:<base58>` — the leg-A channel key. */
  payer: string;
  /** What the connector charged for this packet, base units. */
  amount: bigint;
  /** `evm` | `solana`. */
  chain: 'evm' | 'solana';
}

export const PAYMENT_HEADER_PAYER = 'x-toon-payer';
export const PAYMENT_HEADER_AMOUNT = 'x-toon-amount';
export const PAYMENT_HEADER_CHAIN = 'x-toon-chain';

/**
 * Read the connector's payment attribution off a delivered request. All
 * three headers or nothing (mirrors the relay's own reader): a partial triple
 * is treated as absent rather than trusted.
 */
export function readPaymentAttribution(
  header: (name: string) => string | undefined
): PaymentAttribution | null {
  const payer = header(PAYMENT_HEADER_PAYER);
  const amount = header(PAYMENT_HEADER_AMOUNT);
  const chain = header(PAYMENT_HEADER_CHAIN);
  if (!payer || !amount || !chain) return null;
  if (chain !== 'evm' && chain !== 'solana') return null;
  if (!/^[0-9]+$/.test(amount)) return null;
  if (chain === 'evm' && !/^evm:0x[0-9a-f]{64}$/.test(payer)) return null;
  if (chain === 'solana' && !/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payer)) {
    return null;
  }
  return { payer, amount: BigInt(amount), chain };
}
