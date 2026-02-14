# Data Verification Round 1 - 90D Season
**Date:** 2026-02-14 09:40 PST (Updated after Phemex + dYdX enrichment)

## Platform Coverage (90D season_id) — 1,000 traders total

| Platform | Total | WinRate | MaxDD | Trades | Score |
|---|---|---|---|---|---|
| okx_web3 | 246 | 73 (30%) | 67 (27%) | 90 (37%) | 246 (100%) |
| mexc | 210 | 102 (49%) | 102 (49%) | 163 (78%) | 118 (56%) |
| gateio | 81 | 38 (47%) | 33 (41%) | 32 (40%) | 81 (100%) |
| bingx_spot | 54 | 52 (96%) | 0 (0%) | 0 (0%) | 54 (100%) |
| binance_futures | 53 | 53 (100%) | 53 (100%) | 53 (100%) | 53 (100%) |
| bingx | 39 | 37 (95%) | 31 (79%) | 25 (64%) | 39 (100%) |
| bybit | 31 | 26 (84%) | 1 (3%) | 16 (52%) | 31 (100%) |
| jupiter_perps | 29 | 29 (100%) | 29 (100%) | 29 (100%) | 29 (100%) |
| **phemex** | **29** | **27 (93%)** | **27 (93%)** | 0 (0%) | 29 (100%) |
| bitfinex | 23 | 13 (57%) | 13 (57%) | 0 (0%) | 11 (48%) |
| kucoin | 20 | 0 (0%) | 0 (0%) | 18 (90%) | 20 (100%) |
| binance_spot | 17 | 17 (100%) | 17 (100%) | 17 (100%) | 17 (100%) |
| coinex | 17 | 11 (65%) | 10 (59%) | 7 (41%) | 17 (100%) |
| bitget_futures | 16 | 6 (38%) | 6 (38%) | 13 (81%) | 16 (100%) |
| hyperliquid | 16 | 15 (94%) | 16 (100%) | 15 (94%) | 16 (100%) |
| bybit_spot | 16 | 16 (100%) | 14 (88%) | 7 (44%) | 16 (100%) |
| bitget_spot | 15 | 15 (100%) | 15 (100%) | 11 (73%) | 15 (100%) |
| binance_web3 | 13 | 9 (69%) | 1 (8%) | 2 (15%) | 13 (100%) |
| gains | 13 | 6 (46%) | 5 (38%) | 6 (46%) | 6 (46%) |
| htx_futures | 10 | 10 (100%) | 10 (100%) | 0 (0%) | 10 (100%) |
| blofin | 9 | 2 (22%) | 9 (100%) | 1 (11%) | 9 (100%) |
| aevo | 8 | 0 (0%) | 0 (0%) | 0 (0%) | 8 (100%) |
| btcc | 8 | 8 (100%) | 8 (100%) | 0 (0%) | 8 (100%) |
| dydx | 7 | 5 (71%) | 5 (71%) | 4 (57%) | 7 (100%) |
| lbank | 7 | 6 (86%) | 5 (71%) | 3 (43%) | 7 (100%) |
| toobit | 6 | 6 (100%) | 0 (0%) | 5 (83%) | 6 (100%) |
| okx_futures | 3 | 3 (100%) | 3 (100%) | 3 (100%) | 3 (100%) |
| gmx | 2 | 2 (100%) | 2 (100%) | 2 (100%) | 2 (100%) |
| xt | 1 | 1 (100%) | 1 (100%) | 0 (0%) | 1 (100%) |
| weex | 1 | 0 (0%) | 0 (0%) | 0 (0%) | 1 (100%) |

## Enrichment Results This Round
- ✅ **Phemex**: WR 0→27/29 (93%), MDD 0→27/29 (93%) — ran on Mac Mini with Playwright
- ✅ **dYdX**: WR 2→5/7, MDD 2→5/7 — fills enrichment (still running)
- ⏳ **Leaderboard ranks**: KuCoin 98 updated before timeout
- ❌ **BingX**: Failed to capture browser headers on VPS
- ❌ **Weex**: Browser crashed on VPS (only 1 trader in 90D anyway)

## Remaining Gaps
1. **kucoin** — 20 traders, 0% WR/MDD → needs browser-based enrichment
2. **aevo** — 8 traders, 0% WR/MDD/TC → needs API investigation
3. **bingx_spot** — 54 traders, 0% MDD/TC
4. **bybit** — 31 traders, 3% MDD
5. **weex** — 1 trader, 0% everything
6. **okx_web3** — 246 traders but only 30% WR
7. **mexc** — 210 traders but only 49% WR, 56% Score
