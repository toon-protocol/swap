/**
 * Story 12.8 — End-to-End Swap Flow Integration Tests
 *
 * In-process fixture topology (NOT Docker). See
 * `./helpers/fixture-topology.ts` for the peered-sender bridge:
 *   streamSwap() → gift-wrap (kind:1059) → in-process dispatch
 *     → real createSwapHandler + MultiChainClaimIssuer
 *     → signed claim → NIP-44 encrypted FULFILL → sender decrypts
 *     → buildSettlementTx() schema round-trip
 *
 * Source ACs: `_bmad-output/implementation-artifacts/12-8-e2e-swap-flow-integration-tests.md`
 * Source T-IDs: `_bmad-output/planning-artifacts/test-design-epic-12.md` §2.8
 *
 * Dev Agent Record (Story 12.8 yolo session 2):
 *   AC-1, AC-2, AC-2.6 (coexistence), AC-13 (rejecting publisher) — GREEN.
 *   AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-12 — documented blocker via
 *   `test.skip`: `MultiChainClaimIssuer.issueClaim()` passes the 32-byte
 *   Nostr `senderPubkey` to `EvmPaymentChannelSigner.signBalanceProof()`
 *   as the `recipient` argument; the signer rejects with
 *   `"EVM recipient must be 20 bytes, got 32"` (MillWalletError code
 *   `SIGNING_FAILED`) before a claim is ever issued. The swap handler maps
 *   this into an ILP `T00 Internal error` rejection back to the sender, so
 *   `streamSwap()` returns `state: 'failed', abortReason: 'all-rejected'`
 *   with zero claims.
 *
 *   Root cause: Story 12.4 (`packages/mill/src/claim-issuer.ts`) stores the
 *   Nostr sender pubkey into both `reservation.senderPubkey` AND
 *   `result.recipient`, but EVM balance-proof signing requires a 20-byte
 *   chain-specific recipient address. The protocol needs a sender→EVM-recipient
 *   binding (sender advertises their target-chain address in the rumor, OR
 *   the Mill exposes a per-sender settlement-recipient mapping).
 *
 *   Per the Story 12.8 Dev Notes ("If you find yourself editing 12.1..12.6
 *   source during this story, STOP. Either (a) the test is wrong, or (b)
 *   you've discovered a bug that deserves its own story. Don't silently
 *   patch."), the tests below are marked `it.skip` with a pointer to the
 *   blocker rather than silently papered over.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseIlpPeerInfo, buildIlpPeerInfoEvent } from '@toon-protocol/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import type { MillInstance } from '@toon-protocol/mill';

import {
  FIXTURE_MNEMONIC,
  ANVIL_CHAIN_ID,
  buildFixtureMill,
  buildFixtureSender,
  deriveFixtureConnectorEvmAddress,
  fixtureSwapPair,
  type FixtureSender,
} from './helpers/fixture-topology.js';

// ---------------------------------------------------------------------------
// AC-1 — Deterministic fixture topology
// ---------------------------------------------------------------------------

describe('AC-1 [P1] deterministic fixture topology (T-061 prerequisite)', () => {
  let mill: MillInstance;
  let sender: FixtureSender;

  beforeAll(async () => {
    mill = await buildFixtureMill();
    sender = await buildFixtureSender(mill, new Uint8Array(32).fill(1));
  });

  afterAll(async () => {
    await sender?.close?.();
    await mill?.stop?.();
  });

  it('AC-1.0 — fixture mnemonic is 12 words (BIP-39 shape)', () => {
    expect(FIXTURE_MNEMONIC.split(' ')).toHaveLength(12);
  });

  it('AC-1.1 — connector-side (account 1) EVM address ≠ Mill-side (account 2) EVM address (D12-011)', async () => {
    const account1Addr = await deriveFixtureConnectorEvmAddress();
    // Mill-side address is account 2 via deriveMillKeys default — exposed
    // on millKeys.evm.address. Normalize to lowercase for comparison
    // (startMill stores it lowercased in signerAddresses anyway).
    const account2Addr = mill.millKeys.evm?.address.toLowerCase();
    expect(account1Addr).toMatch(/^0x[0-9a-f]{40}$/);
    expect(account2Addr).toMatch(/^0x[0-9a-f]{40}$/);
    expect(account1Addr).not.toBe(account2Addr);
  });

  it('AC-1.2 — mill.identity.pubkey is a valid 32-byte Nostr x-only pubkey', () => {
    expect(mill.identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC-1.3 — /health responds status:"ok" within 2s', async () => {
    expect(mill.blsPort).toBeGreaterThan(0);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch(`http://127.0.0.1:${mill.blsPort}/health`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ok');
    } finally {
      clearTimeout(t);
    }
  });

  it('AC-1.4 — sender has distinct Nostr pubkey from Mill', () => {
    expect(sender.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(sender.publicKey).not.toBe(mill.identity.pubkey);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — kind:10032 publication round-trip (T-8C, covers AC-2 + AC-13)
// ---------------------------------------------------------------------------

describe('AC-2 [P1] kind:10032 publication round-trip + publisher injection (T-8C)', () => {
  it('AC-2.1/2/3/4/5 — mockPublisher captures exactly one kind:10032 event with swapPairs', async () => {
    const captured: unknown[] = [];
    const mockPublisher = {
      publish: async (event: unknown) => {
        captured.push(event);
      },
    };
    const mill = await buildFixtureMill({ publisher: mockPublisher });
    try {
      // Bound wait at 3s (AC-2.2). startMill() dispatches publish on next
      // microtask, so this usually completes in a few ms.
      const start = Date.now();
      while (captured.length === 0 && Date.now() - start < 3_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(captured.length).toBe(1);
      const ev = captured[0] as { kind: number };
      expect(ev.kind).toBe(10032);

      // AC-2.5: parseIlpPeerInfo round-trip asserts swapPairs deep-equal.
      const parsed = parseIlpPeerInfo(
        ev as Parameters<typeof parseIlpPeerInfo>[0],
      );
      expect(parsed.swapPairs).toEqual([fixtureSwapPair()]);
    } finally {
      await mill.stop();
    }
  });

  it('AC-2.6 — parseIlpPeerInfo round-trips an event without swapPairs (coexistence regression)', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const built = buildIlpPeerInfoEvent(
      {
        pubkey: pk,
        ilpAddress: 'g.test.peer',
        btpEndpoint: 'ws://localhost:0/town-peer',
        assetCode: 'USD',
        assetScale: 6,
        // swapPairs deliberately OMITTED (Town-style peer).
      },
      sk,
    );
    const parsed = parseIlpPeerInfo(built);
    expect(parsed.swapPairs).toBeUndefined();
  });

  it('AC-13.4 — rejecting publisher does NOT fail startMill() boot', async () => {
    const rejectingPublisher = {
      publish: async () => {
        throw new Error('simulated relay outage');
      },
    };
    // Boot MUST resolve (Promise.allSettled semantics per AC-13.3).
    const mill = await buildFixtureMill({ publisher: rejectingPublisher });
    try {
      expect(mill).toBeDefined();
      expect(mill.identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await mill.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3 through AC-8 — blocked on 12.4/12.5/12.6 schema drift
// ---------------------------------------------------------------------------
//
// Blocker documented in this file's header. The claim issuer emits
// `recipient: senderPubkey` (64-hex Nostr pubkey) but `decodeFulfillMetadata`
// validates `recipient` as an EVM address (`^0x[0-9a-f]{40}$`), so every
// FULFILL fails decode with FULFILL_DECODE_FAILED before the sender ever
// sees a CollectedClaim. Per the Story 12.8 Dev Notes ("If you find
// yourself editing 12.1/12.2/12.3/12.4/12.5/12.6 source during this story,
// STOP. Either (a) the test is wrong, or (b) you've discovered a bug that
// deserves its own story. Don't silently patch."), the tests below are
// marked `it.skip` with a pointer to the blocker rather than silently
// papering over it.

const SCHEMA_BLOCKER =
  '[BLOCKED — fixed in Story 12.9; re-enable is Story 12.8\'s job] 12.4 sender→recipient binding missing: claim-issuer passes 32-byte Nostr senderPubkey to EvmPaymentChannelSigner.signBalanceProof() as recipient; signer rejects with "EVM recipient must be 20 bytes, got 32" → MillWalletError(SIGNING_FAILED) → ILP T00 → streamSwap state=failed. Resolved by Story 12.9 (sender-provided chainRecipient threaded via kind:20032 chain-recipient tag).';

describe('AC-3 through AC-8 (blocked on schema drift)', () => {
  it.skip(`AC-3 — malformed kind:1059 → REJECT: ${SCHEMA_BLOCKER}`, () => undefined);
  it.skip(`AC-4.1 — 1-packet swap: ${SCHEMA_BLOCKER}`, () => undefined);
  it.skip(`AC-4.2 — 10-packet swap: ${SCHEMA_BLOCKER}`, () => undefined);
  it.skip(`AC-4.3 — rate-drift swap: ${SCHEMA_BLOCKER}`, () => undefined);
  it.skip(`AC-5 — replay protection: ${SCHEMA_BLOCKER}`, () => undefined);
  it.skip(`AC-6 — intermediary privacy: ${SCHEMA_BLOCKER}`, () => undefined);
  it.skip(`AC-7 — two-sender channel provisioning: ${SCHEMA_BLOCKER}`, () => undefined);
  it.skip(`AC-8 — streamSwap → buildSettlementTx schema round-trip: ${SCHEMA_BLOCKER}`, () => undefined);
  it.skip(`AC-12 — per-sender channel sticky binding (runs inside AC-7): ${SCHEMA_BLOCKER}`, () => undefined);

  // Sanity checks that do NOT depend on the blocked FULFILL decode path:
  it('AC-sanity — fixture Anvil chain id is 31337', () => {
    expect(ANVIL_CHAIN_ID).toBe(31337);
  });
});
