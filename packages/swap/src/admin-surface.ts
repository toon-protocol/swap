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
 * Four routes, mounted on the existing BLS server under `/admin`:
 *
 * - `GET  /admin/inventory`           — read: per-pool buckets, per-channel
 *   issued-vs-redeemed, and an explicit reason when issuance is blocked.
 * - `POST /admin/inventory/reconcile` — write: force a chain-truth pass now.
 * - `POST /admin/inventory/credit`    — write: recycle burned capital, and
 *   ONLY the amount an on-chain redemption corroborates.
 * - `POST /admin/inventory/deposit`   — write (swap#142): book genuinely NEW
 *   capital, and ONLY the amount the pool's on-chain channel funding
 *   corroborates.
 *
 * ## Recycling vs. new capital (swap#142)
 *
 * `credit` and `deposit` answer two different questions and must not be
 * confused:
 *
 * | | corroborated by | moves |
 * | --- | --- | --- |
 * | `credit` | an on-chain **redemption** (`cumulativePaid` rose) | `available` only — a redemption returns capital already counted, so `total` must not move |
 * | `deposit` | on-chain **channel funding** (`cumulativePaid + deposit` exceeds `total`) | `available` AND `total` — this is capital the pool did not have before |
 *
 * Before swap#142 the second had no route at all: `SwapInventory.credit` had
 * no caller, and raising the configured inventory does not reliably take,
 * because the persisted snapshot wins over config for keys it has already
 * seen (issue #130). An operator who funded a new channel could only redeploy
 * and hope.
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
 * 2. **Writes are token-gated and default-denied.** Every `POST` route
 *    requires the operator token (`SWAP_ADMIN_TOKEN` →
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
import { SwapInventoryError } from './errors.js';
import type {
  ChannelRedemptionObservation,
  PoolFundingReading,
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

interface DepositBody extends CreditBody {
  dryRun?: unknown;
}

/** JSON-safe projection of a pool's on-chain funding read (swap#142). */
function serializeFunding(
  reading: PoolFundingReading
): Record<string, unknown> {
  return {
    pool: reading.pool,
    supported: reading.supported,
    chainFundedTotal: reading.chainFundedTotal.toString(),
    readAt: reading.readAt,
    channels: reading.channels.map((c) => ({
      channelId: c.channelId,
      cumulativePaid:
        c.cumulativePaid === null ? null : c.cumulativePaid.toString(),
      deposit: c.deposit === null ? null : c.deposit.toString(),
      funded: c.funded === null ? null : c.funded.toString(),
      observedAt: c.observedAt,
      ...(c.error !== undefined && { error: c.error }),
    })),
    errors: [...reading.errors],
  };
}

/**
 * Parse and validate the `{ assetCode, chain, amount? }` shape both write
 * routes share. Returns either the parsed fields or the Response to send.
 */
function parsePoolBody(
  body: CreditBody
):
  | { ok: true; assetCode: string; chain: string; amount?: bigint }
  | { ok: false; reason: string } {
  const { assetCode, chain } = body;
  if (typeof assetCode !== 'string' || assetCode.length === 0) {
    return { ok: false, reason: 'assetCode is required' };
  }
  if (typeof chain !== 'string' || chain.length === 0) {
    return { ok: false, reason: 'chain is required' };
  }
  if (body.amount === undefined) return { ok: true, assetCode, chain };
  let amount: bigint;
  try {
    amount = BigInt(body.amount as string | number | bigint);
  } catch {
    return {
      ok: false,
      reason: 'amount must be a decimal integer (string or number)',
    };
  }
  if (amount <= 0n) return { ok: false, reason: 'amount must be positive' };
  return { ok: true, assetCode, chain, amount };
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

  /**
   * swap#142 — book genuinely NEW capital.
   *
   * `{ assetCode, chain, amount?, dryRun? }`. The corroboration is the pool's
   * on-chain channel funding, Σ `cumulativePaid + deposit`, versus the pool's
   * own `total`; only the excess of chain proof over booked claim is credited,
   * and crediting closes that excess — see
   * `SwapInventory.creditCorroboratedFunding` for why that makes a repeat call
   * a structural no-op rather than a double credit.
   *
   * `dryRun: true` runs the identical decision, returns the identical status
   * code, and mutates nothing — so an operator can see exactly what the real
   * call will do before making it.
   */
  app.post('/admin/inventory/deposit', async (c: Context) => {
    const denied = denyWrite(c);
    if (denied) return denied;

    let raw: DepositBody = {};
    try {
      raw = (await c.req.json()) as DepositBody;
    } catch {
      return c.json(
        {
          error: 'invalid_body',
          reason:
            'expected a JSON object { assetCode, chain, amount?, dryRun? }',
        },
        400
      );
    }
    const parsed = parsePoolBody(raw);
    if (!parsed.ok) {
      return c.json({ error: 'invalid_body', reason: parsed.reason }, 400);
    }
    if (raw.dryRun !== undefined && typeof raw.dryRun !== 'boolean') {
      return c.json(
        { error: 'invalid_body', reason: 'dryRun must be a boolean' },
        400
      );
    }
    const { assetCode, chain } = parsed;
    const dryRun = raw.dryRun === true;

    const reading = await deps.reconciler.readPoolFunding({ assetCode, chain });
    if (!reading.supported) {
      return c.json(
        {
          error: 'funding_unreadable',
          reason: `cannot read on-chain channel funding for ${assetCode}:${chain} — refusing to credit capital the chain has not corroborated`,
          errors: [...reading.errors],
        },
        503
      );
    }
    if (reading.channels.length === 0) {
      return c.json(
        {
          error: 'unknown_pool',
          reason: `no channel state for ${assetCode}:${chain} — capital only counts once the chain shows it in a channel this node has provisioned`,
          funding: serializeFunding(reading),
        },
        404
      );
    }
    if (reading.errors.length > 0) {
      // A failed read only ever makes the sum SMALLER (that channel is simply
      // excluded), so proceeding would under-credit rather than over-credit —
      // safe, but an operator asking "did my top-up land?" must not be handed
      // a silently partial answer. Refuse and let them retry.
      return c.json(
        {
          error: 'chain_unreadable',
          reason: `${reading.errors.length} of ${reading.channels.length} channel reads failed — the corroborated total would be incomplete, so nothing was credited`,
          funding: serializeFunding(reading),
        },
        503
      );
    }

    // From here to the credit is one synchronous block: `total` is read and
    // raised without an intervening await, so two concurrent operator calls
    // that observed the same `chainFundedTotal` cannot both credit it (the
    // second finds the gap already closed and is refused as uncorroborated).
    let outcome;
    try {
      const p = {
        assetCode,
        chain,
        chainFundedTotal: reading.chainFundedTotal,
        ...(parsed.amount !== undefined && { requested: parsed.amount }),
      };
      outcome = dryRun
        ? deps.inventory.previewCorroboratedFunding(p)
        : deps.inventory.creditCorroboratedFunding(p);
    } catch (err) {
      if (
        err instanceof SwapInventoryError &&
        err.code === 'INVENTORY_NOT_INITIALIZED'
      ) {
        return c.json(
          {
            error: 'unknown_pool',
            reason: `no inventory pool ${assetCode}:${chain} is configured on this node`,
          },
          404
        );
      }
      throw err;
    }

    const body = {
      applied: !dryRun && outcome.credited > 0n,
      dryRun,
      requested: outcome.requested?.toString() ?? null,
      total: outcome.total.toString(),
      chainFundedTotal: outcome.chainFundedTotal.toString(),
      corroborated: outcome.corroborated.toString(),
      credited: outcome.credited.toString(),
      funding: serializeFunding(reading),
    };

    if (outcome.refused === 'uncorroborated') {
      return c.json(
        {
          ...body,
          error: 'uncorroborated',
          reason: `the pool's channels hold ${reading.chainFundedTotal} on chain and the pool has already booked ${outcome.total} — no new capital to credit. Fund or top up a channel this node has provisioned; inventory is only ever credited against capital the chain shows in a channel.`,
        },
        409
      );
    }
    if (outcome.refused === 'exceeds_corroborated') {
      return c.json(
        {
          ...body,
          error: 'exceeds_corroborated',
          reason: `the chain corroborates only ${outcome.corroborated} of the requested ${outcome.requested ?? 0n}; nothing was credited`,
        },
        409
      );
    }

    const persisted = dryRun
      ? { persisted: false }
      : deps.reconciler.persistState();
    return c.json({ ...body, ...persisted });
  });
}
