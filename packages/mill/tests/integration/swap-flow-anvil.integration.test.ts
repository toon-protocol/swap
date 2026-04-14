/**
 * Story 12.8 AC-9 — Anvil-backed settlement tx well-formedness (OPT-IN).
 *
 * This suite is GATED on the SDK E2E infra running Anvil on
 * http://localhost:18545. If Anvil is unreachable within 500ms,
 * every test is skipped with an actionable message.
 *
 * Run with:
 *   ./scripts/sdk-e2e-infra.sh up
 *   cd packages/mill && pnpm test:integration:anvil
 *
 * Scope: this test VALIDATES tx bytes via `eth_call` / `eth_estimateGas`.
 * It does NOT broadcast — Anvil state is untouched. The on-chain
 * settlement-broadcast paths for Mina/Solana are covered by existing
 * SDK E2E tests; EVM via Anvil is the sole on-chain surface for
 * Story 12.8 (per Story Dependencies).
 *
 * RED PHASE: `describe.skip` — dev lifts the skip when the Anvil probe
 * and viem client are wired in Task 4.
 */

import { describe, it, expect } from 'vitest';

import { ANVIL_URL, ANVIL_CHAIN_ID } from './helpers/fixture-topology.js';

/** 500ms TCP probe — per AC-9 skip contract. */
async function isAnvilReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 500);
    const res = await fetch(ANVIL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

describe('AC-9 [P2] Anvil-backed settlement tx well-formedness (opt-in, SDK E2E infra required)', () => {
  it.skip('AC-9 — buildSettlementTx bytes accepted by anvilClient.call (eth_call or eth_estimateGas) — [BLOCKED — fixed in Story 12.9; re-enable is Story 12.8\'s job] depends on AC-4/AC-8; same 12.4 sender→recipient binding blocker documented in swap-flow.integration.test.ts', async (ctx) => {
    const reachable = await isAnvilReachable();
    if (!reachable) {
      ctx.skip(
        'SDK E2E infra not running — skip Anvil settlement validation. Run `./scripts/sdk-e2e-infra.sh up` to enable.',
      );
      return;
    }

    // GREEN phase implementation outline:
    //
    //   import { createPublicClient, http } from 'viem';
    //   const anvil = createPublicClient({ transport: http(ANVIL_URL) });
    //   const { rawBytes, channelContractAddress } = await runFixtureSwapAndBuildSettlementTx();
    //   // eth_call MUST NOT throw a malformed-tx error; state-revert is fine
    //   // (we only assert tx well-formedness, not on-chain success).
    //   await anvil.call({ data: `0x${toHex(rawBytes)}`, to: channelContractAddress });
    //
    //   Chain-id sanity: ensure the fixture used evm:31337 (AC-4's channel
    //   provisioning), not evm:1337. A mismatched EIP-155 chain-id would
    //   surface here as a signature-invalid error from Anvil.

    expect(ANVIL_CHAIN_ID).toBe(31337);
    expect.fail('AC-9 — Anvil settlement validation not yet wired (Task 4.3)');
  });
});
