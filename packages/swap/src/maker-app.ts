/**
 * The HTTP surface a Rust connector delivers to — the maker as an **app**
 * behind two route terminations:
 *
 *   `[[routes]] prefix = "<ilpAddress>.rfq"  handler_url = "http://maker/swap/rfq"   price = 0`
 *   `[[routes]] prefix = "<ilpAddress>"      handler_url = "http://maker/swap/fill"  price = <δ>`
 *
 * Plus the operator-facing `GET /health` and the admin routes, on the same
 * listener. Nothing here speaks ILP: the request that reaches `/swap/fill`
 * was paid for at the connector's client edge before this process saw it
 * (connector PF-23 / ADR 0040), and the answer — whatever its status — rides
 * home on the FULFILL. That is why a refusal is an HTTP status inside the
 * sealed response and never an ILP reject.
 */

import type { Context, Hono } from 'hono';

import type { MakerEngine, MakerAnswer } from './maker-engine.js';
import {
  SWAP_REFUSAL_REASONS,
  SWAP_REFUSAL_STATUS,
  SWAP_WIRE_PROTOCOL,
  parseSwapFillRequest,
  parseSwapRfqRequest,
  readPaymentAttribution,
} from './wire.js';
import type { SwapRefusal, SwapWireAnswer } from './wire.js';

export const MAKER_RFQ_PATH = '/swap/rfq';
export const MAKER_FILL_PATH = '/swap/fill';

export interface MakerAppLogger {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export interface MakerAppDeps {
  engine: MakerEngine;
  logger?: MakerAppLogger;
  /** Largest request body accepted, bytes. Bodies are tiny; this is a backstop. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

function malformed(message: string): MakerAnswer<SwapRefusal> {
  return {
    status: SWAP_REFUSAL_STATUS.malformed_request,
    body: {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'refusal',
      reason: SWAP_REFUSAL_REASONS.MALFORMED_REQUEST,
      message: `malformed_request: ${message}`,
      retry: false,
    },
  };
}

async function readJsonBody(
  c: Context,
  maxBytes: number
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const raw = await c.req.arrayBuffer();
  if (raw.byteLength > maxBytes) {
    return { ok: false, error: `body exceeds ${maxBytes} bytes` };
  }
  if (raw.byteLength === 0) return { ok: false, error: 'empty body' };
  try {
    return { ok: true, value: JSON.parse(Buffer.from(raw).toString('utf8')) };
  } catch {
    return { ok: false, error: 'body is not valid JSON' };
  }
}

function answer(c: Context, a: MakerAnswer<SwapWireAnswer>): Response {
  c.status(a.status as 200);
  c.header('content-type', 'application/json');
  return c.body(JSON.stringify(a.body));
}

/** Mount the maker's wire routes on `app`. */
export function registerMakerRoutes(app: Hono, deps: MakerAppDeps): void {
  const maxBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  app.post(MAKER_RFQ_PATH, async (c) => {
    const body = await readJsonBody(c, maxBytes);
    if (!body.ok) return answer(c, malformed(body.error));
    const parsed = parseSwapRfqRequest(body.value);
    if (!parsed.ok) return answer(c, malformed(parsed.error));
    deps.logger?.debug?.('swap.rfq.arrival', {
      streamNonce: parsed.value.streamNonce,
    });
    return answer(c, await deps.engine.quote(parsed.value));
  });

  app.post(MAKER_FILL_PATH, async (c) => {
    const body = await readJsonBody(c, maxBytes);
    if (!body.ok) return answer(c, malformed(body.error));
    const parsed = parseSwapFillRequest(body.value);
    if (!parsed.ok) return answer(c, malformed(parsed.error));
    const attribution = readPaymentAttribution((name) => c.req.header(name));
    deps.logger?.debug?.('swap.fill.arrival', {
      streamNonce: parsed.value.streamNonce,
      seq: parsed.value.seq,
      paid: attribution !== null,
    });
    return answer(
      c,
      await deps.engine.fill({ fill: parsed.value, attribution })
    );
  });

  // The connector hands an app whatever verb the envelope named; anything
  // but a POST on these two paths is a taker bug worth a clear answer.
  for (const path of [MAKER_RFQ_PATH, MAKER_FILL_PATH]) {
    app.all(path, (c) =>
      answer(c, malformed(`use POST ${path} with a JSON body`))
    );
  }
}
