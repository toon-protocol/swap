/**
 * EVM leg-B channel provisioning — the maker opens and funds its
 * `TokenNetwork` channel with a taker, on demand.
 *
 * Leg B rides the fleet's ordinary `TokenNetwork` (connector
 * `packages/contracts/src/TokenNetwork.sol`), not a swap-specific contract.
 * A channel there has two declared participants, a deposit per participant,
 * a nonce/transferred watermark per participant, and `claimFromChannel`
 * pays the counterparty the delta immediately while checking the payer's
 * deposit covers the cumulative. That is what gives a taker a claim the
 * maker cannot retroactively void, and collateral it can read on chain —
 * the two properties `RollingSwapChannel`'s shared, recipient-per-claim
 * watermark could not give it.
 *
 * The channel id is derived from the sorted pair and the pair's epoch
 * (ADR 0059), so the maker computes it, opens the channel if the taker has
 * not already (a taker paying leg A to this maker's connector opens the very
 * same channel when the connector settles with the maker's key), and raises
 * its own `setTotalDeposit` whenever a claim would exceed what it holds.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const TOKEN_NETWORK_ABI = parseAbi([
  'function channelEpoch(address, address) view returns (uint256)',
  'function channels(bytes32) view returns (uint256 settlementTimeout, uint8 state, uint256 closedAt, uint256 openedAt, address participant1, address participant2)',
  'function participants(bytes32, address) view returns (uint256 deposit, uint256 nonce, uint256 transferredAmount)',
  'function openChannel(address participant2, uint256 settlementTimeout) returns (bytes32)',
  'function setTotalDeposit(bytes32 channelId, address participant, uint256 totalDeposit)',
  'function maxChannelDeposit() view returns (uint256)',
]);
const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

/** `TokenNetwork.MIN_SETTLEMENT_TIMEOUT` is 1 hour; a day mirrors the EVM floor elsewhere. */
export const DEFAULT_EVM_SETTLEMENT_TIMEOUT_SECONDS = 86_400n;

export function sortEvmParticipants(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/** ADR 0059: `keccak256(abi.encodePacked(min, max, channelEpoch[min][max]))`. */
export function deriveEvmChannelId(a: Address, b: Address, epoch: bigint): Hex {
  const [p1, p2] = sortEvmParticipants(getAddress(a), getAddress(b));
  return keccak256(encodePacked(['address', 'address', 'uint256'], [p1, p2, epoch]));
}

export interface EvmChannelSlot {
  channelId: Hex;
  /** 0 NonExistent, 1 Opened, 2 Closed, 3 Settled. */
  state: number;
  /** The maker's own participant record. */
  deposit: bigint;
  nonce: bigint;
  transferredAmount: bigint;
}

export interface EvmLegBChannelProvisionerConfig {
  rpcUrl: string;
  tokenNetworkAddress: string;
  tokenAddress: string;
  /** The maker's 32-byte secp256k1 key (BIP-44 index 2). Funds and signs. */
  makerPrivateKey: Uint8Array;
  /** Deposit placed in a fresh channel, and the minimum top-up, base units. */
  channelDeposit: bigint;
  settlementTimeoutSeconds?: bigint;
  logger?: {
    info?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
  };
}

export interface EnsuredEvmChannel {
  channelId: Hex;
  /** The maker's total deposit after this call. */
  deposit: bigint;
  opened: boolean;
  toppedUp: bigint;
  /** The maker's on-chain watermark — what a fresh channel-state entry starts from. */
  nonce: bigint;
  transferredAmount: bigint;
}

export interface EvmLegBChannelProvisioner {
  readonly makerAddress: Address;
  /** The channel id for `recipient` at the pair's current epoch (one chain read). */
  channelFor(recipient: string): Promise<Hex>;
  /** Read the maker's slot on the channel with `recipient`. */
  read(recipient: string): Promise<EvmChannelSlot>;
  /**
   * Make sure the channel with `recipient` is Opened and the maker's deposit
   * in it is at least `minDeposit`. Idempotent; at most three transactions
   * (open, approve, setTotalDeposit).
   */
  ensure(recipient: string, minDeposit: bigint): Promise<EnsuredEvmChannel>;
}

export function createEvmLegBChannelProvisioner(
  cfg: EvmLegBChannelProvisionerConfig
): EvmLegBChannelProvisioner {
  if (!(cfg.makerPrivateKey instanceof Uint8Array) || cfg.makerPrivateKey.length !== 32) {
    throw new Error('EVM leg-B provisioner requires a 32-byte maker private key');
  }
  if (typeof cfg.channelDeposit !== 'bigint' || cfg.channelDeposit <= 0n) {
    throw new Error('EVM leg-B provisioner requires a positive channelDeposit');
  }
  const tokenNetwork = getAddress(cfg.tokenNetworkAddress);
  const token = getAddress(cfg.tokenAddress);
  const account = privateKeyToAccount(
    `0x${Buffer.from(cfg.makerPrivateKey).toString('hex')}` as Hex
  );
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });
  const timeout = cfg.settlementTimeoutSeconds ?? DEFAULT_EVM_SETTLEMENT_TIMEOUT_SECONDS;
  const inflight = new Map<string, Promise<unknown>>();
  let chainIdPromise: Promise<number> | undefined;
  const chainId = (): Promise<number> => (chainIdPromise ??= publicClient.getChainId());

  const readEpoch = async (recipient: Address): Promise<bigint> => {
    const [p1, p2] = sortEvmParticipants(account.address, recipient);
    return publicClient.readContract({
      address: tokenNetwork,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'channelEpoch',
      args: [p1, p2],
    });
  };

  const channelFor = async (recipient: string): Promise<Hex> => {
    const r = getAddress(recipient);
    return deriveEvmChannelId(account.address, r, await readEpoch(r));
  };

  const readSlot = async (channelId: Hex): Promise<EvmChannelSlot> => {
    const [channel, slot] = await Promise.all([
      publicClient.readContract({
        address: tokenNetwork,
        abi: TOKEN_NETWORK_ABI,
        functionName: 'channels',
        args: [channelId],
      }),
      publicClient.readContract({
        address: tokenNetwork,
        abi: TOKEN_NETWORK_ABI,
        functionName: 'participants',
        args: [channelId, account.address],
      }),
    ]);
    return {
      channelId,
      state: Number(channel[1]),
      deposit: slot[0],
      nonce: slot[1],
      transferredAmount: slot[2],
    };
  };

  const send = async (to: Address, data: Hex): Promise<void> => {
    const hash = await walletClient.sendTransaction({ account, chain: null, to, data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`transaction ${hash} reverted`);
    }
  };

  async function ensureLocked(recipient: string, minDeposit: bigint): Promise<EnsuredEvmChannel> {
    const r = getAddress(recipient);
    if (r.toLowerCase() === account.address.toLowerCase()) {
      throw new Error('a channel needs two distinct participants; the recipient is the maker itself');
    }
    const channelId = await channelFor(r);
    let slot = await readSlot(channelId);
    let opened = false;
    if (slot.state === 0) {
      await send(
        tokenNetwork,
        encodeFunctionData({
          abi: TOKEN_NETWORK_ABI,
          functionName: 'openChannel',
          args: [r, timeout],
        })
      );
      opened = true;
      slot = await readSlot(channelId);
    } else if (slot.state !== 1) {
      throw new Error(
        `TokenNetwork channel ${channelId} with ${r} is in state ${slot.state} (not Opened); it settles before it can be reused`
      );
    }
    const shortfall = minDeposit > slot.deposit ? minDeposit - slot.deposit : 0n;
    const topUp =
      slot.deposit === 0n
        ? cfg.channelDeposit > minDeposit
          ? cfg.channelDeposit
          : minDeposit
        : shortfall > 0n
          ? shortfall > cfg.channelDeposit
            ? shortfall
            : cfg.channelDeposit
          : 0n;
    if (topUp > 0n) {
      const total = slot.deposit + topUp;
      const cap = await publicClient.readContract({
        address: tokenNetwork,
        abi: TOKEN_NETWORK_ABI,
        functionName: 'maxChannelDeposit',
      });
      if (total > cap) {
        throw new Error(
          `TokenNetwork caps a participant's deposit at ${cap}; ${total} would be needed to cover ${minDeposit}`
        );
      }
      const allowance = await publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [account.address, tokenNetwork],
      });
      if (allowance < topUp) {
        await send(
          token,
          encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [tokenNetwork, topUp],
          })
        );
      }
      await send(
        tokenNetwork,
        encodeFunctionData({
          abi: TOKEN_NETWORK_ABI,
          functionName: 'setTotalDeposit',
          args: [channelId, account.address, total],
        })
      );
      slot = await readSlot(channelId);
    }
    if (opened || topUp > 0n) {
      cfg.logger?.info?.('swap.legB.evm_channel_provisioned', {
        recipient: r,
        channelId,
        chainId: await chainId(),
        opened,
        toppedUp: topUp.toString(),
        deposit: slot.deposit.toString(),
      });
    }
    return {
      channelId,
      deposit: slot.deposit,
      opened,
      toppedUp: topUp,
      nonce: slot.nonce,
      transferredAmount: slot.transferredAmount,
    };
  }

  return {
    makerAddress: account.address,
    channelFor,
    async read(recipient) {
      return readSlot(await channelFor(recipient));
    },
    ensure(recipient, minDeposit) {
      const key = recipient.toLowerCase();
      const prev = inflight.get(key) ?? Promise.resolve();
      const run = prev.then(
        () => ensureLocked(recipient, minDeposit),
        () => ensureLocked(recipient, minDeposit)
      );
      inflight.set(key, run);
      return run.finally(() => {
        if (inflight.get(key) === run) inflight.delete(key);
      });
    },
  };
}
