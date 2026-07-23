/**
 * Fixture topology helpers for Story 12.8 integration tests.
 *
 * GREEN-phase implementation:
 *   - `buildFixtureSwapNode()` boots an in-process swap node via `startSwapNode()`
 *     with an injected fake `EmbeddableConnectorLike` (we do NOT auto-wire
 *     a real `ConnectorNode` here — parallel tests would collide on BTP
 *     server ports, and the AC-11 auto-wire path is separately exercised
 *     by `swap-node.connector-boot.test.ts`'s dedicated auto-create suite).
 *   - `buildFixtureSender()` returns a `StreamSwapClient`-compatible
 *     handle whose `sendSwapPacket()` bridges directly into the swap node's
 *     internal `HandlerRegistry.dispatch()` for kind:1059 gift-wraps. This
 *     exercises the real `createSwapHandler` ↔ `MultiChainClaimIssuer` ↔
 *     `EvmPaymentChannelSigner` production code path end-to-end; the only
 *     piece we stub is the ILP/BTP transport (which is orthogonal to the
 *     swap-composition proof per the Story 12.8 Dev Notes).
 *
 * Design constraints (per 12-8 story Dev Notes):
 * - Helpers are PRIVATE to this package.
 * - No Docker. No BTP WebSocket.
 * - Fixture mnemonic is test-only and hardcoded.
 */

import {
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';

import {
  startSwapNode,
  deriveSwapNodeKeys,
  type SwapNodeInstance,
  type SwapNodeConfig,
  type Publisher,
} from '@toon-protocol/swap';
import type {
  HandlePacketAcceptResponse,
  HandlePacketRejectResponse,
  EmbeddableConnectorLike,
  SwapPair,
} from '@toon-protocol/core';
import { createHandlerContext } from '@toon-protocol/sdk';

/**
 * Deterministic 12-word BIP-39 mnemonic used by every Story 12.8
 * integration test.
 *
 * test-only mnemonic, DO NOT reuse.
 */
export const FIXTURE_MNEMONIC =
  'test test test test test test test test test test test junk';

/** Anvil dev chain id. */
export const ANVIL_CHAIN_ID = 31337;

/** Anvil JSON-RPC URL used by the opt-in AC-9 suite. */
export const ANVIL_URL = 'http://localhost:18545';

/**
 * Default USDC→ETH swap pair on Anvil.
 * Rate 0.0004: 1 USDC (1e6 micros, scale 6) → 0.0004 ETH (4e14 wei, scale 18).
 */
export function fixtureSwapPair(): SwapPair {
  return {
    from: { assetCode: 'USDC', assetScale: 6, chain: `evm:${ANVIL_CHAIN_ID}` },
    to: { assetCode: 'ETH', assetScale: 18, chain: `evm:${ANVIL_CHAIN_ID}` },
    rate: '0.0004',
  };
}

// ---------------------------------------------------------------------------
// Fake EmbeddableConnectorLike
// ---------------------------------------------------------------------------
//
// Minimum surface `startSwapNode()` requires of `config.connector`. The real
// ILP transport is bypassed — the sender calls `swap._handlerRegistry.dispatch()`
// directly (see `buildFixtureSender()`).

interface FakeConnector extends EmbeddableConnectorLike {
  _closed: boolean;
  close: () => Promise<void>;
}

function makeFakeConnector(): FakeConnector {
  const c: FakeConnector = {
    _closed: false,
    // --- EmbeddableConnectorLike ---
    sendPacket: async (_params) => ({
      type: 'reject',
      code: 'F02',
      message: 'No route (fixture connector)',
    }),
    registerPeer: async (_params) => undefined,
    removePeer: async (_peerId) => undefined,
    setPacketHandler: (_h) => undefined,
    // Close is called by swapNode.stop() when ownsConnector=true; here we don't
    // own it (we supply it explicitly), so this is only for test teardown.
    close: async () => {
      c._closed = true;
    },
  } as FakeConnector;
  return c;
}

// ---------------------------------------------------------------------------
// Fixture Sender (StreamSwapClient-compatible)
// ---------------------------------------------------------------------------

/** Captures each outbound PREPARE → response exchange (AC-5 replay test). */
export interface CapturedExchange {
  destination: string;
  amount: bigint;
  toonData: Uint8Array;
  response: { accepted: boolean; data?: string; code?: string; message?: string };
}

/** Opaque sender handle returned by `buildFixtureSender()`. */
export interface FixtureSender {
  /** Sender's Nostr x-only pubkey (32-byte hex). */
  readonly publicKey: string;
  /** Sender's secp256k1 secret key (32 bytes). */
  readonly secretKey: Uint8Array;
  /** StreamSwap-compatible client shim. */
  readonly client: {
    sendSwapPacket: (params: {
      destination: string;
      amount: bigint;
      toonData: Uint8Array;
      timeout?: number;
      claim?: unknown;
    }) => Promise<{
      accepted: boolean;
      data?: string;
      code?: string;
      message?: string;
    }>;
    getPublicKey: () => string;
  };
  /** Captured (destination, amount, toonData, response) per call — AC-5 replay support. */
  readonly exchanges: CapturedExchange[];
  /** Close the sender (no-op in the fixture topology; kept for API symmetry). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// buildFixtureSwapNode()
// ---------------------------------------------------------------------------

export interface BuildFixtureSwapNodeOptions {
  /** Override the default swapPairs (AC-4 rate-drift test uses this). */
  readonly swapPairs?: readonly SwapPair[];
  /** Inject a capturing publisher (AC-2). */
  readonly publisher?: Publisher;
  /** Override swap-node-side rate provider (AC-4.3; timestamped for swap#48). */
  readonly rateProvider?: SwapNodeConfig['rateProvider'];
  /** Maker staleness bound(s) — swap#48 staleness-reject tests. */
  readonly maxRateAge?: SwapNodeConfig['maxRateAge'];
  /** Provide multiple channels for AC-7 two-sender tests. */
  readonly channelCount?: number;
}

/**
 * Boot a swap node against the fixture topology.
 */
export async function buildFixtureSwapNode(
  options: BuildFixtureSwapNodeOptions = {},
): Promise<SwapNodeInstance> {
  const pairs: readonly SwapPair[] = options.swapPairs ?? [fixtureSwapPair()];
  const targetChain = pairs[0]!.to.chain;

  // Pre-provision channels (one per AC-7 sender).
  const channelCount = options.channelCount ?? 2;
  const channels = Array.from({ length: channelCount }, (_, i) => ({
    channelId:
      '0x' +
      String(i + 1).padStart(2, '0').repeat(32), // distinct 0x + 64-hex per channel
    cumulativeAmount: 0n,
    nonce: 0n,
    updatedAt: 0,
  }));

  const config: SwapNodeConfig = {
    mnemonic: FIXTURE_MNEMONIC,
    connector: makeFakeConnector(),
    swapPairs: pairs,
    chains: ['evm'],
    channels: { [targetChain]: channels },
    inventory: { [targetChain]: 10n ** 20n }, // 100 ETH in wei
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    // parseIlpPeerInfo rejects empty btpEndpoint, so advertise a test-only
    // placeholder. No real BTP socket is opened in the fixture topology.
    btpEndpoint: 'ws://localhost:0/fixture',
    ...(options.publisher && { publisher: options.publisher }),
    ...(options.rateProvider && { rateProvider: options.rateProvider }),
    ...(options.maxRateAge && { maxRateAge: options.maxRateAge }),
  };

  return startSwapNode(config);
}

// ---------------------------------------------------------------------------
// buildFixtureSender()
// ---------------------------------------------------------------------------

/**
 * Construct an in-process sender bridged to the given swap node's `HandlerRegistry`.
 *
 * The sender's `sendSwapPacket()` bypasses the real ILP/BTP transport and
 * invokes `swap._handlerRegistry.dispatch()` directly for kind:1059
 * gift-wraps. This exercises `createSwapHandler` + `MultiChainClaimIssuer` +
 * per-chain signers end-to-end — the full swap-composition pipeline this
 * story is chartered to prove — while keeping the test topology hermetic
 * (no BTP sockets, no port collisions).
 *
 * Caller supplies a unique `senderSeed` so AC-7 (two-sender) can distinguish
 * the two identities by pubkey.
 */
export async function buildFixtureSender(
  swapNode: SwapNodeInstance,
  senderSeed?: Uint8Array,
): Promise<FixtureSender> {
  const senderSecretKey =
    senderSeed && senderSeed.length === 32 ? senderSeed : generateSecretKey();
  const senderPubkey = getPublicKey(senderSecretKey);

  const registry = (swapNode as unknown as { _handlerRegistry?: unknown })
    ._handlerRegistry as {
    dispatch: (ctx: unknown) => Promise<
      HandlePacketAcceptResponse | HandlePacketRejectResponse
    >;
  } | undefined;

  if (!registry) {
    throw new Error(
      'Fixture: swapNode._handlerRegistry is not exposed; cannot bridge sender → handler',
    );
  }

  const exchanges: CapturedExchange[] = [];

  async function sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    timeout?: number;
    claim?: unknown;
  }): Promise<{
    accepted: boolean;
    data?: string;
    code?: string;
    message?: string;
  }> {
    // Build a HandlerContext that mimics what the real connector→node
    // pipeline produces for a kind:1059 gift-wrap packet. The swap handler
    // only reads `ctx.kind`, `ctx.amount`, `ctx.toon`, and `ctx.destination`
    // + the `accept()` / `reject()` methods.
    const toonBase64 = Buffer.from(params.toonData).toString('base64');
    const ctx = createHandlerContext({
      toon: toonBase64,
      meta: {
        // kind MUST be 1059 (gift-wrap); the handler rejects otherwise.
        kind: 1059,
        // pubkey here is the OUTER gift-wrap ephemeral pubkey; the swap
        // handler unwraps the seal to recover the real sender. The value
        // passed here doesn't affect the handler's behavior.
        pubkey: '0'.repeat(64),
        id: '0'.repeat(64),
        sig: '0'.repeat(128),
        rawBytes: params.toonData,
      },
      amount: params.amount,
      destination: params.destination,
      // Decoder is not invoked by the swap handler (it operates on raw
      // base64 TOON via unwrapSwapPacketFromToon); a no-op stub suffices.
      toonDecoder: () => {
        throw new Error('Fixture: toonDecoder should not be invoked by swap handler');
      },
    });

    const response = await registry!.dispatch(ctx as never);

    let shimmed: {
      accepted: boolean;
      data?: string;
      code?: string;
      message?: string;
    };
    if (response.accept) {
      // Handler returned { accept: true, metadata? } — shim into the
      // IlpSendResultLike shape `streamSwap()` expects: `data` is
      // base64-encoded JSON of the metadata map.
      const metadata =
        (response as HandlePacketAcceptResponse).metadata ?? {};
      const dataB64 = Buffer.from(JSON.stringify(metadata)).toString('base64');
      shimmed = { accepted: true, data: dataB64 };
    } else {
      const rej = response as HandlePacketRejectResponse & { data?: string };
      shimmed = {
        accepted: false,
        code: rej.code,
        message: rej.message,
        // Pass structured reject payloads (e.g. the swap#48 stale_rate
        // base64-JSON) through, mirroring the connector adapter's reject
        // path (`response.data` → ILP reject data).
        ...(rej.data !== undefined && { data: rej.data }),
      };
    }

    exchanges.push({
      destination: params.destination,
      amount: params.amount,
      toonData: params.toonData,
      response: shimmed,
    });

    return shimmed;
  }

  return {
    publicKey: senderPubkey,
    secretKey: senderSecretKey,
    client: {
      sendSwapPacket,
      getPublicKey: () => senderPubkey,
    },
    exchanges,
    close: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Fixture-topology derived addresses (AC-1.1)
// ---------------------------------------------------------------------------

/**
 * Derive the connector-side (BIP-44 account 1) EVM address from the fixture
 * mnemonic. Used by AC-1.1 to assert disjointness with the swap-node-side
 * (account 2) EVM address that `startSwapNode()` derives via `deriveSwapNodeKeys()`.
 */
export async function deriveFixtureConnectorEvmAddress(): Promise<string> {
  const keys = await deriveSwapNodeKeys({
    mnemonic: FIXTURE_MNEMONIC,
    chains: ['evm'],
    accountIndex: 1,
  });
  if (!keys.evm) {
    throw new Error('Fixture: EVM key derivation failed at account 1');
  }
  return keys.evm.address.toLowerCase();
}

