/**
 * Tests for `buildSettlementEvent()` — Story D3 AC-D3-1, AC-D3-4.
 *
 * Asserts the SettlementEvent fixture has `txHash` + `chain` for both EVM
 * and Solana paths, and that EVM hashes are normalized to lowercase 0x.
 */

import { describe, it, expect } from 'vitest';

import {
  buildSettlementEvent,
  type SettlementEvent,
} from './settlement-event.js';

const EVM_TX_HASH =
  '0xabc1234567890123456789012345678901234567890123456789012345678901';
const EVM_TX_HASH_MIXED_CASE =
  '0xABC1234567890123456789012345678901234567890123456789012345678901';
const EVM_CHANNEL_ID = '0xfeedface00000000000000000000000000000000';
const EVM_RECIPIENT = '0x1111111111111111111111111111111111111111';

// 88-char base58 signature is the typical Solana confirmed-signature length.
const SOLANA_TX_HASH =
  '5VfYmfXkVuPkH4XJYUogWQabXpvF9DAxwLhx1HpTphQ5Yh8WqYwZxSEAuwTk7TuY1zXZF7L9DX2pRuNMC5xuKvaP';
const SOLANA_CHANNEL_ID = '8r2YBvgNYmTXbaUZqczD7TxfzBxtHzFx7sYGm9hg9HzQ';
const SOLANA_RECIPIENT = '4Nd1mFuuy3HRKFWvhd8L9pmLTCnD4kdWkJWj7QVAwfDF';

describe('Story D3 AC-D3-1, AC-D3-4 — buildSettlementEvent (EVM path)', () => {
  it('[P0] (T-D3-1) builds a SettlementEvent with txHash + chain="evm"', () => {
    const event = buildSettlementEvent({
      txHash: EVM_TX_HASH,
      chain: 'evm',
      channelId: EVM_CHANNEL_ID,
      cumulativeAmount: '1000000',
      nonce: '1',
      recipient: EVM_RECIPIENT,
      settledAt: 1700000000000,
    });

    expect(event.txHash).toBe(EVM_TX_HASH);
    expect(event.chain).toBe('evm');
    expect(event.channelId).toBe(EVM_CHANNEL_ID);
    expect(event.cumulativeAmount).toBe('1000000');
    expect(event.nonce).toBe('1');
    expect(event.recipient).toBe(EVM_RECIPIENT);
    expect(event.settledAt).toBe(1700000000000);
  });

  it('[P0] normalizes mixed-case EVM txHash to lowercase (matches viem)', () => {
    const event = buildSettlementEvent({
      txHash: EVM_TX_HASH_MIXED_CASE,
      chain: 'evm',
      channelId: EVM_CHANNEL_ID,
      cumulativeAmount: 1000000n,
      nonce: 1n,
      recipient: EVM_RECIPIENT,
    });
    expect(event.txHash).toBe(EVM_TX_HASH);
    expect(event.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('[P1] accepts bigint cumulativeAmount and nonce (decimal-string normalized)', () => {
    const event = buildSettlementEvent({
      txHash: EVM_TX_HASH,
      chain: 'evm',
      channelId: EVM_CHANNEL_ID,
      cumulativeAmount: 12345678901234567890n,
      nonce: 42n,
      recipient: EVM_RECIPIENT,
    });
    expect(event.cumulativeAmount).toBe('12345678901234567890');
    expect(event.nonce).toBe('42');
  });

  it('[P1] rejects malformed EVM txHash (wrong length)', () => {
    expect(() =>
      buildSettlementEvent({
        txHash: '0xabc',
        chain: 'evm',
        channelId: EVM_CHANNEL_ID,
        cumulativeAmount: '1',
        nonce: '1',
        recipient: EVM_RECIPIENT,
      })
    ).toThrow(/EVM txHash must be 0x-prefixed 32-byte hex/);
  });
});

describe('Story D3 AC-D3-1, AC-D3-4 — buildSettlementEvent (Solana path)', () => {
  it('[P0] (T-D3-2) builds a SettlementEvent with base58 txHash + chain="solana"', () => {
    const event = buildSettlementEvent({
      txHash: SOLANA_TX_HASH,
      chain: 'solana',
      channelId: SOLANA_CHANNEL_ID,
      cumulativeAmount: '500000',
      nonce: '7',
      recipient: SOLANA_RECIPIENT,
      settledAt: 1700000001000,
    });

    expect(event.txHash).toBe(SOLANA_TX_HASH);
    expect(event.chain).toBe('solana');
    expect(event.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(event.txHash.length).toBeGreaterThanOrEqual(64);
    expect(event.channelId).toBe(SOLANA_CHANNEL_ID);
    expect(event.recipient).toBe(SOLANA_RECIPIENT);
    expect(event.settledAt).toBe(1700000001000);
  });

  it('[P1] does NOT lowercase Solana txHash (base58 is case-sensitive)', () => {
    // SOLANA_TX_HASH contains both upper- and lowercase chars; normalizing
    // would corrupt the signature.
    const event = buildSettlementEvent({
      txHash: SOLANA_TX_HASH,
      chain: 'solana',
      channelId: SOLANA_CHANNEL_ID,
      cumulativeAmount: '1',
      nonce: '1',
      recipient: SOLANA_RECIPIENT,
    });
    expect(event.txHash).toBe(SOLANA_TX_HASH); // exact, no case change
  });

  it('[P1] rejects malformed Solana txHash (too short)', () => {
    expect(() =>
      buildSettlementEvent({
        txHash: 'abc',
        chain: 'solana',
        channelId: SOLANA_CHANNEL_ID,
        cumulativeAmount: '1',
        nonce: '1',
        recipient: SOLANA_RECIPIENT,
      })
    ).toThrow(/Solana txHash must be base58/);
  });
});

describe('Story D3 — buildSettlementEvent input validation', () => {
  it('[P2] defaults settledAt to Date.now() when omitted', () => {
    const before = Date.now();
    const event = buildSettlementEvent({
      txHash: EVM_TX_HASH,
      chain: 'evm',
      channelId: EVM_CHANNEL_ID,
      cumulativeAmount: '1',
      nonce: '1',
      recipient: EVM_RECIPIENT,
    });
    const after = Date.now();
    expect(event.settledAt).toBeGreaterThanOrEqual(before);
    expect(event.settledAt).toBeLessThanOrEqual(after);
  });

  it('[P2] rejects unsupported chain', () => {
    expect(() =>
      buildSettlementEvent({
        txHash: EVM_TX_HASH,
        // @ts-expect-error — testing runtime guard for non-typed callers
        chain: 'mina',
        channelId: 'B62qabc',
        cumulativeAmount: '1',
        nonce: '1',
        recipient: 'B62qrecipient',
      })
    ).toThrow(/unsupported chain/);
  });

  it('[P2] event shape is structurally compatible with the SettlementEvent type', () => {
    const event: SettlementEvent = buildSettlementEvent({
      txHash: EVM_TX_HASH,
      chain: 'evm',
      channelId: EVM_CHANNEL_ID,
      cumulativeAmount: '1',
      nonce: '1',
      recipient: EVM_RECIPIENT,
    });
    // All seven documented fields must be present.
    expect(Object.keys(event).sort()).toEqual(
      [
        'chain',
        'channelId',
        'cumulativeAmount',
        'nonce',
        'recipient',
        'settledAt',
        'txHash',
      ].sort()
    );
  });
});
