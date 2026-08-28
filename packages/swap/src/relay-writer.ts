/**
 * The write half of the swap client: one signed Nostr event → one paid
 * packet to the relay's route (`g.toon.relay` on the devnet) → the relay's
 * `POST /write`. This is the only place the swap touches a connector, and it
 * touches it as an ordinary paying client: `@toon-protocol/client`'s
 * `ToonClient` opens (or adopts) the channel with the relay's connector,
 * attaches the covering claim, seals the envelope, and hands back the app's
 * HTTP answer inside the FULFILL.
 *
 * The seam is {@link PaidSender} — `ToonClient` satisfies it, and a unit test
 * satisfies it with a fake. A relay answer is a **result**, never a throw:
 * the relay refusing an event (bad signature, 4xx) and the path refusing the
 * packet (no route, unpaid) are both things a party must account for, not
 * crash on — a maker that cannot publish an advance must remember that it
 * still owes one.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type {
  ChainKind,
  SendOptions,
  SendRequest,
  SendResult,
  ToonClientConfig,
} from '@toon-protocol/client';
import { JsonFileChannelStore, ToonClient } from '@toon-protocol/client';
import type { ChannelStore } from '@toon-protocol/client';

/** What `ToonClient.send` looks like from here. */
export interface PaidSender {
  send(
    destination: string,
    request?: SendRequest,
    options?: SendOptions
  ): Promise<SendResult>;
}

export interface RelayWriteAccepted {
  ok: true;
  eventId: string;
  /** The relay's HTTP status inside the sealed answer (2xx). */
  status: number;
  /** What the relay said (its JSON body), for logs. */
  body?: unknown;
}

export interface RelayWriteRefused {
  ok: false;
  eventId: string;
  /** `relay` — the app answered non-2xx; `path` — the packet never got there. */
  refusedBy: 'relay' | 'path';
  /** HTTP status (relay) or ILP code (path). */
  code: string;
  message: string;
  /** Whether the same event might be accepted if resent unchanged. */
  retry: boolean;
}

export type RelayWriteResult = RelayWriteAccepted | RelayWriteRefused;

export interface RelayWriter {
  readonly destination: string;
  publish(event: NostrEvent): Promise<RelayWriteResult>;
}

export interface RelayWriterConfig {
  sender: PaidSender;
  /** The ILP address of the route that terminates at the relay's `POST /write`. */
  destination: string;
  timeoutMs?: number;
  logger?: {
    warn?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
}

/** Wrap a paying client as a relay writer. */
export function createRelayWriter(config: RelayWriterConfig): RelayWriter {
  const { sender, destination } = config;
  return {
    destination,
    async publish(event) {
      let result: SendResult;
      try {
        result = await sender.send(
          destination,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: { event },
          },
          config.timeoutMs !== undefined
            ? { timeoutMs: config.timeoutMs }
            : undefined
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        config.logger?.warn?.('relay.write.threw', {
          eventId: event.id,
          err: message,
        });
        return {
          ok: false,
          eventId: event.id,
          refusedBy: 'path',
          code: 'EXCEPTION',
          message,
          retry: true,
        };
      }
      if (!result.fulfilled) {
        config.logger?.warn?.('relay.write.refused', {
          eventId: event.id,
          refusedBy: result.refusedBy,
          code: result.code,
          message: result.message,
        });
        return {
          ok: false,
          eventId: event.id,
          refusedBy: 'path',
          code: result.code,
          message: result.message,
          // T-codes are temporary by ILP convention; an F-code will not change on resend.
          retry: result.code.startsWith('T'),
        };
      }
      let body: unknown;
      try {
        body = result.json();
      } catch {
        body = undefined;
      }
      if (result.status < 200 || result.status >= 300) {
        const message =
          typeof body === 'object' &&
          body !== null &&
          typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : `relay answered HTTP ${result.status}`;
        config.logger?.warn?.('relay.write.rejected', {
          eventId: event.id,
          status: result.status,
          message,
        });
        return {
          ok: false,
          eventId: event.id,
          refusedBy: 'relay',
          code: String(result.status),
          message,
          retry: result.status >= 500,
        };
      }
      config.logger?.debug?.('relay.write.ok', {
        eventId: event.id,
        status: result.status,
      });
      return {
        ok: true,
        eventId: event.id,
        status: result.status,
        ...(body !== undefined && { body }),
      };
    },
  };
}

export interface RelayClientConfig {
  /** The relay connector's client edge, e.g. `https://proxy.relay.devnet.toonprotocol.dev/ilp`. */
  connectorUrl: string;
  /** Which chain this party pays the relay on. */
  chain: ChainKind;
  /** The chain key to pay with — explicit, never a mnemonic (ONE KEY: the swap derives its own). */
  evmPrivateKey?: string | Uint8Array;
  solanaSecretKey?: Uint8Array | string;
  rpcUrl?: string;
  /** Path to the client's channel-watermark file (fail-closed across restarts). */
  channelStore?: string;
  deposit?: bigint;
  autoOpenChannel?: boolean;
  transport?: ToonClientConfig['transport'];
  timeoutMs?: number;
  fetch?: typeof fetch;
  logger?: {
    info?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
  };
}

export interface RelayClient {
  client: ToonClient;
  sender: PaidSender;
  /** The channel with the relay's connector this client pays on. */
  channelId: string;
  close(): Promise<void>;
}

/**
 * Bring up a `ToonClient` against the relay's connector for paid writes.
 *
 * The client's claim watermark on that channel lives in `channelStore`. A
 * lost or stale file would restart the nonce below the connector's watermark
 * and every write would be refused as a replay (`F01`), so after connecting
 * the connector's own record (`POST /ilp/claim-state`) is adopted whenever
 * it is ahead — the connector holds those claims already; nothing is lost by
 * agreeing with it.
 */
export async function createRelayClient(
  config: RelayClientConfig
): Promise<RelayClient> {
  const store: ChannelStore | undefined =
    config.channelStore !== undefined
      ? new JsonFileChannelStore(config.channelStore)
      : undefined;
  const create = (): Promise<ToonClient> =>
    ToonClient.create({
      connector: config.connectorUrl,
      chain: config.chain,
      ...(config.evmPrivateKey !== undefined && {
        evmPrivateKey: config.evmPrivateKey,
      }),
      ...(config.solanaSecretKey !== undefined && {
        solanaSecretKey: config.solanaSecretKey,
      }),
      ...(config.rpcUrl !== undefined && { rpcUrl: config.rpcUrl }),
      ...(store !== undefined && { channelStore: store }),
      ...(config.deposit !== undefined && { deposit: config.deposit }),
      ...(config.autoOpenChannel !== undefined && {
        autoOpenChannel: config.autoOpenChannel,
      }),
      ...(config.transport !== undefined && { transport: config.transport }),
      ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
      ...(config.fetch !== undefined && { fetch: config.fetch }),
    });

  let client = await create();
  let channelId = await client.channel.ensure();
  if (store) {
    try {
      const [state] = await client.claimState([channelId]);
      if (state?.ok) {
        const local = store.load(channelId);
        const theirs = {
          nonce: state.nonce,
          cumulativeAmount: BigInt(state.cumulativeClaimed),
        };
        if (
          !local ||
          local.nonce < theirs.nonce ||
          local.cumulativeAmount < theirs.cumulativeAmount
        ) {
          store.save(channelId, {
            ...(local ?? {}),
            nonce: Math.max(local?.nonce ?? 0, theirs.nonce),
            cumulativeAmount:
              local && local.cumulativeAmount > theirs.cumulativeAmount
                ? local.cumulativeAmount
                : theirs.cumulativeAmount,
          });
          config.logger?.info?.('relay.channel.watermark_adopted', {
            channelId,
            local: local
              ? {
                  nonce: local.nonce,
                  cumulative: local.cumulativeAmount.toString(),
                }
              : null,
            connector: {
              nonce: theirs.nonce,
              cumulative: theirs.cumulativeAmount.toString(),
            },
          });
          // The client read the store at create(); rebuild it on the seeded record.
          await client.close();
          client = await create();
          channelId = await client.channel.ensure();
        }
      }
    } catch (err) {
      config.logger?.warn?.('relay.channel.claim_state_unavailable', {
        channelId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    client,
    sender: client,
    channelId,
    close: () => client.close(),
  };
}
