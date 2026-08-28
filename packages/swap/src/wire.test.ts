import { describe, it, expect } from 'vitest';

import {
  SWAP_WIRE_PROTOCOL,
  SWAP_REFUSAL_REASONS,
  SWAP_REFUSAL_STATUS,
  parseSwapFillRequest,
  parseSwapRfqRequest,
  parseSwapWireAnswer,
  readPaymentAttribution,
} from './wire.js';

const NONCE = 'ab'.repeat(16);
const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
};

describe('parseSwapRfqRequest', () => {
  it('accepts a well-formed RFQ and normalizes the nonce to lowercase', () => {
    const r = parseSwapRfqRequest({
      proto: SWAP_WIRE_PROTOCOL,
      type: 'rfq',
      streamNonce: NONCE.toUpperCase(),
      pair: PAIR,
      chainRecipient: 'So11111111111111111111111111111111111111112',
      sizeHint: '5000000',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.streamNonce).toBe(NONCE);
    expect(r.value.sizeHint).toBe('5000000');
  });

  it.each([
    [{}, /proto/],
    [{ proto: SWAP_WIRE_PROTOCOL, type: 'fill' }, /type/],
    [{ proto: SWAP_WIRE_PROTOCOL, type: 'rfq', streamNonce: 'zz' }, /16 bytes/],
    [
      { proto: SWAP_WIRE_PROTOCOL, type: 'rfq', streamNonce: NONCE, pair: {} },
      /pair/,
    ],
    [
      {
        proto: SWAP_WIRE_PROTOCOL,
        type: 'rfq',
        streamNonce: NONCE,
        pair: PAIR,
        chainRecipient: '',
      },
      /chainRecipient/,
    ],
    ['nope', /object/],
  ])('refuses %j', (raw, re) => {
    const r = parseSwapRfqRequest(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(re);
  });
});

describe('parseSwapFillRequest', () => {
  it('accepts seq >= 1', () => {
    const r = parseSwapFillRequest({
      proto: SWAP_WIRE_PROTOCOL,
      type: 'fill',
      streamNonce: NONCE,
      seq: 3,
    });
    expect(r.ok && r.value.seq).toBe(3);
  });
  it('refuses seq 0, negative, fractional or string', () => {
    for (const seq of [0, -1, 1.5, '1']) {
      const r = parseSwapFillRequest({
        proto: SWAP_WIRE_PROTOCOL,
        type: 'fill',
        streamNonce: NONCE,
        seq,
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe('parseSwapWireAnswer', () => {
  it('passes quotes, advances and refusals through', () => {
    for (const type of ['quote', 'advance', 'refusal']) {
      const r = parseSwapWireAnswer({ proto: SWAP_WIRE_PROTOCOL, type });
      expect(r.ok).toBe(true);
    }
    expect(parseSwapWireAnswer({ proto: SWAP_WIRE_PROTOCOL, type: 'x' }).ok).toBe(
      false
    );
  });
});

describe('readPaymentAttribution', () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name];

  it('reads the connector triple for an EVM payer', () => {
    const a = readPaymentAttribution(
      headers({
        'x-toon-payer': `evm:0x${'ab'.repeat(32)}`,
        'x-toon-amount': '1000000',
        'x-toon-chain': 'evm',
      })
    );
    expect(a).toEqual({
      payer: `evm:0x${'ab'.repeat(32)}`,
      amount: 1_000_000n,
      chain: 'evm',
    });
  });

  it('reads a Solana payer', () => {
    const a = readPaymentAttribution(
      headers({
        'x-toon-payer': 'solana:G5mXQzfZb4tXWX7cQvXP9ZJnDBcUo6irWTmGGtX3xpzL',
        'x-toon-amount': '7',
        'x-toon-chain': 'solana',
      })
    );
    expect(a?.chain).toBe('solana');
    expect(a?.amount).toBe(7n);
  });

  it('is all-or-nothing: a partial or malformed triple reads as absent', () => {
    expect(readPaymentAttribution(headers({}))).toBeNull();
    expect(
      readPaymentAttribution(
        headers({ 'x-toon-payer': 'evm:0xab', 'x-toon-amount': '1' })
      )
    ).toBeNull();
    expect(
      readPaymentAttribution(
        headers({
          'x-toon-payer': `solana:${'1'.repeat(40)}`,
          'x-toon-amount': '1',
          'x-toon-chain': 'evm', // namespace disagrees with chain
        })
      )
    ).toBeNull();
    expect(
      readPaymentAttribution(
        headers({
          'x-toon-payer': `evm:0x${'ab'.repeat(32)}`,
          'x-toon-amount': '1.5',
          'x-toon-chain': 'evm',
        })
      )
    ).toBeNull();
  });
});

describe('refusal status table', () => {
  it('maps every reason to an HTTP status outside 2xx', () => {
    for (const reason of Object.values(SWAP_REFUSAL_REASONS)) {
      const status = SWAP_REFUSAL_STATUS[reason];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});
