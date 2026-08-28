/**
 * The taker's durable state: one JSON file, atomic rename, written
 * write-ahead — the same discipline `state-store.ts` gives the maker.
 *
 * What must never regress is the taker's OWN outbound leg-A watermark
 * (`legA.nonce` / `legA.cumulative`): a claim it signed is money the maker
 * holds, so a restart that forgot it would sign a lower nonce the maker
 * refuses forever. `lastFill` is therefore written BEFORE the fill is
 * published. Everything else (the quote, the last advance, the inbound
 * watermark on the maker's leg-B claims) is what lets `resume()` decide where
 * a stream stands without asking anyone but the relay.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type {
  SwapAdvance,
  SwapClaim,
  SwapOrder,
  SwapQuote,
  SwapRefusal,
} from './wire.js';

export interface TakerSessionState {
  streamNonce: string;
  orderId: string;
  /** The maker's Nostr pubkey (the order's author) — every wrap goes to it. */
  makerPubkey: string;
  /** The order as read — pins legA/legB facts for the whole session. */
  order: SwapOrder;
  /** The latest quote (refreshed on resume). */
  quote: SwapQuote | null;
  /** How much (source base units) this session intends to swap. */
  size: string;
  /** The per-fill delta this taker uses, within the order's bounds. */
  delta: string;
  /** The taker's payout address on the target chain. */
  chainRecipient: string;
  /** The taker's address on the source chain. */
  payerAddress: string;
  /**
   * My outbound leg-A watermark for this session — never regresses, and is
   * mirrored on the channel record every session on that channel shares.
   * `startCumulative` is the channel cumulative when this session began;
   * `acceptedCumulative` that of the last fill the maker answered (advance or
   * credited refusal): the difference is what this session has sent.
   */
  legA: {
    chain: string;
    channelId: string | null;
    nonce: string;
    cumulative: string;
    startCumulative?: string;
    acceptedCumulative?: string;
  };
  lastFill: {
    seq: number;
    claim: SwapClaim;
    eventId: string;
    sentAt: number;
  } | null;
  lastAdvance: { seq: number; advance: SwapAdvance; eventId: string } | null;
  lastRefusal: { seq: number; refusal: SwapRefusal; eventId: string } | null;
  /** My inbound watermark on the maker's leg-B claims. */
  received: {
    chain: string;
    channelId: string;
    nonce: string;
    cumulative: string;
    signer: string;
    deposit?: string;
    depositReadAt?: number;
    epoch?: string;
  } | null;
  /** Source units the maker owes from refused-but-paid fills (from its refusals). */
  credit: string;
  status: 'quoting' | 'filling' | 'done' | 'aborted';
  createdAt: number;
  updatedAt: number;
  /** Set once a redeem transaction landed. */
  redeemed?: { txId: string; cumulative: string; at: number };
}

/** My outbound watermark on one leg-A channel — shared by every session on it, never regresses. */
export interface TakerChannelWatermark {
  chain: string;
  channelId: string;
  counterparty: string;
  nonce: string;
  cumulative: string;
  updatedAt: number;
}

/** My inbound watermark on one leg-B channel — shared by every session on it. */
export interface TakerInboundWatermark {
  chain: string;
  channelId: string;
  signer: string;
  nonce: string;
  cumulative: string;
  deposit?: string;
  depositReadAt?: number;
  epoch?: string;
  updatedAt: number;
}

export interface PersistedTakerState {
  version: 1;
  sessions: Record<string, TakerSessionState>;
  /** `${chain}:${channelId}` → my outbound watermark. */
  channels: Record<string, TakerChannelWatermark>;
  /** `${chain}:${channelId}` → my inbound watermark on the maker's claims. */
  inbound: Record<string, TakerInboundWatermark>;
  /** Unix seconds: the newest inbox wrap processed. */
  relayCursor: number;
  seenEventIds: string[];
}

export interface TakerStateStore {
  load(): PersistedTakerState | null;
  save(state: PersistedTakerState): void;
}

export function emptyTakerState(): PersistedTakerState {
  return {
    version: 1,
    sessions: {},
    channels: {},
    inbound: {},
    relayCursor: 0,
    seenEventIds: [],
  };
}

export class JsonFileTakerStateStore implements TakerStateStore {
  readonly #path: string;
  constructor(path: string) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('JsonFileTakerStateStore requires a non-empty file path');
    }
    this.#path = path;
  }

  load(): PersistedTakerState | null {
    if (!existsSync(this.#path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#path, 'utf-8'));
    } catch (err) {
      throw new Error(
        `taker state file ${this.#path} is unreadable or corrupt; refusing to boot with a reset watermark (${err instanceof Error ? err.message : String(err)})`
      );
    }
    return validateTakerState(raw);
  }

  save(state: PersistedTakerState): void {
    const tmp = `${this.#path}.tmp`;
    mkdirSync(dirname(this.#path), { recursive: true });
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(state, null, 2), null, 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.#path);
  }
}

export class InMemoryTakerStateStore implements TakerStateStore {
  #state: PersistedTakerState | null = null;
  load(): PersistedTakerState | null {
    return this.#state
      ? (JSON.parse(JSON.stringify(this.#state)) as PersistedTakerState)
      : null;
  }
  save(state: PersistedTakerState): void {
    this.#state = JSON.parse(JSON.stringify(state)) as PersistedTakerState;
  }
}

function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

export function validateTakerState(raw: unknown): PersistedTakerState {
  if (typeof raw !== 'object' || raw === null)
    throw new Error('taker state must be an object');
  const rec = raw as Record<string, unknown>;
  if (rec['version'] !== 1)
    throw new Error(
      `unsupported taker state version ${JSON.stringify(rec['version'])}`
    );
  const sessionsRaw = rec['sessions'] ?? {};
  if (
    typeof sessionsRaw !== 'object' ||
    sessionsRaw === null ||
    Array.isArray(sessionsRaw)
  ) {
    throw new Error('taker state.sessions must be an object');
  }
  const sessions: Record<string, TakerSessionState> = Object.create(
    null
  ) as Record<string, TakerSessionState>;
  for (const [k, v] of Object.entries(
    sessionsRaw as Record<string, TakerSessionState>
  )) {
    if (isUnsafeKey(k))
      throw new Error(`unsafe key "${k}" in taker state.sessions`);
    if (
      typeof v?.streamNonce !== 'string' ||
      typeof v?.makerPubkey !== 'string'
    ) {
      throw new Error(
        `taker state.sessions["${k}"] must carry streamNonce and makerPubkey`
      );
    }
    for (const field of [
      v.legA?.nonce,
      v.legA?.cumulative,
      v.size,
      v.delta,
      v.credit,
    ]) {
      if (typeof field !== 'string')
        throw new Error(
          `taker state.sessions["${k}"] has a non-string bigint field`
        );
      BigInt(field);
    }
    sessions[k] = v;
  }
  const channelsRaw = rec['channels'] ?? {};
  if (
    typeof channelsRaw !== 'object' ||
    channelsRaw === null ||
    Array.isArray(channelsRaw)
  ) {
    throw new Error('taker state.channels must be an object');
  }
  const channels: Record<string, TakerChannelWatermark> = Object.create(
    null
  ) as Record<string, TakerChannelWatermark>;
  for (const [k, v] of Object.entries(
    channelsRaw as Record<string, TakerChannelWatermark>
  )) {
    if (isUnsafeKey(k))
      throw new Error(`unsafe key "${k}" in taker state.channels`);
    if (
      typeof v?.channelId !== 'string' ||
      typeof v?.nonce !== 'string' ||
      typeof v?.cumulative !== 'string'
    ) {
      throw new Error(
        `taker state.channels["${k}"] must carry channelId/nonce/cumulative`
      );
    }
    BigInt(v.nonce);
    BigInt(v.cumulative);
    channels[k] = v;
  }
  const inboundRaw = rec['inbound'] ?? {};
  if (
    typeof inboundRaw !== 'object' ||
    inboundRaw === null ||
    Array.isArray(inboundRaw)
  ) {
    throw new Error('taker state.inbound must be an object');
  }
  const inbound: Record<string, TakerInboundWatermark> = Object.create(
    null
  ) as Record<string, TakerInboundWatermark>;
  for (const [k, v] of Object.entries(
    inboundRaw as Record<string, TakerInboundWatermark>
  )) {
    if (isUnsafeKey(k))
      throw new Error(`unsafe key "${k}" in taker state.inbound`);
    if (
      typeof v?.channelId !== 'string' ||
      typeof v?.nonce !== 'string' ||
      typeof v?.cumulative !== 'string'
    ) {
      throw new Error(
        `taker state.inbound["${k}"] must carry channelId/nonce/cumulative`
      );
    }
    BigInt(v.nonce);
    BigInt(v.cumulative);
    inbound[k] = v;
  }
  const cursor = rec['relayCursor'] ?? 0;
  if (typeof cursor !== 'number' || !Number.isFinite(cursor) || cursor < 0) {
    throw new Error('taker state.relayCursor must be a non-negative number');
  }
  const seen = rec['seenEventIds'] ?? [];
  if (!Array.isArray(seen) || seen.some((s) => typeof s !== 'string')) {
    throw new Error('taker state.seenEventIds must be an array of strings');
  }
  return {
    version: 1,
    sessions,
    channels,
    inbound,
    relayCursor: cursor,
    seenEventIds: [...(seen as string[])],
  };
}
