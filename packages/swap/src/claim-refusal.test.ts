/**
 * swap#136 — unit coverage for the claim-refusal classifier and the two
 * wrappers that reclaim what the SDK swap handler throws away.
 *
 * The end-to-end proof (a real gift-wrapped swap producing a logged,
 * actionable refusal) lives in `swap-node.claim-refusal.test.ts`; this file
 * pins the per-condition mapping and the concurrency property that makes the
 * handler wrapper safe.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  CLAIM_REFUSAL_REASONS,
  classifyClaimIssuerError,
  buildClaimRefusalReject,
  createClaimRefusalDiagnostics,
} from './claim-refusal.js';
import { SwapWalletError, SwapInventoryError } from './errors.js';

const GENERIC = { accept: false, code: 'T00', message: 'Internal error' };

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

describe('createClaimRefusalDiagnostics', () => {
  it('[P0] instrument() logs the refusal and rethrows unchanged', async () => {
    const warn = vi.fn();
    const diagnostics = createClaimRefusalDiagnostics({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });
    const thrown = unredeemedError();
    const issuer = diagnostics.instrument({
      issueClaim: async () => {
        throw thrown;
      },
    });

    await expect(issuer.issueClaim({})).rejects.toBe(thrown);
    expect(warn).toHaveBeenCalledTimes(1);
    const [event, fields] = warn.mock.calls[0] ?? [];
    expect(event).toBe('swap.claim.refused');
    expect(fields).toMatchObject({
      reason: CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED,
      ilpCode: 'T04',
      channelId: '0x0124a370',
      unredeemed: '1000',
    });
  });

  it('[P0] INSUFFICIENT_INVENTORY is left to the SDK (T04 "Insufficient liquidity" is unchanged)', async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const diagnostics = createClaimRefusalDiagnostics({
      logger: { debug: vi.fn(), info: vi.fn(), warn, error },
    });
    const issuer = diagnostics.instrument({
      issueClaim: async () => {
        throw new SwapInventoryError('INSUFFICIENT_INVENTORY', 'no reserves');
      },
    });
    await expect(issuer.issueClaim({})).rejects.toThrow('no reserves');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    // …and the handler wrapper leaves the SDK's own T04 alone.
    const handler = diagnostics.wrap(async () => ({
      accept: false,
      code: 'T04',
      message: 'Insufficient liquidity',
    }));
    expect(await handler({})).toEqual({
      accept: false,
      code: 'T04',
      message: 'Insufficient liquidity',
    });
  });

  it("[P0] wrap() replaces the SDK's blanket T00 with the captured refusal", async () => {
    const diagnostics = createClaimRefusalDiagnostics({});
    const issuer = diagnostics.instrument({
      issueClaim: async () => {
        throw unredeemedError();
      },
    });
    const handler = diagnostics.wrap(async () => {
      // stand-in for the SDK handler: calls the issuer, swallows the throw
      await issuer.issueClaim({}).catch(() => undefined);
      return GENERIC;
    });

    const result = (await handler({})) as { code: string; message: string };
    expect(result.code).toBe('T04');
    expect(result.message).toContain(CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED);
  });

  it('[P0] concurrent packets never cross-contaminate (per-packet AsyncLocalStorage slot)', async () => {
    const diagnostics = createClaimRefusalDiagnostics({});
    const issuer = diagnostics.instrument({
      issueClaim: async (params: { fail?: string }) => {
        await new Promise((r) => setTimeout(r, params.fail === 'a' ? 20 : 1));
        if (params.fail === 'a') throw unredeemedError('0xAAA', 111n);
        if (params.fail === 'b') throw unredeemedError('0xBBB', 222n);
        return { ok: true };
      },
    });
    const handler = diagnostics.wrap(async (ctx: { fail?: string }) => {
      await issuer.issueClaim(ctx).catch(() => undefined);
      return GENERIC;
    });

    const [a, b] = (await Promise.all([
      handler({ fail: 'a' }),
      handler({ fail: 'b' }),
    ])) as { message: string }[];
    expect(a.message).toContain('0xAAA');
    expect(a.message).toContain('111');
    expect(b.message).toContain('0xBBB');
    expect(b.message).toContain('222');
  });

  it("[P1] a successful issuance followed by the SDK's T00 is named as the encrypt path", async () => {
    const error = vi.fn();
    const diagnostics = createClaimRefusalDiagnostics({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
    });
    const issuer = diagnostics.instrument({
      issueClaim: async () => ({ claim: new Uint8Array([1]) }),
    });
    const handler = diagnostics.wrap(async () => {
      await issuer.issueClaim({});
      return GENERIC; // the SDK's `swap_handler.encrypt_failed` branch
    });

    const result = (await handler({})) as { code: string; message: string };
    expect(result.message).toContain(
      CLAIM_REFUSAL_REASONS.CLAIM_ENCRYPT_FAILED
    );
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('[P1] a T00 with no issuance attempted at all is passed through untouched', async () => {
    const diagnostics = createClaimRefusalDiagnostics({});
    const handler = diagnostics.wrap(async () => GENERIC);
    expect(await handler({})).toEqual(GENERIC);
  });

  it('[P1] accepts and non-generic rejects are passed through untouched', async () => {
    const diagnostics = createClaimRefusalDiagnostics({});
    const accept = { accept: true, metadata: { claim: 'x' } };
    expect(await diagnostics.wrap(async () => accept)({})).toBe(accept);
    const stale = { accept: false, code: 'T99', message: 'stale_rate' };
    expect(await diagnostics.wrap(async () => stale)({})).toBe(stale);
  });
});
