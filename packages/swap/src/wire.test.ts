import { describe, expect, it } from 'vitest';

import {
  SWAP_ORDER_KIND,
  SWAP_RUMOR_KIND,
  SWAP_WIRE_PROTOCOL,
  attributionPayerKey,
  parseSwapAccept,
  parseSwapClaim,
  parseSwapFill,
  parseSwapOrder,
  parseSwapTakerMessage,
  parseSwapWireAnswer,
} from './wire.js';

const NONCE = 'ab'.repeat(16);
const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
};
const LEG_A = {
  chain: 'evm:84532',
  swapSignerAddress: '0x' + 'ab'.repeat(20),
  verifyingContract: '0x' + 'cd'.repeat(20),
  token: '0x' + 'ef'.repeat(20),
};
const LEG_B = {
  chain: 'solana:devnet',
  swapSignerAddress: 'So11111111111111111111111111111111111111112',
  programId: 'So11111111111111111111111111111111111111112',
};
const CLAIM = {
  chain: 'evm:84532',
  channelId: '0x' + '11'.repeat(32),
  nonce: '1',
  cumulativeAmount: '1000',
  signature: Buffer.alloc(65).toString('base64'),
  signer: '0x' + '22'.repeat(20),
};

describe('kinds', () => {
  it('order is addressable, rumor is ephemeral-range', () => {
    expect(SWAP_ORDER_KIND).toBeGreaterThanOrEqual(30000);
    expect(SWAP_ORDER_KIND).toBeLessThan(40000);
    expect(SWAP_RUMOR_KIND).toBeGreaterThanOrEqual(20000);
    expect(SWAP_RUMOR_KIND).toBeLessThan(30000);
  });
});

describe('parseSwapOrder', () => {
  const order = {
    proto: SWAP_WIRE_PROTOCOL,
    type: 'order',
    orderId: 'USDC:evm:84532>USDC:solana:devnet',
    pair: PAIR,
    rate: '0.99',
    rateTimestamp: 1,
    fill: { min: '1000', max: '100000' },
    maxAmount: '5000000',
    legA: LEG_A,
    legB: LEG_B,
    expiresAt: 2,
  };
  it('accepts a well-formed order', () => {
    const r = parseSwapOrder(order);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fill).toEqual({ min: '1000', max: '100000' });
  });
  it.each([
    [{ ...order, fill: { min: '0', max: '1' } }, /positive/],
    [{ ...order, fill: { min: '10', max: '1' } }, /max/],
    [{ ...order, rate: '-1' }, /rate/],
    [{ ...order, legA: { chain: 'x' } }, /legA/],
    [{ ...order, proto: 'rolling/2' }, /proto/],
  ])('refuses %j', (raw, re) => {
    const r = parseSwapOrder(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });
});

describe('parseSwapAccept', () => {
  const accept = {
    proto: SWAP_WIRE_PROTOCOL,
    type: 'accept',
    orderId: 'o1',
    streamNonce: NONCE.toUpperCase(),
    pair: PAIR,
    chainRecipient: 'So11111111111111111111111111111111111111112',
    payer: { chain: 'evm:84532', address: '0x' + '22'.repeat(20) },
    sizeHint: '5000000',
    resume: true,
  };
  it('accepts and normalizes the nonce', () => {
    const r = parseSwapAccept(accept);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.streamNonce).toBe(NONCE);
    expect(r.value.resume).toBe(true);
    expect(r.value.payer.address).toBe('0x' + '22'.repeat(20));
  });
  it.each([
    [{ ...accept, streamNonce: 'zz' }, /16 bytes/],
    [{ ...accept, payer: {} }, /payer/],
    [{ ...accept, chainRecipient: '' }, /chainRecipient/],
    [{ ...accept, resume: 'yes' }, /resume/],
  ])('refuses %j', (raw, re) => {
    const r = parseSwapAccept(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });
});

describe('parseSwapFill / parseSwapClaim', () => {
  it('accepts a fill with a shaped claim', () => {
    const r = parseSwapFill({
      proto: SWAP_WIRE_PROTOCOL,
      type: 'fill',
      streamNonce: NONCE,
      seq: 3,
      claim: CLAIM,
    });
    expect(r.ok && r.value.seq).toBe(3);
    expect(r.ok && r.value.claim.cumulativeAmount).toBe('1000');
  });
  it('refuses seq 0 and a claim with a non-decimal cumulative', () => {
    expect(
      parseSwapFill({
        proto: SWAP_WIRE_PROTOCOL,
        type: 'fill',
        streamNonce: NONCE,
        seq: 0,
        claim: CLAIM,
      }).ok
    ).toBe(false);
    const bad = parseSwapClaim({ ...CLAIM, cumulativeAmount: '1e3' });
    expect(!bad.ok && bad.error).toMatch(/cumulativeAmount/);
  });
});

describe('parseSwapTakerMessage', () => {
  it('dispatches on type', () => {
    expect(
      parseSwapTakerMessage({
        proto: SWAP_WIRE_PROTOCOL,
        type: 'done',
        streamNonce: NONCE,
        lastSeq: 4,
      }).ok
    ).toBe(true);
    expect(
      parseSwapTakerMessage({ proto: SWAP_WIRE_PROTOCOL, type: 'quote' }).ok
    ).toBe(false);
  });
});

describe('parseSwapWireAnswer', () => {
  it('checks a quote and an advance, passes a refusal', () => {
    const quote = parseSwapWireAnswer({
      proto: SWAP_WIRE_PROTOCOL,
      type: 'quote',
      streamNonce: NONCE,
      orderId: 'o1',
      rate: '1',
      rateTimestamp: 1,
      expiresAt: 2,
      fill: { min: '1', max: '2', chain: 'evm:84532' },
      lastSeq: 0,
      legA: LEG_A,
      legB: LEG_B,
    });
    expect(quote.ok).toBe(true);
    const advance = parseSwapWireAnswer({
      proto: SWAP_WIRE_PROTOCOL,
      type: 'advance',
      streamNonce: NONCE,
      seq: 1,
      claim: CLAIM,
      recipient: 'x',
      rate: '1',
      rateTimestamp: 1,
      sourceAmount: '1000',
      targetAmount: '990',
      legB: LEG_B,
    });
    expect(advance.ok).toBe(true);
    const noClaim = parseSwapWireAnswer({
      proto: SWAP_WIRE_PROTOCOL,
      type: 'advance',
      streamNonce: NONCE,
      seq: 1,
      sourceAmount: '1',
      targetAmount: '1',
    });
    expect(!noClaim.ok && noClaim.error).toMatch(/advance\.claim/);
    expect(
      parseSwapWireAnswer({
        proto: SWAP_WIRE_PROTOCOL,
        type: 'refusal',
        reason: 'seq_gap',
        message: 'm',
        retry: false,
      }).ok
    ).toBe(true);
    expect(
      parseSwapWireAnswer({ proto: SWAP_WIRE_PROTOCOL, type: 'x' }).ok
    ).toBe(false);
  });
});

describe('attributionPayerKey', () => {
  it('lowercases EVM channel ids and leaves Solana PDAs alone', () => {
    expect(attributionPayerKey('evm', '0xAB')).toBe('evm:0xab');
    expect(attributionPayerKey('solana', 'GLg')).toBe('solana:GLg');
  });
});
