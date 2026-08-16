/**
 * Family-dispatching {@link ChannelOnChainReader} (issue #141).
 *
 * #113 introduced the on-chain reader seam and #138 built the inventory
 * reconciler on top of it, but the only implementation was the EVM one — so
 * a Solana or Mina maker booked every issued claim as liability that nothing
 * would ever observe being redeemed, and ratcheted its free capacity to zero.
 * This module composes one reader per chain family behind the single
 * `ChannelOnChainReader` both consumers already take:
 *
 * - `SwapChannelState`'s #113 rebind precondition (`onChainReader`), and
 * - `SwapInventoryReconciler`'s recycle pass (`reader`).
 *
 * One dispatcher fixes both.
 *
 * ## Per-family status
 *
 * | family    | reader                              | why |
 * | --------- | ----------------------------------- | --- |
 * | `evm:*`   | `createEvmChannelOnChainReader`     | `RollingSwapChannel.channels(bytes32).cumulativePaid` is a plain on-chain word. |
 * | `solana:*`| `createSolanaChannelOnChainReader`  | The channel PDA carries a plain, program-enforced-monotone `transferred_amount_{a,b}` per participant. |
 * | `mina:*`  | **none — refuses** (see below)      | The paid amount is not on chain: it is hidden inside a salted Poseidon commitment. |
 *
 * ## Why Mina is deliberately left unrecycled
 *
 * The Mina `PaymentChannel` zkApp
 * (`toon-protocol/connector`, `packages/mina-zkapp/src/PaymentChannel.ts`)
 * publishes exactly eight `Field` state words:
 * `channelHash, balanceCommitment, nonceField, channelState, depositTotal,
 * closedAtSlot, settlementTimeout, tokenId_`. The per-claim balances live
 * ONLY inside `balanceCommitment = Poseidon(balanceA, balanceB, salt)` —
 * `claimFromChannel` asserts that hash and then writes nothing but the
 * commitment and the nonce, by design ("on-chain observers see only the
 * updated Poseidon commitment hash and nonce"); the `salt` is 16 random
 * bytes minted per packet. So no amount is recoverable from account state,
 * and the connector itself does not try: its Mina settlement path tracks
 * cumulative transferred off-chain in `PerPacketClaimService`, and its
 * crash-recovery branch for Mina explicitly resets the cumulative to `0n`
 * because the chain cannot tell it.
 *
 * The readable alternatives are all approximations we refuse to ship:
 * `nonceField` is a claim COUNTER, not an amount; `depositTotal` is the
 * channel's capacity ceiling, so crediting it would return more than was
 * ever paid; and `channelState === SETTLED` says the channel drained without
 * saying to whom or how much. Every one of them can OVERSTATE the watermark,
 * and an overstated watermark both over-recycles inventory and approves a
 * #113 rebind that strips an unredeemed claim from its rightful recipient.
 * Refusing to serve is the safe failure; over-crediting is not. So a `mina:*`
 * read throws {@link MINA_UNREADABLE_REASON} and both consumers fail closed —
 * a Mina maker's capacity stays blocked and visibly explained rather than
 * silently invented.
 */

import type { ChannelOnChainReader } from './channel-state.js';
import {
  createEvmChannelOnChainReader,
  type EvmChannelReaderProvider,
} from './evm-channel-reader.js';
import {
  createSolanaChannelOnChainReader,
  type SolanaChannelReaderProvider,
} from './solana-channel-reader.js';

/**
 * The refusal a `mina:*` on-chain read fails with. Stated as chain fact, not
 * as a missing-config hint: no operator setting can make this readable.
 */
export const MINA_UNREADABLE_REASON =
  "Mina channels expose no on-chain cumulative-paid watermark: the zkApp's balances live only inside a salted Poseidon balanceCommitment, so the redeemed amount cannot be read from chain state. Capacity on this chain stays blocked rather than recycled from a guess (nonceField is a counter, depositTotal is the capacity ceiling — crediting either would over-credit).";

export interface ChannelOnChainReaderProviders {
  evm?: readonly EvmChannelReaderProvider[];
  solana?: readonly SolanaChannelReaderProvider[];
}

/** One readable family: its chain-key prefix, its reader, and its display name. */
interface ReaderFamily {
  prefix: string;
  label: string;
  reader: ChannelOnChainReader;
}

/** Any per-channel read: they all carry the `chain` the dispatch keys on. */
type ChannelRead = (params: {
  assetCode: string;
  chain: string;
  channelId: string;
}) => Promise<unknown>;

/**
 * Every callable this reader exposes, own or inherited (minus `Object`'s).
 * Walking the prototype chain keeps the dispatch working for class-based
 * readers, not just the object literals the two factories return today.
 */
function readerCapabilities(reader: ChannelOnChainReader): Set<string> {
  const names = new Set<string>();
  const bag = reader as unknown as Record<string, unknown>;
  let cursor: object | null = reader;
  while (cursor && cursor !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(cursor)) {
      if (key === 'constructor') continue;
      if (typeof bag[key] !== 'function') continue;
      names.add(key);
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return names;
}

/**
 * Compose per-family readers into one dispatching reader, or `undefined` when
 * no family has a reader at all.
 *
 * `undefined` is meaningful: it leaves `SwapChannelState` on its pre-#113
 * "sticky forever" behavior and reports `reconciler.enabled: false` on the
 * operator surface, which is the honest signal for a maker (e.g. a Mina-only
 * one) whose redemptions genuinely cannot be observed. Returning a reader that
 * answers nothing would instead make the admin surface claim "the chain-truth
 * reconciler recycles it" while nothing ever does.
 *
 * ## Every capability is forwarded, not enumerated
 *
 * `ChannelOnChainReader` grows OPTIONAL capabilities over time (swap#142 added
 * `getFundingPosition`, an atomic `{ cumulativePaid, deposit }` read, EVM-only,
 * backing `POST /admin/inventory/deposit`). A dispatcher that returned a fixed
 * object literal would silently DROP any capability it did not name — the
 * deposit route would answer `503 funding_unreadable` on every chain including
 * EVM, failing closed but with nothing on the surface explaining why, and the
 * next optional capability would be dropped the same way.
 *
 * So the dispatch is built from the union of the families' actual callables:
 * one dispatching method per capability any family implements, routed by chain
 * prefix. A capability a family's reader does NOT implement throws for that
 * family's chains, which is the same fail-closed answer the caller would get
 * from a reader that omitted it.
 */
export function composeChannelOnChainReaders(readers: {
  evm?: ChannelOnChainReader;
  solana?: ChannelOnChainReader;
}): ChannelOnChainReader | undefined {
  const families: ReaderFamily[] = [];
  if (readers.evm) {
    families.push({ prefix: 'evm:', label: 'EVM', reader: readers.evm });
  }
  if (readers.solana) {
    families.push({
      prefix: 'solana:',
      label: 'Solana',
      reader: readers.solana,
    });
  }
  if (families.length === 0) return undefined;

  const capabilities = new Set<string>();
  for (const family of families) {
    for (const name of readerCapabilities(family.reader)) {
      capabilities.add(name);
    }
  }

  const dispatcher: Record<string, ChannelRead> = {};
  for (const capability of capabilities) {
    dispatcher[capability] = async (params) => {
      const chain = params.chain;
      const family = families.find((f) => chain.startsWith(f.prefix));
      if (family) {
        const method = (family.reader as unknown as Record<string, unknown>)[
          capability
        ];
        if (typeof method !== 'function') {
          throw new Error(
            `chain '${chain}': the ${family.label} channel reader has no '${capability}' capability`
          );
        }
        return (method as ChannelRead).call(family.reader, params);
      }
      if (chain.startsWith('mina:')) {
        throw new Error(`chain '${chain}': ${MINA_UNREADABLE_REASON}`);
      }
      // A family that HAS a reader implementation but no configured provider
      // (e.g. an `evm:*` chain on a Solana-only maker) gets the actionable
      // "not configured" message; anything else is an unknown family.
      if (chain.startsWith('evm:')) {
        throw new Error(
          `No EVM chain provider configured for chain '${chain}'`
        );
      }
      if (chain.startsWith('solana:')) {
        throw new Error(
          `No Solana chain provider configured for chain '${chain}'`
        );
      }
      throw new Error(
        `No on-chain channel reader exists for chain '${chain}' (unknown chain family)`
      );
    };
  }
  if (!capabilities.has('getCumulativePaid')) {
    throw new Error(
      'composeChannelOnChainReaders: no family reader implements getCumulativePaid'
    );
  }
  return dispatcher as unknown as ChannelOnChainReader;
}

/**
 * Build the composed reader from `SwapNodeConfig.chainProviders`-shaped
 * inputs, or `undefined` when NO family with a working reader is configured.
 * See {@link composeChannelOnChainReaders} for the dispatch semantics.
 */
export function createChannelOnChainReader(
  providers: ChannelOnChainReaderProviders
): ChannelOnChainReader | undefined {
  const evm = providers.evm ?? [];
  const solana = providers.solana ?? [];
  return composeChannelOnChainReaders({
    ...(evm.length > 0 && { evm: createEvmChannelOnChainReader(evm) }),
    ...(solana.length > 0 && {
      solana: createSolanaChannelOnChainReader(solana),
    }),
  });
}
