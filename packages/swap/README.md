# @toon-protocol/swap

The TOON **swap maker**: quotes a pair, takes paid fills on one chain, and answers each fill
with a cumulative payment-channel claim on the other (EVM / Solana / Mina leg B).

It is a relay-mediated swap client — see [`docs/relay-swap.md`](../../docs/relay-swap.md) for the
shape, the `rolling/3` wire it speaks (`src/wire.ts`), and how a maker and a taker find each
other through a relay.

```sh
pnpm --filter @toon-protocol/swap test        # unit
pnpm --filter @toon-protocol/swap test:e2e    # both chains, through a real relay and its connector
```

The end-to-end suite (`tests/e2e/`) boots anvil, `solana-test-validator`, the `connector`
binary or image, and `startSwapNode()` in-process, then swaps EVM→Solana and Solana→EVM and
redeems every leg-B claim on chain. `tests/e2e/helpers` is the reference taker — what a client
does to pay the maker's connector and verify what comes back.

Operator documentation: [`deploy/swap/README.md`](../../deploy/swap/README.md).
