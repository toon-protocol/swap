# bench-fills — devnet 2026-08-28T17:51:27.863Z — 10 fills per δ, rate 0.99, EVM→Solana

| δ (µUSDC) | fills | notional | wall ms | fills/s | lat mean | p50 | max | taker pub ms | maker pub ms | writes | carriage µUSDC | carriage % | refusals | status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 | 10 | 20 | 3684 | 2.714 | 368 | 334 | 729 | 81 | 88 | 23 | 23 | 115% | - | done |
| 10 | 10 | 100 | 4060 | 2.463 | 406 | 334 | 1138 | 69 | 82 | 23 | 23 | 23% | - | done |
| 100 | 10 | 1000 | 4833 | 2.069 | 483 | 393 | 743 | 76 | 169 | 23 | 23 | 2.3% | - | done |
| 1000 | 10 | 10000 | 3560 | 2.809 | 356 | 350 | 436 | 81 | 84 | 23 | 23 | 0.23% | - | done |
| 10000 | 10 | 100000 | 8211 | 1.218 | 821 | 984 | 2559 | 62 | 71 | 23 | 23 | 0.023% | - | done |
| 100000 | 0 | 1000000 | 5862 | 0 | 0 | 0 | 0 | 91 | 145 | 4 | 4 | 0% | - | aborted (SwapTakerError: advance_invalid: the maker's leg-B claim failed verification: ch) |
