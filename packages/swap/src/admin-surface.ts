/**
 * Operator surface for maker inventory (issue #138).
 *
 * Before this module the container exposed exactly one route — `GET /health`
 * — and every corrective action (`SwapInventory.credit`,
 * `SwapNodeInstance.recordSettlement`) was a programmatic method with no
 * caller. An operator whose maker had stopped serving could not see WHY
 * without reading `swap-node-state.json` out of a docker volume, and could
 * not fix it without a redeploy (or deleting the state file, which resets
 * `nonce`/`cumulativeAmount` BELOW claims already issued and invites a
 * replay — see `state-store.ts`).
 *
 * Three routes, mounted on the existing BLS server under `/admin`:
 *
 * - `GET  /admin/inventory`           — read: per-pool buckets, per-channel
 *   issued-vs-redeemed, and an explicit reason when issuance is blocked.
 * - `POST /admin/inventory/reconcile` — write: force a chain-truth pass now.
 * - `POST /admin/inventory/credit`    — write: recycle burned capital, and
 *   ONLY the amount an on-chain redemption corroborates.
 *
 * ## Protection
 *
 * Two independent layers, both required:
 *
 * 1. **Not reachable from the internet.** The maker sits behind the fleet's
 *    box nginx, which returns 404 for `^~ /admin` — the same treatment the
 *    connector's own `/admin` surface gets. Mounting under `/admin` (rather
 *    than inventing a new prefix) is what makes that existing rule cover
 *    these routes.
 * 2. **Writes are token-gated and default-denied.** Both `POST` routes
 *    require the operator token (`SWAP_ADMIN_TOKEN` →
 *    `SwapNodeConfig.adminToken`) in `Authorization: Bearer …` or
 *    `X-Swap-Admin-Token`, compared in constant time. When no token is
 *    configured the writes are DISABLED (503) rather than open — a maker
 *    that forgets the token loses the ability to correct itself, never the
 *    ability to protect itself. The token is optional config, so no
 *    deployment can crash-loop on it (swap#134).
 *
 * The read route is not token-gated: it discloses strictly less than the
 * pre-existing unauthenticated `GET /health` (same inventory numbers plus
 * on-chain watermarks, which are public), and an operator diagnosing a dead
 * maker should not be blocked on a secret they may not have set.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { Context, Hono } from 'hono';

import type { SwapInventory } from './inventory.js';
import type {
  ChannelRedemptionObservation,
  ReconcileResult,
  SwapInventoryReconciler,
} from './inventory-reconciler.js';

export interface AdminChannelView {
  channelId: string;
  /** Cumulative value this node has issued claims for (off-chain watermark). */
  issued: string;
  /** LIVE on-chain `cumulativePaid`, or `null` when never/last read failed. */
  redeemedOnChain: string | null;
  /** Issued minus redeemed — the value still blocking capacity. */
  unredeemed: string | null;
  /** ms-epoch of the observation (absent when never observed). */
  observedAt?: number;
  /** Why this channel could not be reconciled, when applicable. */
  error?: string;
}

export interface AdminPoolView {
  /** `${assetCode}:${chain}`. */
  pool: string;
  assetCode: string;
  chain: string;
  available: string;
  total: string;
  unsettled: string;
  windowBudget?: string;
  /** Effective ceiling `min(windowBudget ?? available, available)`. */
  budget: string;
  inFlight: string;
  /** `budget − inFlight − unsettled` — what a new swap can consume. */
  free: string;
  /** `true` when `free` is 0: the pool refuses every request with T04. */
  issuanceBlocked: boolean;
  /** Plain-language account of what is holding the capacity. */
  blockedReason?: string;
  channels: AdminChannelView[];
}

export interface AdminInventoryReport {
  generatedAt: number;
  pools: AdminPoolView[];
  reconciler: {
    /** `false` when no on-chain reader is configured — nothing recycles. */
    enabled: boolean;
    lastRunAt?: number;
    lastErrors: string[];
  };
  writes: {
    enabled: boolean;
    reason: string;
  };
}

export interface AdminSurfaceDeps {
  inventory: SwapInventory;
  reconciler: SwapInventoryReconciler;
  /** Operator token; absent ⇒ writes disabled. */
  adminToken?: string;
  clock?: () => number;
}

const WRITES_DISABLED_REASON =
  'no admin token configured — set SWAP_ADMIN_TOKEN (or SwapNodeConfig.adminToken) to enable inventory writes';
const WRITES_ENABLED_REASON =
  'token required in Authorization: Bearer <token> or X-Swap-Admin-Token';

function constantTimeEquals(a: string, b: string): boolean {
  // Hash first so the comparison operands are always the same length (and so
  // the length of the configured token is not observable).
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Extract the presented token from either accepted header form. */
function presentedToken(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1];
  }
  const direct = c.req.header('x-swap-admin-token');
  return direct && direct.length > 0 ? direct : null;
}

/**
 * Explain a pool whose `free` capacity is zero. Ordered by what an operator
 * can act on: no capital at all, then liability awaiting redemption, then
 * live in-flight reservations, then a window budget clamping an otherwise
 * healthy pool.
 */
function describeBlock(p: {
  available: bigint;
  total: bigint;
  unsettled: bigint;
  inFlight: bigint;
  budget: bigint;
  windowBudget?: bigint;
  channels: AdminChannelView[];
  reconcilerEnabled: boolean;
}): string {
  const parts: string[] = [];
  if (p.available === 0n) {
    parts.push(
      `available is 0 of total ${p.total} — the pool holds no capital to issue against`
    );
  }
  if (p.unsettled > 0n) {
    const holders = p.channels
      .filter((c) => c.unredeemed === null || BigInt(c.unredeemed) > 0n)
      .map(
        (c) =>
          `${c.channelId}: ${c.unredeemed ?? 'unknown'} unredeemed of ${c.issued} issued`
      );
    parts.push(
      `${p.unsettled} of budget ${p.budget} is unsettled liability — claims issued and not yet redeemed on chain` +
        (holders.length > 0 ? ` (${holders.join('; ')})` : '') +
        `. Capacity returns automatically once the counterparty redeems` +
        (p.reconcilerEnabled
          ? ' (the chain-truth reconciler recycles it).'
          : ', but NO on-chain reader is configured, so nothing will ever observe the redemption — add an EVM or Solana chainProviders entry (Mina publishes no readable settled amount, so a mina-only pool cannot be recycled).')
    );
  }
  if (p.inFlight > 0n) {
    parts.push(
      `${p.inFlight} of budget ${p.budget} is reserved by in-flight packets (frees at reservation TTL)`
    );
  }
  if (
    p.windowBudget !== undefined &&
    p.windowBudget < p.available &&
    p.unsettled === 0n &&
    p.inFlight === 0n
  ) {
    parts.push(
      `windowBudget ${p.windowBudget} clamps the ceiling below available ${p.available}`
    );
  }
  if (parts.length === 0) {
    parts.push(
      `budget is ${p.budget} (available ${p.available}, total ${p.total})`
    );
  }
  return parts.join(' | ');
}

/** Build the operator read view: buckets + per-channel chain truth + reasons. */
export function buildInventoryReport(
  deps: AdminSurfaceDeps
): AdminInventoryReport {
  const clock = deps.clock ?? Date.now;
  const balances = new Map(
    deps.inventory.snapshot().map((b) => [`${b.assetCode}:${b.chain}`, b])
  );
  const observationsByPool = new Map<string, ChannelRedemptionObservation[]>();
  for (const o of deps.reconciler.latestObservations()) {
    const poolKey = `${o.assetCode}:${o.chain}`;
    const list = observationsByPool.get(poolKey) ?? [];
    list.push(o);
    observationsByPool.set(poolKey, list);
  }

  const pools: AdminPoolView[] = [];
  for (const w of deps.inventory.windowSnapshot()) {
    const poolKey = `${w.assetCode}:${w.chain}`;
    const balance = balances.get(poolKey);
    const available = balance?.available ?? 0n;
    const total = balance?.total ?? 0n;
    const channels: AdminChannelView[] = (
      observationsByPool.get(poolKey) ?? []
    ).map((o) => ({
      channelId: o.channelId,
      issued: o.issued.toString(),
      redeemedOnChain: o.redeemed === null ? null : o.redeemed.toString(),
      unredeemed: o.unredeemed === null ? null : o.unredeemed.toString(),
      observedAt: o.observedAt,
      ...(o.error !== undefined && { error: o.error }),
    }));
    const issuanceBlocked = w.free === 0n;
    pools.push({
      pool: poolKey,
      assetCode: w.assetCode,
      chain: w.chain,
      available: available.toString(),
      total: total.toString(),
      unsettled: w.unsettled.toString(),
      ...(balance?.windowBudget !== undefined && {
        windowBudget: balance.windowBudget.toString(),
      }),
      budget: w.budget.toString(),
      inFlight: w.inFlight.toString(),
      free: w.free.toString(),
      issuanceBlocked,
      ...(issuanceBlocked && {
        blockedReason: describeBlock({
          available,
          total,
          unsettled: w.unsettled,
          inFlight: w.inFlight,
          budget: w.budget,
          ...(balance?.windowBudget !== undefined && {
            windowBudget: balance.windowBudget,
          }),
          channels,
          reconcilerEnabled: deps.reconciler.enabled,
        }),
      }),
      channels,
    });
  }

  const lastRun = deps.reconciler.lastRun;
  const writesEnabled = Boolean(deps.adminToken);
  return {
    generatedAt: clock(),
    pools,
    reconciler: {
      enabled: deps.reconciler.enabled,
      ...(lastRun && { lastRunAt: lastRun.ranAt }),
      lastErrors: lastRun ? [...lastRun.errors] : [],
    },
    writes: {
      enabled: writesEnabled,
      reason: writesEnabled ? WRITES_ENABLED_REASON : WRITES_DISABLED_REASON,
    },
  };
}

/** JSON-safe projection of a reconcile pass. */
function serializeReconcile(result: ReconcileResult): Record<string, unknown> {
  return {
    ranAt: result.ranAt,
    applied: result.applied,
    pools: result.pools.map((p) => ({
      pool: p.pool,
      liabilityReduced: p.liabilityReduced.toString(),
      availableRestored: p.availableRestored.toString(),
    })),
    channels: result.channels.map((c) => ({
      channelId: c.channelId,
      pool: `${c.assetCode}:${c.chain}`,
      issued: c.issued.toString(),
      redeemedOnChain: c.redeemed === null ? null : c.redeemed.toString(),
      unredeemed: c.unredeemed === null ? null : c.unredeemed.toString(),
      liabilityReduced: c.liabilityReduced.toString(),
      availableRestored: c.availableRestored.toString(),
      ...(c.error !== undefined && { error: c.error }),
    })),
    errors: [...result.errors],
  };
}

function sumRestored(result: ReconcileResult): bigint {
  let sum = 0n;
  for (const p of result.pools) sum += p.availableRestored;
  return sum;
}

interface CreditBody {
  assetCode?: unknown;
  chain?: unknown;
  amount?: unknown;
}

/** Register `/admin/*` on the BLS Hono app. */
export function registerAdminRoutes(app: Hono, deps: AdminSurfaceDeps): void {
  /** Returns a Response to send when the caller is not authorized, else null. */
  const denyWrite = (c: Context): Response | null => {
    if (!deps.adminToken) {
      return c.json(
        { error: 'admin_writes_disabled', reason: WRITES_DISABLED_REASON },
        503
      );
    }
    const presented = presentedToken(c);
    if (!presented || !constantTimeEquals(presented, deps.adminToken)) {
      return c.json(
        { error: 'unauthorized', reason: WRITES_ENABLED_REASON },
        401
      );
    }
    return null;
  };

  app.get('/admin/inventory', (c: Context) =>
    c.json(buildInventoryReport(deps))
  );

  app.post('/admin/inventory/reconcile', async (c: Context) => {
    const denied = denyWrite(c);
    if (denied) return denied;
    const result = await deps.reconciler.reconcile();
    return c.json(serializeReconcile(result));
  });

  app.post('/admin/inventory/credit', async (c: Context) => {
    const denied = denyWrite(c);
    if (denied) return denied;

    let body: CreditBody = {};
    try {
      body = (await c.req.json()) as CreditBody;
    } catch {
      return c.json(
        {
          error: 'invalid_body',
          reason: 'expected a JSON object { assetCode, chain, amount? }',
        },
        400
      );
    }
    const { assetCode, chain } = body;
    if (typeof assetCode !== 'string' || assetCode.length === 0) {
      return c.json(
        { error: 'invalid_body', reason: 'assetCode is required' },
        400
      );
    }
    if (typeof chain !== 'string' || chain.length === 0) {
      return c.json(
        { error: 'invalid_body', reason: 'chain is required' },
        400
      );
    }
    let requested: bigint | undefined;
    if (body.amount !== undefined) {
      try {
        requested = BigInt(body.amount as string | number | bigint);
      } catch {
        return c.json(
          {
            error: 'invalid_body',
            reason: 'amount must be a decimal integer (string or number)',
          },
          400
        );
      }
      if (requested <= 0n) {
        return c.json(
          { error: 'invalid_body', reason: 'amount must be positive' },
          400
        );
      }
    }

    // Corroborate BEFORE mutating: a credit the chain does not back must be
    // refused outright, not silently clamped to zero after the per-channel
    // watermark has already advanced.
    const preview = await deps.reconciler.reconcile({
      apply: false,
      assetCode,
      chain,
    });
    if (preview.channels.length === 0) {
      return c.json(
        {
          error: 'unknown_pool',
          reason: `no channel state for ${assetCode}:${chain}${
            deps.reconciler.enabled
              ? ''
              : ' (and no on-chain reader is configured, so nothing can be corroborated)'
          }`,
          errors: [...preview.errors],
        },
        404
      );
    }
    if (preview.channels.every((ch) => ch.redeemed === null)) {
      return c.json(
        {
          error: 'chain_unreadable',
          reason:
            'every channel read failed — refusing to credit without chain truth',
          errors: [...preview.errors],
        },
        503
      );
    }
    const corroborated = sumRestored(preview);
    if (corroborated === 0n) {
      return c.json(
        {
          error: 'uncorroborated',
          reason:
            'no on-chain redemption corroborates a credit for this pool: every redeemed watermark is already accounted for. Inventory is only ever credited against value the chain shows redeemed.',
          requested: requested?.toString() ?? null,
          corroborated: '0',
          preview: serializeReconcile(preview),
        },
        409
      );
    }
    if (requested !== undefined && requested > corroborated) {
      return c.json(
        {
          error: 'exceeds_corroborated',
          reason: `the chain corroborates only ${corroborated} of the requested ${requested}; nothing was credited`,
          requested: requested.toString(),
          corroborated: corroborated.toString(),
          preview: serializeReconcile(preview),
        },
        409
      );
    }

    const applied = await deps.reconciler.reconcile({
      apply: true,
      assetCode,
      chain,
    });
    return c.json({
      requested: requested?.toString() ?? null,
      corroborated: corroborated.toString(),
      credited: sumRestored(applied).toString(),
      result: serializeReconcile(applied),
    });
  });
}
