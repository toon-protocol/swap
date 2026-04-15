/**
 * Story 12.10 — Mina swap-flow + settlement E2E (AC-8)
 *
 * RED-PHASE. Drives `streamSwap()` with `swapPair.to.chain === 'mina:devnet'`
 * against peer2 → peer1 over real BTP, then submits the accumulated claim as
 * a zkApp transaction via the Mina lightnet GraphQL endpoint at
 * `http://localhost:19085/graphql` and polls the zkApp's on-chain state
 * until the settled claim's state-field update is observed.
 *
 * Settlement rubric (from story Dev Notes):
 *   Mina minimum = signed zkApp txn POSTed, GraphQL `account(publicKey)
 *   { zkappState }` poll returns an updated state field corresponding to
 *   the settled claim. Lightnet SLOT_TIME is 20s; budget ≥60s for inclusion.
 *
 * Why RED today:
 *   - Same BTP sender gap (Task 4.4).
 *   - Mina settlement-submit helper not yet wired; Task 4.5.
 *   - MINA_ZKAPP_ADDRESS export from `./scripts/sdk-e2e-infra.sh` must be
 *     present — the guard below fails RED if the infra is up but the zkApp
 *     wasn't deployed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  checkAllServicesReady,
  waitForPeer2Bootstrap,
  waitForMinaHealth,
  skipIfNotReady,
  acquireMinaAccount,
  releaseMinaAccount,
  MINA_GRAPHQL,
  MINA_ZKAPP_ADDRESS,
  DOCKER_CHAIN_MINA,
} from './helpers/infra-gate.js';

async function buildLiveMinaSender(): Promise<null> {
  return null;
}

describe('Docker Swap-Flow Mina E2E (Story 12.10, Task 4)', () => {
  let servicesReady = false;
  let minaAccount: { pk: string; sk: string } | null = null;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;
    const bootstrapped = await waitForPeer2Bootstrap(45_000);
    if (!bootstrapped) return;
    const minaReady = await waitForMinaHealth(180_000);
    if (!minaReady) return;
    minaAccount = await acquireMinaAccount();
    if (!minaAccount) return;
    servicesReady = true;
  }, 240_000);

  afterAll(async () => {
    if (minaAccount) await releaseMinaAccount(minaAccount.pk);
    await new Promise((r) => setTimeout(r, 250));
  });

  // ---------------------------------------------------------------------
  // AC-8 pt.1 — swap completion + Mina chain-recipient round-trip
  // ---------------------------------------------------------------------
  it('AC-8 [P1] streamSwap() to mina:devnet completes with recipient === acquired Mina pk', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();
    expect(
      minaAccount,
      'RED/infra: acquireMinaAccount() must return a usable pool entry'
    ).not.toBeNull();

    const sender = await buildLiveMinaSender();
    expect(
      sender,
      'RED: Task 4.4 must wire live sender with Mina chainRecipient = minaAccount.pk'
    ).not.toBeNull();

    // GREEN:
    // const result = await streamSwap({
    //   client: sender!.client,
    //   millPubkey: …,
    //   millIlpAddress: 'g.toon.peer1',
    //   pair: {
    //     from: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
    //     to:   { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_MINA },
    //     rate: '1',
    //   },
    //   senderSecretKey: generateSecretKey(),
    //   chainRecipient: minaAccount!.pk,
    //   totalAmount: 1_000_000n,
    //   packetCount: 1,
    // });
    // expect(result.state).toBe('completed');
    // expect(result.claims[0]!.recipient).toBe(minaAccount!.pk);
  });

  // ---------------------------------------------------------------------
  // AC-8 pt.2 — zkApp state update
  // ---------------------------------------------------------------------
  it('AC-8 [P1] buildSettlementTx() zkApp submission updates on-chain state within lightnet budget', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    expect(
      MINA_ZKAPP_ADDRESS,
      'MINA_ZKAPP_ADDRESS not exported — rerun ./scripts/sdk-e2e-infra.sh up with Mina zkApp deploy'
    ).not.toBe('');
    expect(MINA_GRAPHQL).toBe('http://localhost:19085/graphql');

    // GREEN flow (Task 4.5):
    //   1. const built = buildSettlementTx(lastClaim);  // Mina variant
    //   2. POST `sendZkapp(input: { zkappCommand: $BUILT_JSON })` to MINA_GRAPHQL.
    //   3. Poll `query { account(publicKey: $ZKAPP) { zkappState } }`
    //      every 5s for up to 120s; break when state field corresponding to
    //      the settled claim differs from baseline.
    //   4. expect(statePostSettlement).not.toEqual(statePreSettlement).

    const zkappStateAdvanced = false;
    expect(
      zkappStateAdvanced,
      'RED: Task 4.5 must POST zkApp txn and observe state update within 120s'
    ).toBe(true);
  });
});
