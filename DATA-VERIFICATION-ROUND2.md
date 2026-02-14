# Data Verification Round 2 — 2026-02-14

Season: `90D` | Total records queried (limit 50000)

## Field Completeness by Source

| Source | Total | win_rate | max_drawdown | trades_count | arena_score |
|---|---|---|---|---|---|
| okx_web3 | 250 | 74 | 68 | 91 | 250 |
| mexc | 194 | 86 | 86 | 147 | 194 |
| gateio | 81 | 39 | 34 | 33 | 81 |
| bingx_spot | 56 | 54 | 0 | 0 | 56 |
| binance_futures | 53 | 53 | 53 | 53 | 53 |
| bingx | 40 | 38 | 32 | 25 | 40 |
| bybit | 32 | 27 | 1 | 17 | 32 |
| jupiter_perps | 29 | 29 | 29 | 29 | 29 |
| phemex | 29 | 0 | 0 | 0 | 29 |
| coinex | 26 | 18 | 19 | 14 | 26 |
| bitfinex | 20 | 12 | 12 | 0 | 20 |
| kucoin | 20 | 0 | 0 | 18 | 20 |
| binance_spot | 17 | 17 | 17 | 17 | 17 |
| bybit_spot | 17 | 17 | 16 | 7 | 17 |
| bitget_futures | 16 | 6 | 6 | 13 | 16 |
| hyperliquid | 16 | 15 | 16 | 15 | 16 |
| bitget_spot | 15 | 15 | 15 | 11 | 15 |
| binance_web3 | 14 | 10 | 1 | 2 | 14 |
| gains | 11 | 6 | 5 | 6 | 11 |
| dydx | 10 | 7 | 7 | 9 | 10 |
| blofin | 9 | 2 | 9 | 1 | 9 |
| aevo | 8 | 0 | 0 | 0 | 8 |
| htx_futures | 8 | 8 | 8 | 0 | 8 |
| btcc | 8 | 8 | 8 | 0 | 8 |
| lbank | 7 | 6 | 5 | 3 | 7 |
| toobit | 6 | 6 | 0 | 5 | 6 |
| okx_futures | 3 | 3 | 3 | 3 | 3 |
| xt | 2 | 2 | 2 | 0 | 2 |
| gmx | 2 | 2 | 2 | 2 | 2 |
| weex | 1 | 0 | 0 | 0 | 1 |

**Grand total: 1,025 records across 30 sources**

## Key Gaps (0% fill rate)
- **bingx_spot**: no max_drawdown, no trades_count
- **phemex**: no win_rate, no max_drawdown, no trades_count
- **kucoin**: no win_rate, no max_drawdown
- **aevo**: no win_rate, no max_drawdown, no trades_count
- **weex**: no win_rate, no max_drawdown, no trades_count

## arena_score
All 1,025 records have arena_score filled ✅ (will still run null check to confirm)
