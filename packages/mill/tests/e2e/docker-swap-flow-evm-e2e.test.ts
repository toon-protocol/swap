/**
 * Story 12.10 — EVM swap-flow + settlement E2E (AC-3, AC-4, AC-5, AC-6)
 *
 * RED-PHASE (ATDD). These tests target live Docker infrastructure
 * (`./scripts/sdk-e2e-infra.sh up`) and drive a real `streamSwap()` session
 * through peer2 → peer1 over BTP WebSockets. They runtime-skip via
 * `skipIfNotReady()` when infra is down.
 *
 * Why these fail today (RED):
 *   - The SDK's `streamSwap()` requires a `StreamSwapClient` with real
 *     `sendSwapPacket()` BTP wiring to a running Mill service. The current
 *     SDK `createNode()` + `ConnectorNode` flow does not expose a Mill-aware
 *     `sendSwapPacket()`; wiring it is Task 2.2 GREEN work.
 *   - peer1 in the Docker image does not yet publish a kind:10032 SwapPair
 *     announcement (Story 12.1 code path is not enabled in the peer runtime
 *     under `toon:optimized`). Asserting the announcement is observable is
 *     GREEN work for the peer image / startup.
 *   - `buildSettlementTx()` integration with real EVM submission requires a
 *     channel actually opened between sender and peer1 under the Mill's
 *     `MultiChainClaimIssuer`; the "sender funding + channel open" helper
 *     is Task 2.7.
 *
 * Settlement rubric (from story Dev Notes § "Settlement verification rubric"):
 *   EVM minimum = `closeChannel()` submission + participants[sender].nonce
 *   and `transferredAmount` advance to match the last claim. Full settle +
 *   balance change is a stretch goal (requires `evm_increaseTime`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { StreamSwapResult } from '@toon-protocol/sdk';

import {
  checkAllServicesReady,
  waitForPeer2Bootstrap,
  skipIfNotReady,
  waitForEventOnRelay,
  PEER1_RELAY_URL,
  PEER1_BTP_URL,
  TOKEN_NETWORK_ADDRESS,
  MILL_E2E_EVM_SENDER_ADDRESS,
  DOCKER_CHAIN_EVM,
} from './helpers/infra-gate.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Sender's 20-byte EVM payout address (lowercase hex with `0x`). AC-3. */
const EVM_CHAIN_RECIPIENT = MILL_E2E_EVM_SENDER_ADDRESS.toLowerCase();

/** Invalid chain-recipient value used for AC-5 T00 probe. */
const MALFORMED_CHAIN_RECIPIENT = '0xdeadbeef';

// ---------------------------------------------------------------------------
// Test harness placeholder — Task 2.2 GREEN work wires a real BTP sender.
// ---------------------------------------------------------------------------

/**
 * Build a live sender wired to peer2's BTP endpoint. GREEN-phase impl should
 * return a `{ node, client, close }` shape where `client` is a
 * `StreamSwapClient` compatible with `streamSwap()`. RED-phase returns
 * `null` so each test throws until Task 2.2 lands.
 */
async function buildLiveEvmSender(): Promise<null> {
  return null;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Docker Swap-Flow EVM E2E (Story 12.10, Task 2)', () => {
  let servicesReady = false;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;
    const bootstrapped = await waitForPeer2Bootstrap(45000);
    if (!bootstrapped) return;
    servicesReady = true;
  }, 120_000);

  afterAll(async () => {
    // GREEN phase: close BTP sockets, stop connector, stop Mill sender node.
    await new Promise((r) => setTimeout(r, 250));
  });

  // ---------------------------------------------------------------------
  // AC-3 — live BTP swap completes with recipient-equality claims
  // ---------------------------------------------------------------------
  it('AC-3 [P1] streamSwap() over real BTP resolves completed with ≥1 recipient-bound claim', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const sender = await buildLiveEvmSender();
    expect(
      sender,
      'RED: Task 2.2 must wire a live BTP StreamSwapClient against ws://localhost:19010 (peer2)'
    ).not.toBeNull();

    // GREEN: when sender exists, drive streamSwap().
    // const senderSecretKey = generateSecretKey();
    // const result: StreamSwapResult = await streamSwap({
    //   client: sender!.client,
    //   millPubkey: /* peer1 nostr pubkey */,
    //   millIlpAddress: 'g.toon.peer1',
    //   pair: {
    //     from: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
    //     to:   { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
    //     rate: '1',
    //   },
    //   senderSecretKey,
    //   chainRecipient: EVM_CHAIN_RECIPIENT,
    //   totalAmount: 1_000_000n,
    //   packetCount: 2,
    // });
    //
    // expect(result.state).toBe('completed');
    // expect(result.claims.length).toBeGreaterThanOrEqual(1);
    // for (const c of result.claims) {
    //   expect(c.recipient?.toLowerCase()).toBe(EVM_CHAIN_RECIPIENT);
    // }
  });

  // ---------------------------------------------------------------------
  // AC-4 — peer1 publishes kind:10032 SwapPair announcement on its relay
  // ---------------------------------------------------------------------
  it('AC-4 [P1] peer1 relay surfaces a kind:10032 SwapPair announcement covering EVM/Solana/Mina', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    // The announcement event ID is not known ahead of time. GREEN-phase
    // implementation should either expose the peer's startup-published
    // event ID via the Docker infra script, OR open a kinds-filtered
    // subscription directly. The `waitForEventOnRelay` helper expects a
    // specific `ids:[...]` filter, so RED-phase asserts the GAP: no such
    // event is currently published.
    const peer1PublishedSwapPairEventId: string | null = null;
    expect(
      peer1PublishedSwapPairEventId,
      'RED: peer1 does not yet publish kind:10032 SwapPair on startup; ' +
        'Task 2.5 / peer-image work must surface a discoverable event ID'
    ).not.toBeNull();

    // GREEN flow:
    // const event = await waitForEventOnRelay(
    //   PEER1_RELAY_URL,
    //   peer1PublishedSwapPairEventId!,
    //   15_000
    // );
    // expect(event).not.toBeNull();
    // expect((event as any).kind).toBe(10032);
    // // Parse SwapPair content; assert ≥1 pair where from.chain and to.chain
    // // are among { evm:base:31337, solana:devnet, mina:devnet } and asset
    // // fields match ASSET_CODE=USD / ASSET_SCALE=6.
  });

  // ---------------------------------------------------------------------
  // AC-5 — real NIP-59 gift-wrap: malformed chain-recipient → T00
  // ---------------------------------------------------------------------
  it('AC-5 [P1] malformed chain-recipient rumor sent through real BTP returns T00 (Story 12.9 AC-8)', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    // This test cannot exercise the SDK's public `streamSwap()` because
    // sender-side `validateChainAddress` rejects before packet send (by
    // design). The probe must construct a rumor with the invalid tag and
    // push it through the same BTP socket the sender uses.
    //
    // Task 2.6 GREEN work:
    //   1. Build a raw kind:20032 rumor with `chain-recipient` tag set to
    //      `MALFORMED_CHAIN_RECIPIENT`.
    //   2. NIP-59 gift-wrap it (kind:1059) to peer1's pubkey.
    //   3. Encode as ILP PREPARE payload and send via the live BTP socket.
    //   4. Assert the FULFILL response decrypts to a T00 error (swap-handler
    //      reject code INVALID_CHAIN_RECIPIENT).

    const millReturnedT00 = false;
    expect(
      millReturnedT00,
      'RED: Task 2.6 must build malformed-rumor probe with real BTP transport. ' +
        `Malformed chain-recipient tested: ${MALFORMED_CHAIN_RECIPIENT}`
    ).toBe(true);
  });

  // ---------------------------------------------------------------------
  // AC-6 — EVM settlement: closeChannel advances nonce + transferredAmount
  // ---------------------------------------------------------------------
  it('AC-6 [P1] buildSettlementTx() closeChannel submission advances participants[sender] state', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    // GREEN flow (paraphrased from story Task 2.7):
    //   1. Take last claim from the AC-3 streamSwap() result.
    //   2. const built = buildSettlementTx(claim);
    //   3. Sign + submit `built.rawTx` via viem sendRawTransaction to Anvil.
    //   4. await waitForTransactionReceipt(…)
    //   5. getParticipantInfo(channelId, sender).
    //   6. Expect nonce === BigInt(claim.nonce!)
    //      && transferredAmount === BigInt(claim.cumulativeAmount!).
    //
    // TokenNetwork address (asserted for config-drift guard):
    expect(TOKEN_NETWORK_ADDRESS).toBe(
      '0xCafac3dD18aC6c6e92c921884f9E4176737C052c'
    );

    const settlementSubmitted = false;
    expect(
      settlementSubmitted,
      'RED: Task 2.7 must wire buildSettlementTx → viem sendRawTransaction → ' +
        'getParticipantInfo assertion against Anvil'
    ).toBe(true);
  });
});
