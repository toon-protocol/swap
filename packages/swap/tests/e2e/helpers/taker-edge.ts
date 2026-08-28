/**
 * The taker's view of the maker's Rust connector client edge —
 * `docs/protocol/client-edge-spec.md` §1.1 (framing), §1.3 (claim header),
 * §1.4 (402 greeting), §1.7 (identity), §1.8 (sealing) in toon-protocol/connector.
 *
 * One call, {@link sendSealedRequest}, does the whole exchange: seal an
 * `EnvelopeRequest` to the connector's identity key (`@toon-protocol/client`'s
 * `sealExchange` — a port of `connector_signer::giftwrap` pinned to the
 * `giftwrap`/`fulfilment` vectors), encode the PREPARE in TOON's ILP dialect,
 * POST it with the claim header, and read the sealed answer back.
 *
 * ## The PREPARE bytes (connector ADR 0063, `vectors/README.md`)
 *
 * NOT RFC 0027. No outer type-length wrapper; `amount` is a VarUInt;
 * `expiresAt` is a 19-byte GeneralizedTime `YYYYMMDDHHMMSS.fffZ`:
 *
 * ```text
 * 0x0c || VarUInt(amount) || GeneralizedTime(19) || condition(32)
 *      || VarOctetString(destination) || VarOctetString(data)
 * ```
 *
 * {@link encodeIlpPrepare} is checked against `peer_carriage.prepare.http_body_hex`
 * by the self-check. `@toon-protocol/client`'s own `HttpIlpClient` emits the
 * same dialect, but does not expose the encoder — so it is hand-rolled here
 * from the client's exported OER primitives.
 */

import {
  decodeVarOctetString,
  decodeVarUint,
  encodeVarOctetString,
  encodeVarUint,
  readExchangeOutcome,
  sealExchange,
  type EnvelopeRequest,
  type EnvelopeResponse,
} from '@toon-protocol/client';

import type { ConnectorIdentity } from './rust-connector.js';

export const ILP_PREPARE = 0x0c;
export const ILP_FULFILL = 0x0d;
export const ILP_REJECT = 0x0e;

export const CLAIM_HEADER = 'ILP-Payment-Channel-Claim';
export const ACCUMULATED_COST_HEADER = 'toon-accumulated-cost';

// ---------------------------------------------------------------------------
// Packet codec
// ---------------------------------------------------------------------------

function generalizedTime(date: Date): Uint8Array {
  const p = (n: number, w: number) => n.toString().padStart(w, '0');
  const text =
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1, 2)}${p(date.getUTCDate(), 2)}` +
    `${p(date.getUTCHours(), 2)}${p(date.getUTCMinutes(), 2)}${p(date.getUTCSeconds(), 2)}` +
    `.${p(date.getUTCMilliseconds(), 3)}Z`;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length !== 19) throw new Error(`GeneralizedTime is ${bytes.length} bytes, not 19`);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface IlpPrepare {
  amount: bigint;
  expiresAt: Date;
  /** 32 bytes. */
  executionCondition: Uint8Array;
  destination: string;
  data: Uint8Array;
}

export function encodeIlpPrepare(p: IlpPrepare): Uint8Array {
  if (p.executionCondition.length !== 32) {
    throw new Error(`executionCondition must be 32 bytes, got ${p.executionCondition.length}`);
  }
  return concat(
    new Uint8Array([ILP_PREPARE]),
    encodeVarUint(p.amount),
    generalizedTime(p.expiresAt),
    p.executionCondition,
    encodeVarOctetString(new TextEncoder().encode(p.destination)),
    encodeVarOctetString(p.data)
  );
}

export type IlpPacket =
  | { type: 'fulfill'; fulfillment: Uint8Array; data: Uint8Array }
  | { type: 'reject'; code: string; triggeredBy: string; message: string; data: Uint8Array };

export function decodeIlpPacket(buf: Uint8Array): IlpPacket {
  if (buf.length === 0) throw new Error('empty ILP packet');
  const type = buf[0];
  const dec = new TextDecoder();
  if (type === ILP_FULFILL) {
    if (buf.length < 33) throw new Error('FULFILL underflow');
    const fulfillment = buf.slice(1, 33);
    const data = decodeVarOctetString(buf, 33);
    if (33 + data.consumed !== buf.length) throw new Error('FULFILL trailing bytes');
    return { type: 'fulfill', fulfillment, data: data.value };
  }
  if (type === ILP_REJECT) {
    let o = 1;
    const code = dec.decode(buf.slice(o, o + 3));
    o += 3;
    const tb = decodeVarOctetString(buf, o);
    o += tb.consumed;
    const msg = decodeVarOctetString(buf, o);
    o += msg.consumed;
    const data = decodeVarOctetString(buf, o);
    o += data.consumed;
    if (o !== buf.length) throw new Error('REJECT trailing bytes');
    return {
      type: 'reject',
      code,
      triggeredBy: dec.decode(tb.value),
      message: dec.decode(msg.value),
      data: data.value,
    };
  }
  throw new Error(`unknown ILP packet type 0x${(type ?? 0).toString(16)}`);
}

/** Decode a PREPARE (for asserting our own encoding round-trips). */
export function decodeIlpPrepare(buf: Uint8Array): IlpPrepare {
  if (buf[0] !== ILP_PREPARE) throw new Error('not a PREPARE');
  let o = 1;
  const amount = decodeVarUint(buf, o);
  o += amount.consumed;
  const text = new TextDecoder().decode(buf.slice(o, o + 19));
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/.exec(text);
  if (!m) throw new Error(`malformed GeneralizedTime "${text}"`);
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number);
  const expiresAt = new Date(
    Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0, ms ?? 0)
  );
  o += 19;
  const executionCondition = buf.slice(o, o + 32);
  o += 32;
  const dest = decodeVarOctetString(buf, o);
  o += dest.consumed;
  const data = decodeVarOctetString(buf, o);
  o += data.consumed;
  if (o !== buf.length) throw new Error('PREPARE trailing bytes');
  return {
    amount: amount.value,
    expiresAt,
    executionCondition,
    destination: new TextDecoder().decode(dest.value),
    data: data.value,
  };
}

// ---------------------------------------------------------------------------
// Identity / description
// ---------------------------------------------------------------------------

export function connectorPublicKeyBytes(publicKey: string): Uint8Array {
  const hex = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error(`connector publicKey must be 65 uncompressed secp256k1 bytes (0x04…), got ${bytes.length}`);
  }
  return bytes;
}

/** `GET /ilp/identity` — the key to seal to (§1.7). */
export async function describeConnector(url: string): Promise<ConnectorIdentity> {
  const res = await fetch(`${url.replace(/\/$/, '')}/ilp/identity`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GET /ilp/identity → HTTP ${res.status}`);
  const json = (await res.json()) as ConnectorIdentity;
  connectorPublicKeyBytes(json.publicKey);
  return json;
}

/** `GET /ilp/routes/price?destination=` — `null` on 404 (§1.7). */
export async function connectorRoutePrice(
  url: string,
  destination: string
): Promise<{ destination: string; price: number; price_per_kib?: number } | null> {
  const res = await fetch(
    `${url.replace(/\/$/, '')}/ilp/routes/price?destination=${encodeURIComponent(destination)}`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /ilp/routes/price → HTTP ${res.status}`);
  return (await res.json()) as { destination: string; price: number; price_per_kib?: number };
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

export interface SendSealedRequestParams {
  connectorUrl: string;
  /** `0x04…` hex (from {@link describeConnector}) or the 65 raw bytes. */
  connectorPublicKey: string | Uint8Array;
  destination: string;
  amount: bigint | number;
  envelope: EnvelopeRequest;
  /** A spec §1.3 claim object; omitted = unpaid. */
  claim?: object;
  /** Default 60s. */
  expiresInMs?: number;
  /** Extra HTTP headers (e.g. `ILP-Peer-Id` + `Authorization`). */
  headers?: Record<string, string>;
}

export type SealedRequestOutcome =
  | {
      kind: 'fulfill';
      response: { status: number; headers: readonly (readonly [string, string])[]; body: Uint8Array };
      fulfillment: Uint8Array;
    }
  | {
      kind: 'reject';
      code: string;
      message: string;
      triggeredBy: string;
      data: Uint8Array;
      accumulatedCost: bigint | null;
      /** `destination` when the reject was sealed with our secret (§1.8), else `path`. */
      origin: 'destination' | 'path';
    }
  | {
      /** HTTP 402 — an unpaid request to a priced route (§1.4). Not an ILP outcome. */
      kind: 'payment-required';
      status: 402;
      terms: unknown;
    }
  | { kind: 'http-error'; status: number; body: string };

/**
 * Seal `envelope` to the connector, POST it as a PREPARE to `destination`,
 * and read the answer. A FULFILL's body is the app's response opened with
 * the exchange's own secret; its preimage is checked against the condition
 * we minted. A REJECT is classified by origin (§1.8).
 */
export async function sendSealedRequest(params: SendSealedRequestParams): Promise<SealedRequestOutcome> {
  const pub =
    typeof params.connectorPublicKey === 'string'
      ? connectorPublicKeyBytes(params.connectorPublicKey)
      : params.connectorPublicKey;
  const sealed = sealExchange(params.envelope, pub);
  const body = encodeIlpPrepare({
    amount: BigInt(params.amount),
    expiresAt: new Date(Date.now() + (params.expiresInMs ?? 60_000)),
    executionCondition: sealed.condition,
    destination: params.destination,
    data: sealed.data,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    ...(params.headers ?? {}),
  };
  if (params.claim) {
    headers[CLAIM_HEADER] = Buffer.from(JSON.stringify(params.claim), 'utf8').toString('base64');
  }

  const res = await fetch(`${params.connectorUrl.replace(/\/$/, '')}/ilp`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout((params.expiresInMs ?? 60_000) + 5000),
  });

  if (res.status === 402) {
    return { kind: 'payment-required', status: 402, terms: await res.json() };
  }
  if (res.status !== 200) {
    return { kind: 'http-error', status: res.status, body: await res.text() };
  }

  const packet = decodeIlpPacket(new Uint8Array(await res.arrayBuffer()));
  if (packet.type === 'fulfill') {
    if (Buffer.compare(packet.fulfillment, sealed.fulfillment) !== 0) {
      throw new Error('FULFILL preimage does not match the fulfilment derived from our shared secret');
    }
    const outcome = readExchangeOutcome({ accepted: true }, packet.data, sealed.sharedSecret);
    if (outcome.kind !== 'answered') {
      throw new Error(`FULFILL classified as ${outcome.kind}`);
    }
    const r: EnvelopeResponse = outcome.response;
    return {
      kind: 'fulfill',
      response: { status: r.status, headers: r.headers, body: r.body },
      fulfillment: packet.fulfillment,
    };
  }

  const costHeader = res.headers.get(ACCUMULATED_COST_HEADER);
  const outcome = readExchangeOutcome(
    { accepted: false, code: packet.code, message: packet.message },
    packet.data,
    sealed.sharedSecret
  );
  return {
    kind: 'reject',
    code: packet.code,
    message: packet.message,
    triggeredBy: packet.triggeredBy,
    data: outcome.kind === 'destination-refused' ? outcome.detail : packet.data,
    accumulatedCost: costHeader === null ? null : BigInt(costHeader),
    origin: outcome.kind === 'destination-refused' ? 'destination' : 'path',
  };
}

/** Convenience: the app's response body as UTF-8. */
export function fulfillBodyText(outcome: SealedRequestOutcome): string {
  if (outcome.kind !== 'fulfill') throw new Error(`expected fulfill, got ${outcome.kind}`);
  return new TextDecoder().decode(outcome.response.body);
}
