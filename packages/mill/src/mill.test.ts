/**
 * ATDD RED-phase tests for `startMill()` (Story 12.7).
 *
 * These tests are INTENTIONALLY failing — they describe the behavior
 * `startMill()` must exhibit before Story 12.7's dev implementation begins.
 * Every `it.skip(...)` must be unskipped (and pass) as part of the GREEN phase
 * delivery of story 12.7 per `_bmad-output/implementation-artifacts/12-7-start-mill-scaffold.md`.
 *
 * Scenarios traced to test-design-epic-12.md section 2.7:
 *   - T-055 (P0)  startMill boots, registers swap handler on kind 1059,
 *                 health endpoint responds.                                (AC-4, AC-8, AC-10, R-015)
 *   - T-056 (P0)  startMill derives wallet keys from mnemonic for all
 *                 configured chains.                                        (AC-4 phase 3)
 *   - T-057 (P1)  startMill publishes kind:10032 with swapPairs.            (AC-6)
 *   - T-058 (P1)  Missing mnemonic / secretKey-only path → clear error.    (AC-4 phase 3)
 *   - T-060 (P2)  Graceful shutdown: stop() idempotent, releases state.    (AC-12)
 *
 * Additional AC coverage in this file:
 *   - AC-2 config validation (every INVALID_CONFIG branch)
 *   - AC-3 MillInstance.health() snapshot shape
 *   - AC-5 buildSignerAddresses — multi-chain, missing key, unknown family
 *   - AC-7 ownership-based connector cleanup
 *   - AC-13 no self-cycle with the barrel `./index.js`
 *
 * Red-phase compliance: each top-level describe is marked `describe(...)`.
 * When the dev team implements `startMill()`, they flip `.skip` → `.only` on one
 * describe at a time (classic red → green cycle) and remove `.skip` wholesale
 * once AC coverage is achieved.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect } from 'vitest';
import { encodeEventToToon } from '@toon-protocol/core';
import type { NostrEvent } from 'nostr-tools/pure';
import { generateSecretKey } from 'nostr-tools/pure';
import {
  wrapSwapPacketToToon,
  decryptFulfillClaim,
  generateSolanaKeypair,
  fromMnemonic,
  __streamSwapTesting,
} from '@toon-protocol/sdk';
import {
  createPaymentHandlerAdapter,
  createLogger,
} from '@toon-protocol/connector';

// NOTE: the following imports reference symbols that DO NOT YET EXIST.
// TypeScript will error on these lines until Story 12.7's dev work lands.
// This is the definition of TDD red phase.
//
// We use a type-only import guard so `pnpm --filter @toon-protocol/mill test`
// can still enumerate the skipped specs without the test file exploding at
// collection time. Once `mill.ts` is implemented, change these to real imports.

type StartMillFn = (config: unknown) => Promise<any>;
interface MillInstanceShape {
  identity: { pubkey: string; secretKey: Uint8Array };
  blsPort: number;
  millKeys: unknown;
  stop: () => Promise<void>;
  health: () => {
    status: 'ok' | 'starting' | 'stopping' | 'stopped';
    version: string;
    nodePubkey: string;
    swapPairsCount: number;
    chains: readonly string[];
    uptimeSec: number;
    inventory: Record<string, string>;
  };
  _handlerRegistry?: { get(kind: number): unknown };
  connector?: {
    _packetHandler?: (req: unknown) => Promise<unknown>;
    _calls?: string[];
  };
}

// Dynamic import so TS doesn't fail at collection time.
async function loadStartMill(): Promise<StartMillFn> {
  const mod = (await import('./mill.js')) as { startMill: StartMillFn };
  return mod.startMill;
}

async function loadMillStartError(): Promise<new (...a: any[]) => Error> {
  const mod = (await import('./errors.js')) as {
    MillStartError: new (...a: any[]) => Error;
  };
  return mod.MillStartError;
}

async function loadValidateConfig(): Promise<(config: unknown) => void> {
  const mod = (await import('./mill.js')) as {
    validateConfig: (config: unknown) => void;
  };
  return mod.validateConfig;
}

// ---------------------------------------------------------------------------
// Test fixtures — minimal-yet-valid MillConfig shape.
// Every field here is a placeholder. Dev implementation is expected to
// fail fast on any missing piece; these fixtures describe the HAPPY shape.
// ---------------------------------------------------------------------------

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function fakeConnector(): any {
  const calls: string[] = [];
  const conn: any = {
    _calls: calls,
    // Captures the local-delivery callback startMill wires via setPacketHandler
    // so tests can drive an inbound ILP packet through the real dispatch path.
    _packetHandler: undefined as
      | ((req: {
          amount: string;
          destination: string;
          data: string;
        }) => Promise<unknown>)
      | undefined,
    setPacketHandler(handler: any) {
      calls.push('setPacketHandler');
      conn._packetHandler = handler;
    },
    close: async () => {
      calls.push('close');
    },
    // Minimum EmbeddableConnectorLike surface startMill needs. Flesh out if
    // the real interface turns out to be larger (see `@toon-protocol/core`).
    send: async () => ({ ok: true }),
  };
  return conn;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    mnemonic: VALID_MNEMONIC,
    connector: fakeConnector(),
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        rate: '1.0',
      },
    ],
    chains: ['evm'] as const,
    channels: {
      'evm:8453': [
        {
          channelId: 'chan-1',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { 'evm:8453': 1_000_000n },
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    ...overrides,
  };
}

// ===========================================================================
// T-055 / AC-4 / AC-8 / AC-10: boot, handler registration, health
// ===========================================================================

describe('T-055 startMill boots and registers swap handler (AC-4, AC-8, AC-10)', () => {
  it('[P0] returns MillInstance with identity, millKeys, health(), stop()', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      expect(instance).toBeDefined();
      expect(typeof instance.stop).toBe('function');
      expect(typeof instance.health).toBe('function');
      expect(instance.identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(instance.identity.secretKey).toBeInstanceOf(Uint8Array);
      expect(instance.identity.secretKey.length).toBe(32);
      expect(instance.millKeys).toBeDefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P0] registers the swap handler on kind 1059 (gift-wrap) — R-015 mitigation', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      // _handlerRegistry is an @internal test-only hook per AC-10.
      const registry = instance._handlerRegistry;
      expect(
        registry,
        'MillInstance must expose _handlerRegistry for AC-10'
      ).toBeDefined();
      const handler = registry!.get(1059);
      expect(typeof handler).toBe('function');
      // Default storage handler (kind:1) must NOT be the swap handler.
      const kind1 = registry!.get(1);
      expect(kind1).not.toBe(handler);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] health() snapshot has status:"ok" and expected shape after boot (AC-8)', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      const h = instance.health();
      expect(h.status).toBe('ok');
      expect(h.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(h.nodePubkey).toBe(instance.identity.pubkey);
      expect(h.swapPairsCount).toBe(1);
      expect(h.chains).toEqual(['evm']);
      expect(typeof h.uptimeSec).toBe('number');
      expect(h.uptimeSec).toBeGreaterThanOrEqual(0);
      // Inventory serialized as bigint → decimal string (MAX_SAFE_INTEGER guard).
      expect(h.inventory['evm:8453']).toBe('1000000');
    } finally {
      await instance.stop();
    }
  });
});

// ===========================================================================
// Story 50.3 (SOL settlement leg, AC#4): inbound kind:1059 dispatch
//
// Regression guard for the swap-handler DISPATCH bug — an inbound gift-wrap
// (kind:1059) ILP packet destined for Mill's OWN address MUST be routed to the
// registered swap handler, NOT fall through to the connector's auto-fulfill
// "Local delivery - auto-fulfill stub" (which the sender's streamSwap FULFILL
// decoder cannot JSON.parse → FULFILL_DECODE_FAILED).
// ===========================================================================

describe('Story 50.3 inbound kind:1059 dispatches to swap handler (AC#4)', () => {
  it('[P0] wires the registry to the connector via setPacketHandler', async () => {
    const startMill = await loadStartMill();
    const cfg = baseConfig();
    const instance = (await startMill(cfg)) as MillInstanceShape;
    try {
      const conn = cfg.connector as ReturnType<typeof fakeConnector>;
      expect(conn._calls).toContain('setPacketHandler');
      expect(typeof conn._packetHandler).toBe('function');
    } finally {
      await instance.stop();
    }
  });

  it('[P0] routes an inbound kind:1059 packet to the swap handler (NOT the local-delivery stub)', async () => {
    const startMill = await loadStartMill();
    const cfg = baseConfig();
    const instance = (await startMill(cfg)) as MillInstanceShape;
    try {
      const conn = cfg.connector as ReturnType<typeof fakeConnector>;
      const handlePacket = conn._packetHandler!;
      expect(handlePacket).toBeDefined();

      // A kind:1059-shaped event whose content is NOT a real gift wrap. The swap
      // handler will reject it with its OWN code ('F01' Invalid gift wrap), which
      // PROVES dispatch reached the swap handler rather than the connector's
      // default auto-fulfill stub.
      const fakeGiftWrap: NostrEvent = {
        id: '0'.repeat(64),
        pubkey: '1'.repeat(64),
        created_at: Math.floor(Date.now() / 1000),
        kind: 1059,
        tags: [],
        content: 'not a real gift wrap',
        sig: '0'.repeat(128),
      };
      const data = Buffer.from(encodeEventToToon(fakeGiftWrap)).toString(
        'base64'
      );

      const res = (await handlePacket({
        amount: '1000000',
        destination: 'g.townhouse.mill',
        data,
      })) as {
        accept: boolean;
        code?: string;
        data?: string;
        rejectReason?: { code: string; message: string };
      };

      // Reached the swap handler → swap-specific reject, NOT a local-delivery ACK.
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F01');
      // The connector adapter requires a semantic rejectReason (else collapses to F99).
      expect(res.rejectReason).toBeDefined();
      // Must NOT be the auto-fulfill stub literal.
      if (res.data) {
        expect(Buffer.from(res.data, 'base64').toString('utf8')).not.toContain(
          'Local delivery'
        );
      }
    } finally {
      await instance.stop();
    }
  });

  it('[P0] returns swap-handler FULFILL metadata as base64-JSON data (not a stub string)', async () => {
    // Verifies the metadata→data serialization: when the registered kind:1059
    // handler accepts with metadata, the wired packet handler MUST surface that
    // metadata as base64-JSON FULFILL `data` (the shape streamSwap decodes).
    const startMill = await loadStartMill();
    const cfg = baseConfig();
    const instance = (await startMill(cfg)) as MillInstanceShape;
    try {
      const registry = instance._handlerRegistry as unknown as {
        on(kind: number, handler: (ctx: unknown) => Promise<unknown>): void;
      };
      // Swap out the kind:1059 handler with a stub that accepts + emits metadata,
      // mirroring createSwapHandler's `ctx.accept({ claim, ... })` shape.
      const claim = { claim: 'BASE64CLAIM', claimId: 'abc', chain: 'solana' };
      registry.on(1059, async (ctx: any) => ctx.accept(claim));

      const conn = cfg.connector as ReturnType<typeof fakeConnector>;
      const handlePacket = conn._packetHandler!;

      const evt: NostrEvent = {
        id: '0'.repeat(64),
        pubkey: '1'.repeat(64),
        created_at: Math.floor(Date.now() / 1000),
        kind: 1059,
        tags: [],
        content: 'x',
        sig: '0'.repeat(128),
      };
      const data = Buffer.from(encodeEventToToon(evt)).toString('base64');

      const res = (await handlePacket({
        amount: '1000000',
        destination: 'g.townhouse.mill',
        data,
      })) as { accept: boolean; data?: string };

      expect(res.accept).toBe(true);
      expect(typeof res.data).toBe('string');
      const decoded = JSON.parse(
        Buffer.from(res.data as string, 'base64').toString('utf8')
      );
      expect(decoded).toMatchObject(claim);
    } finally {
      await instance.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Story 50.3 AC#4 — END-TO-END FULFILL-DATA CONTRACT (SOL leg).
  //
  // The single most load-bearing assertion for the SOL settlement gate: an
  // inbound REAL kind:1059 gift-wrap swap (built by the SDK's own
  // `wrapSwapPacketToToon`) dispatched to Mill's REAL `createSwapHandler` +
  // `MultiChainClaimIssuer` + Solana signer MUST produce a FULFILL whose
  // `data`, after passing through the REAL connector
  // (`createPaymentHandlerAdapter` → `convertLocalDeliveryResponse`
  // re-encode/decode) and the client-side base64 re-encode, round-trips
  // through `streamSwap`'s OWN `decodeFulfillMetadata` decoder AND
  // `decryptFulfillClaim` to a NON-EMPTY signed claim.
  //
  // This locks the mill-handler ↔ sdk-streamSwap serialization contract:
  // any future drift in the metadata→base64-JSON shape, the connector
  // adapter's `validateResponseData` canonical-base64 gate, or the
  // settlement-context field set fails HERE rather than only in the live
  // Docker+Akash gate. Mirrors the wire hops in
  // `packages/mill/tests/e2e/helpers/build-live-sender.ts` (FULFILL
  // `ilpResult.data.toString('base64')`) and the client's
  // `BtpRuntimeClient._sendIlpPacketWithClaimOnce` (`toBase64(response.data)`).
  it('[P0] inbound kind:1059 SOL swap → FULFILL data round-trips through streamSwap decoder to a non-empty claim', async () => {
    const startMill = await loadStartMill();

    // Sender + SOL payout identities (the sender's chain-recipient).
    const senderSecretKey = generateSecretKey();
    const solRecipient = generateSolanaKeypair().publicKey; // base58 32-byte

    // A valid base58 32-byte Solana channelId so streamSwap's per-chain
    // `decodeFulfillMetadata(data, 'solana:devnet')` accepts the channelId
    // (length-only checks would pass too, but we exercise the strict path).
    const solChannelId = generateSolanaKeypair().publicKey;

    const SOL_CHAIN = 'solana:devnet';
    const pair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
      to: { assetCode: 'USDC', assetScale: 6, chain: SOL_CHAIN },
      rate: '1.0',
    };

    const cfg = baseConfig({
      swapPairs: [pair],
      chains: ['evm', 'solana'] as const,
      channels: {
        [SOL_CHAIN]: [
          {
            channelId: solChannelId,
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        ],
      },
      inventory: { [SOL_CHAIN]: 1_000_000n },
    });
    const instance = (await startMill(cfg)) as MillInstanceShape & {
      identity: { pubkey: string };
    };

    try {
      // Build a REAL gift-wrapped swap PREPARE via the SDK using streamSwap's
      // own rumor builder so the rumor tags (swap-from/to, chain-recipient)
      // match exactly what streamSwap emits on the wire.
      const sourceAmount = 1_000_000n;
      const rumor = __streamSwapTesting.buildSwapRumor({
        senderPubkey: '', // overwritten by getPublicKey inside the wrap
        pair,
        sourceAmount,
        packetIndex: 1,
        totalPackets: 1,
        nonce: new Uint8Array(16),
        createdAt: Math.floor(Date.now() / 1000),
        chainRecipient: solRecipient,
      });

      const wrapped = wrapSwapPacketToToon({
        rumor,
        senderSecretKey,
        recipientPubkey: instance.identity.pubkey,
        destination: 'g.townhouse.mill',
        amount: sourceAmount,
      });
      // `wrapped.ilpPrepare.data` is already base64 of the TOON gift-wrap —
      // exactly the `request.data` shape Mill's handlePacket receives.
      const requestData = wrapped.ilpPrepare.data;

      // 1) Drive Mill's REAL packet handler (real createSwapHandler +
      //    MultiChainClaimIssuer + Solana signer).
      const handlePacket = (cfg.connector as ReturnType<typeof fakeConnector>)
        ._packetHandler!;
      const millResult = (await handlePacket({
        amount: sourceAmount.toString(),
        destination: 'g.townhouse.mill',
        data: requestData,
      })) as {
        accept: boolean;
        data?: string;
        code?: string;
        rejectReason?: { code: string; message: string };
      };

      // The swap MUST be accepted (provisioned SOL channel + inventory +
      // signer). A reject here is the real "claims=0" gate failure.
      expect(
        millResult.accept,
        `swap handler rejected: code=${millResult.code} reason=${JSON.stringify(
          millResult.rejectReason
        )}`
      ).toBe(true);
      expect(typeof millResult.data).toBe('string');

      // 2) Pass Mill's response through the REAL connector
      //    PaymentHandlerAdapter (what ConnectorNode.setPacketHandler wraps
      //    the handler with) → `{ fulfill: { data } }`.
      const adapter = createPaymentHandlerAdapter(
        async () => millResult as never,
        createLogger('mill-test-fulfill-roundtrip', 'error') as never
      );
      const adapterOut = (await adapter({
        destination: 'g.townhouse.mill',
        amount: sourceAmount.toString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        data: requestData,
      } as never)) as { fulfill?: { data?: string }; reject?: unknown };

      // The adapter MUST NOT drop the data (validateResponseData canonical
      // base64 gate) and MUST take the fulfill branch.
      expect(
        adapterOut.reject,
        'connector adapter rejected the FULFILL'
      ).toBeUndefined();
      expect(adapterOut.fulfill).toBeDefined();
      expect(typeof adapterOut.fulfill!.data).toBe('string');

      // 3) `convertLocalDeliveryResponse` ships the FULFILL wire bytes as
      //    `Buffer.from(fulfill.data, 'base64')` — the raw JSON bytes.
      const fulfillWireBytes = Buffer.from(adapterOut.fulfill!.data!, 'base64');
      expect(fulfillWireBytes.length).toBeGreaterThan(0);

      // 4) The client (BtpRuntimeClient / build-live-sender) re-encodes the
      //    FULFILL packet bytes as `toBase64(response.data)` before handing
      //    them to streamSwap.
      const streamSwapInputData = fulfillWireBytes.toString('base64');

      // 5) streamSwap's OWN decoder — the canonical contract surface.
      const meta = __streamSwapTesting.decodeFulfillMetadata(
        streamSwapInputData,
        SOL_CHAIN
      );
      expect(meta.recipient).toBe(solRecipient);
      expect(meta.channelId).toBe(solChannelId);
      expect(meta.nonce).toBeDefined();
      expect(meta.cumulativeAmount).toBe(sourceAmount.toString());
      expect(meta.millSignerAddress).toBeDefined();

      // 6) Decrypt the NIP-44 claim exactly as streamSwap does and assert a
      //    NON-EMPTY signed SOL claim (the AC#4 settlement payload).
      const claimBytes = decryptFulfillClaim({
        ciphertext: new Uint8Array(Buffer.from(meta.claim, 'base64')),
        ephemeralPubkey: meta.ephemeralPubkey,
        recipientSecretKey: senderSecretKey,
      });
      expect(claimBytes).toBeInstanceOf(Uint8Array);
      expect(claimBytes.length).toBeGreaterThan(0);
    } finally {
      await instance.stop();
    }
  });
});

// ===========================================================================
// T-056 / AC-4 phase 3: wallet-key derivation
// ===========================================================================

describe('T-056 startMill derives Mill keys from mnemonic for configured chains', () => {
  it('[P0] derives EVM key (0x-prefixed address) when chains:["evm"]', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      const keys = instance.millKeys as { evm?: { address: string } };
      expect(keys.evm).toBeDefined();
      expect(keys.evm!.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] derives Solana + EVM keys for multi-chain config', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(
      baseConfig({
        swapPairs: [
          {
            from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            rate: '1.0',
          },
          {
            from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:mainnet' },
            rate: '1.0',
          },
        ],
        chains: ['evm', 'solana'] as const,
        channels: {
          'evm:8453': [
            {
              channelId: 'c-evm',
              cumulativeAmount: 0n,
              nonce: 0n,
              updatedAt: 0,
            },
          ],
          'solana:mainnet': [
            {
              channelId: 'c-sol',
              cumulativeAmount: 0n,
              nonce: 0n,
              updatedAt: 0,
            },
          ],
        },
        inventory: { 'evm:8453': 1_000_000n, 'solana:mainnet': 1_000_000n },
      })
    )) as MillInstanceShape;
    try {
      const keys = instance.millKeys as {
        evm?: { address: string };
        solana?: { publicKey: Uint8Array };
      };
      expect(keys.evm).toBeDefined();
      expect(keys.solana).toBeDefined();
      expect(keys.solana!.publicKey.length).toBeGreaterThan(0);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] Nostr identity pubkey ≠ Mill EVM signer address (D12-011 separation)', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      const keys = instance.millKeys as { evm?: { address: string } };
      expect(keys.evm!.address.toLowerCase()).not.toBe(
        '0x' + instance.identity.pubkey.slice(0, 40)
      );
    } finally {
      await instance.stop();
    }
  });
});

// ===========================================================================
// T-057 / AC-6: kind:10032 publication with swapPairs
// ===========================================================================

describe('T-057 startMill publishes kind:10032 with swapPairs (AC-6)', () => {
  it('[P1] builds IlpPeerInfo event whose content.swapPairs matches config.swapPairs entry-for-entry', async () => {
    // This test requires injection of a spy-able event-builder OR a capture hook.
    // Dev implementation is expected to expose enough seam to assert:
    //   - exactly ONE event built at boot
    //   - content.swapPairs.length === config.swapPairs.length
    //   - deep-equal on each {from,to,rate} entry
    const startMill = await loadStartMill();
    const pairs = [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        rate: '1.0',
      },
    ];
    // TODO(dev): provide an `__testHooks.onPeerInfoBuilt` config field so
    // this test can capture the signed event without reaching into implementation
    // internals. See AC-6 note in 12-7 story.
    const captured: unknown[] = [];
    const instance = (await startMill({
      ...baseConfig({ swapPairs: pairs }),
      __testHooks: { onPeerInfoBuilt: (e: unknown) => captured.push(e) },
    })) as MillInstanceShape;
    try {
      expect(captured.length).toBe(1);
      const evt = captured[0] as { content: string };
      const content = JSON.parse(evt.content) as { swapPairs: typeof pairs };
      expect(content.swapPairs.length).toBe(1);
      expect(content.swapPairs[0]).toEqual(pairs[0]);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] published kind:10032 pubkey == MILL_MNEMONIC-derived pubkey (swap gift-wrap recipient — issues #80/#88)', async () => {
    // A streamSwap caller discovers the mill via its kind:10032 IlpPeerInfo and
    // gift-wraps the swap request to the advertised `pubkey` (== `millPubkey`).
    // That recipient key MUST be the MILL_MNEMONIC-derived identity (the same
    // key used as the swap-handler `recipientSecretKey`), NOT a
    // NODE_NOSTR_SECRET_KEY-derived node identity. Encrypting to the wrong key
    // produces F01/F00 "Invalid gift wrap".
    const startMill = await loadStartMill();
    const expectedPubkey = fromMnemonic(VALID_MNEMONIC).pubkey;
    let built: unknown;
    const instance = (await startMill({
      ...baseConfig(),
      __testHooks: { onPeerInfoBuilt: (e: unknown) => (built = e) },
    })) as MillInstanceShape;
    try {
      // The published kind:10032 event's author pubkey is the swap recipient.
      const evt = built as { pubkey: string; content: string };
      expect(evt.pubkey).toBe(expectedPubkey);
      // And it matches the instance's nostr identity (single key, no town/node split).
      expect(instance.identity.pubkey).toBe(expectedPubkey);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] publication failure does NOT abort startup (fire-and-forget)', async () => {
    const startMill = await loadStartMill();
    // Config with knownPeers pointing at unreachable host — publish must
    // WARN-log and still resolve a working MillInstance.
    const instance = (await startMill(
      baseConfig({
        knownPeers: [
          { ilpAddress: 'g.unreachable', btpUrl: 'http://127.0.0.1:1' },
        ],
      })
    )) as MillInstanceShape;
    try {
      expect(instance.health().status).toBe('ok');
    } finally {
      await instance.stop();
    }
  });
});

// ===========================================================================
// T-058 / AC-4 phase 3: missing-mnemonic path
// ===========================================================================

describe('T-058 startMill fails fast on missing mnemonic (AC-2, AC-4 phase 3)', () => {
  it('[P1] throws INVALID_CONFIG when neither mnemonic nor secretKey provided', async () => {
    const startMill = await loadStartMill();
    const MillStartError = await loadMillStartError();
    const cfg = baseConfig();
    delete (cfg as Record<string, unknown>)['mnemonic'];
    await expect(startMill(cfg)).rejects.toBeInstanceOf(MillStartError);
    await expect(startMill(cfg)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('[P1] throws INVALID_CONFIG when both mnemonic AND secretKey provided', async () => {
    const startMill = await loadStartMill();
    const MillStartError = await loadMillStartError();
    const cfg = baseConfig({ secretKey: new Uint8Array(32) });
    await expect(startMill(cfg)).rejects.toBeInstanceOf(MillStartError);
    await expect(startMill(cfg)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('[P1] throws MILL_REQUIRES_MNEMONIC when only secretKey is supplied (D12-011)', async () => {
    const startMill = await loadStartMill();
    const cfg = baseConfig({ secretKey: new Uint8Array(32) });
    delete (cfg as Record<string, unknown>)['mnemonic'];
    await expect(startMill(cfg)).rejects.toMatchObject({
      code: 'MILL_REQUIRES_MNEMONIC',
    });
  });
});

// ===========================================================================
// AC-2: exhaustive config-validation branches
// ===========================================================================

describe('AC-2 MillConfig validation (every INVALID_CONFIG branch)', () => {
  it('[P1] rejects empty swapPairs array', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ swapPairs: [] }))
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('[P1] rejects missing channel for a referenced pair.to.chain', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ channels: {} as Record<string, never> }))
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('[P1] rejects missing inventory entry for a referenced pair.to.chain', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ inventory: {} as Record<string, never> }))
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('[P2] rejects secretKey that is not 32 bytes', async () => {
    const startMill = await loadStartMill();
    const cfg = baseConfig({ secretKey: new Uint8Array(31) });
    delete (cfg as Record<string, unknown>)['mnemonic'];
    await expect(startMill(cfg)).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_CONFIG|MILL_REQUIRES_MNEMONIC/),
    });
  });

  it('[P2] rejects empty relayUrls array', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ relayUrls: [] }))
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('[P2] rejects both connector AND connectorUrl present', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ connectorUrl: 'http://localhost:3000' }))
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});

// ===========================================================================
// AC-5: buildSignerAddresses (expose as a named export for unit testability)
// ===========================================================================

describe('AC-5 buildSignerAddresses helper', () => {
  it('[P1] maps evm:* pairs to the derived EVM address', async () => {
    const mod = (await import('./mill.js')) as any;
    const map = mod.buildSignerAddresses(
      [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
          to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
          rate: '1.0',
        },
      ],
      { evm: { address: '0xabc0000000000000000000000000000000000001' } }
    );
    expect(map['evm:8453']).toBe('0xabc0000000000000000000000000000000000001');
  });

  it('[P1] throws MISSING_KEY when pair targets evm but no EVM key was derived', async () => {
    const mod = (await import('./mill.js')) as any;
    expect(() =>
      mod.buildSignerAddresses(
        [
          {
            from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            rate: '1.0',
          },
        ],
        {}
      )
    ).toThrow(/MISSING_KEY/);
  });

  it('[P1] throws UNSUPPORTED_CHAIN_FAMILY for unknown chain prefix', async () => {
    const mod = (await import('./mill.js')) as any;
    expect(() =>
      mod.buildSignerAddresses(
        [
          {
            from: { assetCode: 'XRP', assetScale: 6, chain: 'ripple:mainnet' },
            to: { assetCode: 'XRP', assetScale: 6, chain: 'ripple:mainnet' },
            rate: '1.0',
          },
        ],
        {}
      )
    ).toThrow(/UNSUPPORTED_CHAIN_FAMILY/);
  });
});

// ===========================================================================
// AC-7: ownership-based connector cleanup
// ===========================================================================

describe('AC-7 connector ownership — caller-supplied connector NOT closed by stop()', () => {
  it('[P1] stop() does NOT call close() on a caller-supplied connector', async () => {
    const startMill = await loadStartMill();
    const connector = fakeConnector();
    const instance = (await startMill(
      baseConfig({ connector })
    )) as MillInstanceShape;
    await instance.stop();
    expect(connector._calls).not.toContain('close');
  });
});

// ===========================================================================
// T-060 / AC-12: graceful shutdown is idempotent
// ===========================================================================

describe('T-060 stop() is idempotent and releases resources (AC-12)', () => {
  it('[P2] calling stop() twice resolves without error', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    await instance.stop();
    await expect(instance.stop()).resolves.toBeUndefined();
    expect(instance.health().status).toBe('stopped');
  });

  it('[P2] BLS server port is no longer accepting connections after stop()', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(
      baseConfig({ blsPort: 0 })
    )) as MillInstanceShape;
    const port = instance.blsPort;
    await instance.stop();
    // Fetch should error with ECONNREFUSED (or AbortError-via-timeout).
    await expect(
      fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      })
    ).rejects.toBeDefined();
  });
});

// ===========================================================================
// Review Pass #3 security fixes
// ===========================================================================

describe('Pass-3 security: passphrase rejection (cryptographic correctness)', () => {
  it('[P1] rejects non-empty passphrase with INVALID_CONFIG (SDK fromMnemonic does not support passphrases — derivation would split)', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ passphrase: 'secret-pw' }))
    ).rejects.toMatchObject({
      name: 'MillStartError',
      code: 'INVALID_CONFIG',
    });
  });

  it('[P2] empty-string passphrase is treated as "no passphrase" and accepted', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(
      baseConfig({ passphrase: '' })
    )) as MillInstanceShape;
    expect(instance.health().status).toBe('ok');
    await instance.stop();
  });
});

// ===========================================================================
// Story 12.8 AC-11: auto-create embedded ConnectorNode when none supplied
// ===========================================================================

describe('Story 12.8 AC-11 — auto-create embedded ConnectorNode', () => {
  it('[P1] startMill() with no connector + btpServerPort auto-wires ConnectorNode; mill.connector is live', async () => {
    const startMill = await loadStartMill();
    // Use a high, likely-free port to avoid collision.
    const port = 24000 + Math.floor(Math.random() * 1000);
    // Omit the `connector` key entirely — exercising the auto-wire branch.
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      btpServerPort: port,
    })) as MillInstanceShape & {
      connector?: { nodeId?: string };
    };
    try {
      expect(instance.connector).toBeDefined();
      // Distinct from operator-supplied fake (which has `_calls`).
      expect(
        (instance.connector as { _calls?: unknown })._calls
      ).toBeUndefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P1] stop() cleanly tears down the auto-created connector (ownership transfer)', async () => {
    const startMill = await loadStartMill();
    const port = 25000 + Math.floor(Math.random() * 1000);
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      btpServerPort: port,
    })) as MillInstanceShape;
    // Idempotent stop — second call is a no-op.
    await instance.stop();
    await instance.stop();
    expect(instance.health().status).toBe('stopped');
  });
});

// ===========================================================================
// Story 12.8 AC-13: publisher injection + rejecting-publisher tolerance
// ===========================================================================

// ===========================================================================
// Embedded-with-parent connector mode (connectorUrl wires a parent peer)
// ===========================================================================

describe('Embedded-with-parent connector mode (connectorUrl)', () => {
  it('[P1] when connectorUrl is set, mill auto-creates an embedded ConnectorNode with parent peer + self-route', async () => {
    const startMill = await loadStartMill();
    const port = 26000 + Math.floor(Math.random() * 1000);
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      connectorUrl: 'ws://parent.invalid:3000',
      parentPeerId: 'apex',
      parentAuthToken: '',
      ilpAddress: 'g.townhouse.mill.test',
      btpServerPort: port,
    })) as MillInstanceShape & {
      connector?: {
        nodeId?: string;
        config?: {
          peers?: { id: string; url: string; authToken: string }[];
          routes?: { prefix: string; nextHop: string; priority?: number }[];
          settlement?: { connectorFeePercentage?: number };
        };
      };
    };
    try {
      expect(instance.connector).toBeDefined();
      // Inspect the live ConnectorNode config — it stores its own config under
      // `.config` for introspection.
      const c = (
        instance.connector as unknown as {
          _config: {
            peers: { id: string; url: string; authToken: string }[];
            routes: { prefix: string; nextHop: string; priority?: number }[];
            settlement?: { connectorFeePercentage?: number };
            nodeId: string;
          };
        }
      )._config;
      // Parent peer wired with the supplied URL.
      expect(c.peers).toHaveLength(1);
      expect(c.peers[0]!.id).toBe('apex');
      expect(c.peers[0]!.url).toBe('ws://parent.invalid:3000');
      expect(c.peers[0]!.authToken).toBe('');
      // Routes: self-route on ilpAddress + default-up-to-parent on `g.`.
      const selfRoute = c.routes.find(
        (r) => r.prefix === 'g.townhouse.mill.test'
      );
      expect(selfRoute).toBeDefined();
      expect(selfRoute!.nextHop).toBe(c.nodeId);
      const parentRoute = c.routes.find(
        (r) => r.prefix === 'g' && r.nextHop === 'apex'
      );
      expect(parentRoute).toBeDefined();
      // Belt-and-braces zero fees on the child connector.
      expect(c.settlement?.connectorFeePercentage).toBe(0);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] custom parentPeerId + nodeId override applied to the embedded connector', async () => {
    const startMill = await loadStartMill();
    const port = 27000 + Math.floor(Math.random() * 1000);
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      connectorUrl: 'ws://parent.invalid:3000',
      parentPeerId: 'my-parent',
      nodeId: 'my-mill-id',
      btpServerPort: port,
    })) as MillInstanceShape & { connector?: unknown };
    try {
      const c = (
        instance.connector as unknown as {
          _config: {
            nodeId: string;
            peers: { id: string }[];
            routes: { prefix: string; nextHop: string }[];
          };
        }
      )._config;
      expect(c.nodeId).toBe('my-mill-id');
      expect(c.peers[0]!.id).toBe('my-parent');
      expect(
        c.routes.some((r) => r.prefix === 'g' && r.nextHop === 'my-parent')
      ).toBe(true);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] standalone mode (neither connector nor connectorUrl) still wires an empty-peer connector when btpServerPort set', async () => {
    const startMill = await loadStartMill();
    const port = 28000 + Math.floor(Math.random() * 1000);
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      btpServerPort: port,
    })) as MillInstanceShape & { connector?: unknown };
    try {
      const c = (
        instance.connector as unknown as {
          _config: {
            peers: unknown[];
            routes: unknown[];
          };
        }
      )._config;
      expect(c.peers).toEqual([]);
      expect(c.routes).toEqual([]);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] passes chainProviders through to the embedded ConnectorNode when set', async () => {
    const startMill = await loadStartMill();
    const port = 29000 + Math.floor(Math.random() * 1000);
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const providers = [
      {
        chainType: 'evm' as const,
        chainId: 'evm:31337',
        rpcUrl: 'http://localhost:8545',
        registryAddress: '0x1111111111111111111111111111111111111111',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        // keyId omitted → mill defaults it to identity-derived hex.
      },
    ];
    const instance = (await startMill({
      ...withoutConnector,
      connectorUrl: 'ws://parent.invalid:3000',
      btpServerPort: port,
      chainProviders: providers,
    })) as MillInstanceShape & { connector?: unknown };
    try {
      const c = (
        instance.connector as unknown as {
          _config: {
            chainProviders?: readonly {
              chainType: string;
              chainId: string;
              rpcUrl: string;
              registryAddress: string;
              tokenAddress: string;
              keyId: string;
            }[];
          };
        }
      )._config;
      expect(c.chainProviders).toBeDefined();
      expect(c.chainProviders!).toHaveLength(1);
      const entry = c.chainProviders![0]!;
      expect(entry.chainType).toBe('evm');
      expect(entry.chainId).toBe('evm:31337');
      expect(entry.rpcUrl).toBe('http://localhost:8545');
      expect(entry.registryAddress).toBe(
        '0x1111111111111111111111111111111111111111'
      );
      expect(entry.tokenAddress).toBe(
        '0x2222222222222222222222222222222222222222'
      );
      // keyId defaulted to identity.secretKey hex (0x + 64 chars).
      expect(entry.keyId).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] omits chainProviders when MillConfig.chainProviders is unset', async () => {
    const startMill = await loadStartMill();
    const port = 30000 + Math.floor(Math.random() * 1000);
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      connectorUrl: 'ws://parent.invalid:3000',
      btpServerPort: port,
    })) as MillInstanceShape & { connector?: unknown };
    try {
      const c = (
        instance.connector as unknown as {
          _config: { chainProviders?: unknown };
        }
      )._config;
      expect(c.chainProviders).toBeUndefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P1] rejects chainProviders entries missing tokenAddress at validateConfig', async () => {
    const startMill = await loadStartMill();
    const MillStartError = await loadMillStartError();
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const bad = [
      {
        chainType: 'evm' as const,
        chainId: 'evm:31337',
        rpcUrl: 'http://localhost:8545',
        registryAddress: '0x1111111111111111111111111111111111111111',
        // tokenAddress intentionally missing
      },
    ];
    await expect(
      startMill({
        ...withoutConnector,
        connectorUrl: 'ws://parent.invalid:3000',
        btpServerPort: 31000 + Math.floor(Math.random() * 1000),
        chainProviders: bad as unknown,
      })
    ).rejects.toBeInstanceOf(MillStartError);
  });

  it('[P1] passes a Solana chainProviders entry through to the embedded ConnectorNode', async () => {
    const startMill = await loadStartMill();
    const port = 31500 + Math.floor(Math.random() * 500);
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const providers = [
      {
        chainType: 'solana' as const,
        chainId: 'solana:devnet',
        rpcUrl: 'http://localhost:8899',
        wsUrl: 'ws://localhost:8900',
        programId: 'Foo1111111111111111111111111111111111111111',
        tokenMint: 'Mint111111111111111111111111111111111111111',
        cluster: 'devnet',
        // keyId omitted → mill defaults it.
      },
    ];
    const instance = (await startMill({
      ...withoutConnector,
      connectorUrl: 'ws://parent.invalid:3000',
      btpServerPort: port,
      chainProviders: providers,
    })) as MillInstanceShape & { connector?: unknown };
    try {
      const c = (
        instance.connector as unknown as {
          _config: {
            chainProviders?: readonly Record<string, unknown>[];
          };
        }
      )._config;
      expect(c.chainProviders).toBeDefined();
      expect(c.chainProviders!).toHaveLength(1);
      const entry = c.chainProviders![0]!;
      expect(entry['chainType']).toBe('solana');
      expect(entry['chainId']).toBe('solana:devnet');
      expect(entry['programId']).toBe(
        'Foo1111111111111111111111111111111111111111'
      );
      expect(entry['wsUrl']).toBe('ws://localhost:8900');
      expect(entry['tokenMint']).toBe(
        'Mint111111111111111111111111111111111111111'
      );
      // keyId defaulted to identity-derived hex.
      expect(entry['keyId']).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] passes a Mina chainProviders entry through to the embedded ConnectorNode', async () => {
    const startMill = await loadStartMill();
    const port = 32000 + Math.floor(Math.random() * 500);
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const providers = [
      {
        chainType: 'mina' as const,
        chainId: 'mina:devnet',
        graphqlUrl: 'http://localhost:8080/graphql',
        zkAppAddress: 'B62qtestzkappaddressxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        network: 'devnet',
        // keyId omitted → mill defaults it (optional on the connector contract).
      },
    ];
    const instance = (await startMill({
      ...withoutConnector,
      connectorUrl: 'ws://parent.invalid:3000',
      btpServerPort: port,
      chainProviders: providers,
    })) as MillInstanceShape & { connector?: unknown };
    try {
      const c = (
        instance.connector as unknown as {
          _config: {
            chainProviders?: readonly Record<string, unknown>[];
          };
        }
      )._config;
      expect(c.chainProviders).toBeDefined();
      expect(c.chainProviders!).toHaveLength(1);
      const entry = c.chainProviders![0]!;
      expect(entry['chainType']).toBe('mina');
      expect(entry['chainId']).toBe('mina:devnet');
      expect(entry['graphqlUrl']).toBe('http://localhost:8080/graphql');
      expect(entry['zkAppAddress']).toBe(
        'B62qtestzkappaddressxxxxxxxxxxxxxxxxxxxxxxxxxxx'
      );
      // Mill defaults keyId even though Mina treats it as optional.
      expect(entry['keyId']).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] rejects a Solana chainProviders entry missing programId', async () => {
    const startMill = await loadStartMill();
    const MillStartError = await loadMillStartError();
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const bad = [
      {
        chainType: 'solana' as const,
        chainId: 'solana:devnet',
        rpcUrl: 'http://localhost:8899',
        // programId intentionally missing
      },
    ];
    await expect(
      startMill({
        ...withoutConnector,
        connectorUrl: 'ws://parent.invalid:3000',
        btpServerPort: 32500 + Math.floor(Math.random() * 300),
        chainProviders: bad as unknown,
      })
    ).rejects.toBeInstanceOf(MillStartError);
  });

  it('[P1] rejects a Mina chainProviders entry missing zkAppAddress', async () => {
    const startMill = await loadStartMill();
    const MillStartError = await loadMillStartError();
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const bad = [
      {
        chainType: 'mina' as const,
        chainId: 'mina:devnet',
        graphqlUrl: 'http://localhost:8080/graphql',
        // zkAppAddress intentionally missing
      },
    ];
    await expect(
      startMill({
        ...withoutConnector,
        connectorUrl: 'ws://parent.invalid:3000',
        btpServerPort: 32800 + Math.floor(Math.random() * 200),
        chainProviders: bad as unknown,
      })
    ).rejects.toBeInstanceOf(MillStartError);
  });

  it('[P1] rejects a chainProviders entry with an unknown chainType', async () => {
    const startMill = await loadStartMill();
    const MillStartError = await loadMillStartError();
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const bad = [
      {
        chainType: 'bitcoin',
        chainId: 'bitcoin:mainnet',
      },
    ];
    await expect(
      startMill({
        ...withoutConnector,
        connectorUrl: 'ws://parent.invalid:3000',
        btpServerPort: 33000 + Math.floor(Math.random() * 200),
        chainProviders: bad as unknown,
      })
    ).rejects.toBeInstanceOf(MillStartError);
  });

  // Regression for #152: a stale mill image applied the EVM required-field set
  // (chainType/chainId/rpcUrl/registryAddress/tokenAddress) to EVERY
  // chainProviders entry, so a legitimate solana/mina entry — which omits
  // registryAddress/tokenAddress — was rejected at boot
  // ("...registryAddress MUST be a non-empty string") and the container
  // crash-looped. A chainProviders array mixing one evm + one solana + one
  // mina entry (each carrying only its per-chainType required fields) MUST
  // pass validateConfig.
  //
  // This asserts against validateConfig DIRECTLY rather than booting a mill:
  // a real boot would register the mina provider with the embedded connector
  // and kick off an o1js zkApp pre-compile, which corrupts o1js' global
  // context when it overlaps the single-mina pass-through test above (o1js
  // forbids concurrent async proving) and crashes the whole vitest worker.
  // The validator is pure/synchronous, so it exercises the exact per-chainType
  // field-set logic this issue is about without any of that runtime weight.
  it('[P1] validateConfig accepts a mixed evm+solana+mina chainProviders array (regression #152)', async () => {
    const validateConfig = await loadValidateConfig();
    const providers = [
      {
        chainType: 'evm' as const,
        chainId: 'evm:31337',
        rpcUrl: 'http://localhost:8545',
        registryAddress: '0x1111111111111111111111111111111111111111',
        tokenAddress: '0x2222222222222222222222222222222222222222',
      },
      {
        // Index [1]: the entry the stale image rejected on registryAddress.
        chainType: 'solana' as const,
        chainId: 'solana:devnet',
        rpcUrl: 'http://localhost:8899',
        programId: 'Foo1111111111111111111111111111111111111111',
      },
      {
        chainType: 'mina' as const,
        chainId: 'mina:devnet',
        graphqlUrl: 'http://localhost:8080/graphql',
        zkAppAddress: 'B62qtestzkappaddressxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      },
    ];
    expect(() =>
      validateConfig(baseConfig({ chainProviders: providers }))
    ).not.toThrow();
  });
});

describe('Story 12.8 AC-13 — publisher injection', () => {
  it('[P1] injected publisher.publish() is called with a kind:10032 event', async () => {
    const startMill = await loadStartMill();
    const captured: unknown[] = [];
    const publisher = {
      publish: async (event: unknown): Promise<void> => {
        captured.push(event);
      },
    };
    const instance = (await startMill(
      baseConfig({ publisher })
    )) as MillInstanceShape;
    try {
      // Publish fires after resolve; await one macrotask tick.
      const deadline = Date.now() + 2_000;
      while (captured.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(captured.length).toBe(1);
      const ev = captured[0] as { kind: number; tags: string[][] };
      expect(ev.kind).toBe(10032);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] rejecting publisher does NOT fail startMill() (flaky-relay tolerance, R-8N2)', async () => {
    const startMill = await loadStartMill();
    const publisher = {
      publish: async (): Promise<void> => {
        throw new Error('simulated relay outage');
      },
    };
    // Boot MUST resolve; the per-relay failure is logged, not thrown.
    const instance = (await startMill(
      baseConfig({ publisher })
    )) as MillInstanceShape;
    expect(instance.health().status).toBe('ok');
    await instance.stop();
  });
});

// ===========================================================================
// Story 50.4 — kind:10032 ILP advertisement via the embedded connector
//
// A TOON relay is pay-to-write (its WS EVENT handler rejects unpaid writes),
// so the legacy SimplePool publish is silently dropped. When a connector and
// `peerInfoIlpDestination` are present, Mill must instead route the
// TOON-encoded kind:10032 to that ILP address via an ILP PREPARE.
// ===========================================================================

describe('Story 50.4 — kind:10032 ILP advertisement (peerInfoIlpDestination)', () => {
  // Fake connector that fulfills sendPacket and records each call. Operator-
  // supplied (config.connector), so startMill does NOT call .start() on it.
  function fulfillingConnector() {
    const calls: { destination: string; amount: string; data: string }[] = [];
    return {
      _calls: calls,
      close: async () => {},
      sendPacket: async (p: any) => {
        calls.push({
          destination: p.destination,
          amount: String(p.amount),
          data: Buffer.from(p.data).toString('base64'),
        });
        return { type: 'fulfill' as const };
      },
    };
  }

  it('[P1] routes the kind:10032 through the connector via ILP PREPARE to peerInfoIlpDestination', async () => {
    const startMill = await loadStartMill();
    const connector = fulfillingConnector();
    let built: any;
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      connector,
      peerInfoIlpDestination: 'g.townhouse',
      peerInfoPricePerByte: 0n,
      __testHooks: { onPeerInfoBuilt: (e: unknown) => (built = e) },
    } as any)) as MillInstanceShape;
    try {
      const deadline = Date.now() + 2_000;
      while (connector._calls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // The advertisement went out via ILP (sendPacket), not the Nostr WS path.
      expect(connector._calls.length).toBe(1);
      expect(connector._calls[0]!.destination).toBe('g.townhouse');
      // amount = toonBytes * 0n = 0 (pilot relays advertise FEE_PER_EVENT=0).
      expect(connector._calls[0]!.amount).toBe('0');
      expect(connector._calls[0]!.data.length).toBeGreaterThan(0);
      // The dispatched payload is the signed kind:10032 peer-info event.
      expect(built.kind).toBe(10032);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] ILP path takes priority over the relayUrls Nostr publish', async () => {
    const startMill = await loadStartMill();
    const connector = fulfillingConnector();
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      connector,
      // A relayUrls is still present; with a destination set the ILP path wins.
      relayUrls: ['ws://localhost:0'],
      peerInfoIlpDestination: 'g.townhouse',
    } as any)) as MillInstanceShape;
    try {
      const deadline = Date.now() + 2_000;
      while (connector._calls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(connector._calls.length).toBe(1);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] a rejecting relay does NOT fail Mill boot but logs a loud error (AC #2)', async () => {
    const startMill = await loadStartMill();
    const connector = {
      close: async () => {},
      sendPacket: async () => ({
        type: 'reject' as const,
        code: 'F02',
        message: 'no route to destination',
      }),
    };
    const errors: { msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (msg: string, fields?: Record<string, unknown>) =>
        errors.push({ msg, fields }),
    };
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      connector,
      logger,
      peerInfoIlpDestination: 'g.townhouse',
      // Collapse the retry window so the exhausted-retry path completes fast.
      __testHooks: { peerInfoPublishRetry: { maxAttempts: 2, delayMs: 5 } },
    } as any)) as MillInstanceShape;
    // Boot resolves immediately regardless of the (fire-and-forget) publish.
    expect(instance.health().status).toBe('ok');
    // Let the bounded retry loop exhaust + log its terminal error (AC #2:
    // failure is surfaced loudly rather than swallowed).
    const deadline = Date.now() + 2_000;
    while (
      !errors.some((e) => e.msg === 'mill.peerInfo.publish_failed') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const failLog = errors.find(
      (e) => e.msg === 'mill.peerInfo.publish_failed'
    );
    expect(failLog).toBeDefined();
    expect(failLog!.fields?.['destination']).toBe('g.townhouse');
    await instance.stop();
  });

  it('[P1] falls back to the Nostr WS publish when no peerInfoIlpDestination is set', async () => {
    const startMill = await loadStartMill();
    const connector = fulfillingConnector();
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      connector,
      relayUrls: ['ws://localhost:0'],
      // peerInfoIlpDestination intentionally omitted → legacy WS path.
    } as any)) as MillInstanceShape;
    try {
      // No ILP advertisement was attempted (connector.sendPacket untouched).
      await new Promise((r) => setTimeout(r, 100));
      expect(connector._calls.length).toBe(0);
      expect(instance.health().status).toBe('ok');
    } finally {
      await instance.stop();
    }
  });
});
