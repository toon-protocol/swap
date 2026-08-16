/**
 * swap#136 — unit coverage for the claim-refusal classifier and the
 * `onFailure` mapper it feeds into the SDK swap handler (SDK ≥ 3.2.0).
 *
 * The end-to-end proof (a real gift-wrapped swap producing a logged,
 * actionable refusal) lives in `swap-node.claim-refusal.test.ts`; this file
 * pins the per-condition mapping and which stages the mapper claims.
 */
import { describe, it, expect, vi } from 'vitest';

import type { SwapHandlerFailure } from '@toon-protocol/sdk';

import {
  CLAIM_REFUSAL_REASONS,
  classifyClaimIssuerError,
  buildClaimRefusalReject,
  createClaimRefusalMapper,
} from './claim-refusal.js';
import { SwapWalletError, SwapInventoryError } from './errors.js';

/** The SDK's opaque catch-all, verbatim. */
const GENERIC_DEFAULT = { code: 'T00', message: 'Internal error' };

function unredeemedError(channelId = '0x0124a370', unredeemed = 1_000n) {
  return new SwapWalletError(
    'UNSUPPORTED_CHAIN',
    `No channel provisioned for sender on evm:8453 — 1 bound channel(s) are not safe to rebind (${channelId}: ${unredeemed} unredeemed).`,
    {
      details: {
        reason: CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED,
        chain: 'evm:8453',
        assetCode: 'USDC',
        refusals: [{ channelId, reason: 'unredeemed', unredeemed }],
      },
    }
  );
}

describe('classifyClaimIssuerError', () => {
  it('[P0] unredeemed channel → T04/insufficient_funds, naming the channel and the delta', () => {
    const refusal = classifyClaimIssuerError(unredeemedError());
    expect(refusal.reason).toBe(CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED);
    expect(refusal.code).toBe('T04');
    expect(refusal.semantic).toBe('insufficient_funds');
    expect(refusal.level).toBe('warn');
    expect(refusal.message).toContain('0x0124a370');
    expect(refusal.message).toContain('1000');
    expect(refusal.message.toLowerCase()).toContain('redeem');
    expect(refusal.detail).toMatchObject({
      channelId: '0x0124a370',
      unredeemed: '1000',
      chain: 'evm:8453',
    });
  });

  it('[P0] no channel provisioned at all → F99/application_error (retrying cannot help)', () => {
    const refusal = classifyClaimIssuerError(
      new SwapWalletError('UNSUPPORTED_CHAIN', 'No channel provisioned', {
        details: {
          reason: CLAIM_REFUSAL_REASONS.NO_CHANNEL_AVAILABLE,
          chain: 'evm:8453',
        },
      })
    );
    expect(refusal.reason).toBe(CLAIM_REFUSAL_REASONS.NO_CHANNEL_AVAILABLE);
    expect(refusal.code).toBe('F99');
    expect(refusal.semantic).toBe('application_error');
  });

  it('[P1] persist / signing failures stay T00 but stop saying "Internal error"', () => {
    const persist = classifyClaimIssuerError(
      new SwapWalletError('PERSISTENCE_FAILED', 'write-ahead persist failed')
    );
    expect(persist.reason).toBe(CLAIM_REFUSAL_REASONS.PERSIST_FAILED);
    expect(persist.code).toBe('T00');
    expect(persist.level).toBe('error');
    expect(persist.message).not.toBe('Internal error');

    const signing = classifyClaimIssuerError(
      new SwapWalletError('SIGNING_FAILED', 'Balance-proof signing failed')
    );
    expect(signing.reason).toBe(CLAIM_REFUSAL_REASONS.SIGNING_FAILED);
    expect(signing.message).toContain('sign');
  });

  it('[P1] an unrecognised throw still carries its message out', () => {
    const refusal = classifyClaimIssuerError(new Error('kaboom'));
    expect(refusal.reason).toBe(CLAIM_REFUSAL_REASONS.CLAIM_ISSUE_FAILED);
    expect(refusal.message).toContain('kaboom');
  });
});

describe('buildClaimRefusalReject', () => {
  it('[P0] carries reason + numbers in base64-JSON `data` and sets rejectReason', () => {
    const reject = buildClaimRefusalReject(
      classifyClaimIssuerError(unredeemedError())
    );
    expect(reject.accept).toBe(false);
    expect(reject.code).toBe('T04');
    expect(reject.rejectReason).toEqual({
      code: 'insufficient_funds',
      message: reject.message,
    });
    const data = JSON.parse(
      Buffer.from(reject.data, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect(data['reason']).toBe(CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED);
    expect(data['unredeemed']).toBe('1000');
  });
});

describe('createClaimRefusalMapper (SDK onFailure seam)', () => {
  const PAIR = {
    from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
    to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
    rate: '1.0',
  };

  /** A `SwapHandlerFailure` shaped exactly as the SDK hands it over. */
  function failure(
    stage: SwapHandlerFailure['stage'],
    error: unknown,
    overrides: {
      defaultRejection?: { code: string; message: string };
      claimIssued?: boolean;
      claimId?: string;
    } = {}
  ): SwapHandlerFailure {
    const code = (error as { code?: string } | undefined)?.code;
    return {
      stage,
      error,
      message: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' && { code }),
      context: {
        destination: 'g.toon.swap.fixture',
        sourceAmount: 1_000n,
        pair: PAIR,
        senderPubkey: 'ab'.repeat(32),
        chainRecipient: '0x' + '11'.repeat(20),
        claimIssued: overrides.claimIssued ?? false,
        ...(overrides.claimId !== undefined && { claimId: overrides.claimId }),
      },
      defaultRejection: overrides.defaultRejection ?? GENERIC_DEFAULT,
    } as SwapHandlerFailure;
  }

  function loggerSpies(): {
    logger: {
      debug: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
  } {
    return {
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
  }

  it("[P0] an issuer failure replaces the SDK's blanket T00 and logs the refusal", () => {
    const { logger } = loggerSpies();
    const mapper = createClaimRefusalMapper({ logger });

    const rejection = mapper(failure('issuer', unredeemedError()));

    expect(rejection?.code).toBe('T04');
    expect(rejection?.message).toContain(
      CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED
    );
    expect(rejection?.message).toContain('0x0124a370');
    expect(rejection?.rejectReason?.code).toBe('insufficient_funds');
    const data = JSON.parse(
      Buffer.from(rejection?.data ?? '', 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect(data['reason']).toBe(CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED);
    expect(data['unredeemed']).toBe('1000');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [event, fields] = logger.warn.mock.calls[0] ?? [];
    expect(event).toBe('swap.claim.refused');
    expect(fields).toMatchObject({
      reason: CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED,
      ilpCode: 'T04',
      stage: 'issuer',
      channelId: '0x0124a370',
      unredeemed: '1000',
    });
  });

  it('[P0] INSUFFICIENT_INVENTORY is left to the SDK (T04 "Insufficient liquidity" unchanged)', () => {
    const { logger } = loggerSpies();
    const mapper = createClaimRefusalMapper({ logger });

    const rejection = mapper(
      failure(
        'issuer',
        new SwapInventoryError('INSUFFICIENT_INVENTORY', 'no reserves'),
        {
          defaultRejection: {
            code: 'T04',
            message: 'Insufficient liquidity',
          },
        }
      )
    );

    expect(rejection).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("[P1] an issuer failure the SDK already classified keeps the SDK's reject", () => {
    const mapper = createClaimRefusalMapper({});
    // The SDK's `/insufficient/i` message fallback → T04 without the code.
    const rejection = mapper(
      failure('issuer', new Error('insufficient something'), {
        defaultRejection: { code: 'T04', message: 'Insufficient liquidity' },
      })
    );
    expect(rejection).toBeUndefined();
  });

  it('[P0] the encrypt stage is OBSERVED — the real error, not an inference', () => {
    const { logger } = loggerSpies();
    const mapper = createClaimRefusalMapper({ logger });

    const rejection = mapper(
      failure('encrypt', new Error('invalid sender pubkey'), {
        claimIssued: true,
        claimId: 'claim-7',
      })
    );

    expect(rejection?.code).toBe('T00');
    expect(rejection?.message).toContain(
      CLAIM_REFUSAL_REASONS.CLAIM_ENCRYPT_FAILED
    );
    // The thrown message reaches the wire — pre-3.2.0 it was discarded.
    expect(rejection?.message).toContain('invalid sender pubkey');
    const data = JSON.parse(
      Buffer.from(rejection?.data ?? '', 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect(data['reason']).toBe(CLAIM_REFUSAL_REASONS.CLAIM_ENCRYPT_FAILED);
    expect(data['err']).toContain('invalid sender pubkey');
    expect(data['claimId']).toBe('claim-7');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('[P1] rate stages are left alone — RateFreshnessGuard owns staleness', () => {
    const mapper = createClaimRefusalMapper({});
    expect(
      mapper(
        failure('rate_provider', new Error('rpc down'), {
          defaultRejection: { code: 'T00', message: 'Rate provider error' },
        })
      )
    ).toBeUndefined();
    expect(
      mapper(
        failure('rate_conversion', new Error('bad rate'), {
          defaultRejection: { code: 'T00', message: 'Rate conversion error' },
        })
      )
    ).toBeUndefined();
  });

  it('[P1] no logger configured is not a crash', () => {
    const mapper = createClaimRefusalMapper({});
    expect(mapper(failure('issuer', unredeemedError()))?.code).toBe('T04');
  });
});
