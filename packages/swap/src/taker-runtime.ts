/**
 * Assemble a {@link SwapTaker} from a config file: keys from the mnemonic,
 * a relay subscription for reads, a `ToonClient` against the relay's
 * connector for paid writes, the RPC-backed chain reader for verifying the
 * maker's claims, the JSON state file, and the own-gas redeemer.
 */

import { dirname, join } from 'node:path';
import { base58Encode } from '@toon-protocol/sdk';

import { deriveNostrIdentity } from './nostr-keys.js';
import { createRpcChannelSlotReader } from './received-claim.js';
import { createGasStationRedeemer } from './gas-station-redeem.js';
import { createRedeemer } from './redeem.js';
import type { SolanaSettler } from './redeem.js';
import { RelaySubscription } from './relay-subscription.js';
import { createRelayClient, createRelayWriter } from './relay-writer.js';
import type { RelayClient, RelayWriter } from './relay-writer.js';
import type { SwapNodeConfig, SwapNodeRelayConfig } from './swap-node.js';
import { DEFAULT_RELAY_DESTINATION } from './swap-node.js';
import { SwapTaker } from './swap-taker.js';
import type { SwapTakerConfig, SwapTakerLogger } from './swap-taker.js';
import { JsonFileTakerStateStore } from './taker-state.js';
import { deriveSwapNodeKeys } from './wallet.js';

export interface TakerRuntimeConfig {
  mnemonic: string;
  chains: SwapNodeConfig['chains'];
  chainProviders: readonly NonNullable<
    SwapNodeConfig['chainProviders']
  >[number][];
  relay: SwapNodeRelayConfig;
  /** JSON file for sessions and channel watermarks (default: `taker-state.json` beside the maker's `statePath`). */
  statePath: string;
  /** Skip the paying client — reads only (`orders`). */
  readOnly?: boolean;
  /** The gas station: the route to it (default `g.toon.relay.gas`) and its own connector (for the sealing key). */
  gasStation?: { destination?: string; connectorUrl?: string };
  logger?: SwapTakerLogger;
  answerTimeoutMs?: number;
  maxResends?: number;
}

export interface TakerRuntime {
  taker: SwapTaker;
  settler: SolanaSettler;
  nostrPubkey: string;
  addresses: { evm?: string; solana?: string };
  /** Resolves once the relay has replayed the inbox (and, after `listOrders`, the orders). */
  ready(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export async function createTakerRuntime(
  cfg: TakerRuntimeConfig
): Promise<TakerRuntime> {
  const logger = cfg.logger ?? {};
  const keys = await deriveSwapNodeKeys({
    mnemonic: cfg.mnemonic,
    chains: cfg.chains,
  });
  const nostr = deriveNostrIdentity({ mnemonic: cfg.mnemonic });
  const rpcUrls: Record<string, string> = {};
  for (const p of cfg.chainProviders) {
    if (p.chainType === 'evm' || p.chainType === 'solana')
      rpcUrls[p.chainId] = p.rpcUrl;
  }

  let client: RelayClient | undefined;
  let writer: RelayWriter;
  if (cfg.readOnly) {
    writer = {
      destination: cfg.relay.destination ?? DEFAULT_RELAY_DESTINATION,
      publish: async (e) => ({
        ok: false,
        eventId: e.id,
        refusedBy: 'path',
        code: 'READ_ONLY',
        message: 'this runtime was opened read-only',
        retry: false,
      }),
    };
  } else {
    const payChain =
      cfg.relay.payChain ??
      cfg.chains.find(
        (c): c is 'evm' | 'solana' => c === 'evm' || c === 'solana'
      ) ??
      'evm';
    const payRpc =
      cfg.relay.rpcUrl ??
      rpcUrls[
        cfg.chainProviders.find((p) => p.chainType === payChain)?.chainId ?? ''
      ];
    client = await createRelayClient({
      connectorUrl: cfg.relay.connectorUrl,
      chain: payChain,
      ...(payChain === 'evm' &&
        keys.evm && { evmPrivateKey: keys.evm.privateKey }),
      ...(payChain === 'solana' &&
        keys.solana && { solanaSecretKey: keys.solana.privateKey }),
      ...(payRpc !== undefined && { rpcUrl: payRpc }),
      channelStore:
        cfg.relay.channelStorePath ??
        join(dirname(cfg.statePath), 'relay-channels.json'),
      ...(cfg.relay.deposit !== undefined && { deposit: cfg.relay.deposit }),
      ...(cfg.relay.transport !== undefined && {
        transport: cfg.relay.transport,
      }),
      autoOpenChannel: true,
      logger,
    });
    writer = createRelayWriter({
      sender: client.sender,
      destination: cfg.relay.destination ?? DEFAULT_RELAY_DESTINATION,
      logger,
    });
  }

  const pending: { taker?: SwapTaker } = {};
  const subscription = new RelaySubscription({
    relayUrl: cfg.relay.readUrl,
    onEvent: (_id, event) => void pending.taker?.handleEvent(event),
    logger: (msg) => logger.debug?.('taker.relay', { msg }),
  });
  const redeemer = createRedeemer({
    keys,
    chainProviders: cfg.chainProviders,
    logger,
  });
  const gasStationRedeemer = client
    ? createGasStationRedeemer({
        sender: client.sender,
        ...(cfg.gasStation?.destination !== undefined && {
          destination: cfg.gasStation.destination,
        }),
        ...(cfg.gasStation?.connectorUrl !== undefined && {
          connectorUrl: cfg.gasStation.connectorUrl,
        }),
        keys,
        nostrSecretKey: nostr.secretKey,
        chainProviders: cfg.chainProviders,
        logger,
      })
    : undefined;
  const takerConfig: SwapTakerConfig = {
    nostr,
    keys,
    reader: subscription,
    writer,
    slotReader: createRpcChannelSlotReader({ rpcUrls }),
    chainProviders: cfg.chainProviders,
    store: new JsonFileTakerStateStore(cfg.statePath),
    redeemer,
    ...(gasStationRedeemer && { gasStationRedeemer }),
    logger,
    ...(cfg.answerTimeoutMs !== undefined && {
      answerTimeoutMs: cfg.answerTimeoutMs,
    }),
    ...(cfg.maxResends !== undefined && { maxResends: cfg.maxResends }),
  };
  const taker = new SwapTaker(takerConfig);
  pending.taker = taker;
  taker.start();

  return {
    taker,
    settler: redeemer,
    nostrPubkey: nostr.pubkey,
    addresses: {
      ...(keys.evm && { evm: keys.evm.address }),
      ...(keys.solana && { solana: base58Encode(keys.solana.publicKey) }),
    },
    async ready(timeoutMs = 15_000) {
      await subscription.waitForEose('inbox', timeoutMs);
    },
    async stop() {
      taker.stop();
      await client?.close();
    },
  };
}
