# @toon-protocol/swap

TOON Mill — multi-chain payment-channel claim issuer for the Token Swap Primitive (Epic 12).

## Integration Tests

See `tests/integration/` — run with:

```bash
pnpm --filter @toon-protocol/swap test:integration           # default in-process suite
pnpm --filter @toon-protocol/swap test:integration:anvil     # opt-in Anvil suite (needs ./scripts/sdk-e2e-infra.sh up)
```

Operator documentation lives in Story 12.9 (not this file).
