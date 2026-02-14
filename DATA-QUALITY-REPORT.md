# Arena Data Quality Audit Report

**Date:** 2026-02-14 08:43 PST  
**Total traders in `trader_snapshots`:** 49,552 (note: API limit 50k, actual count may be higher)  
**Platforms:** 29

---

## 1. Data Completeness by Platform

| Platform | Total | Has ROI | Missing win_rate | Missing max_drawdown | Missing trades_count | Null arena_score |
|---|---|---|---|---|---|---|
| mexc | 176 | 176 | **165 (94%)** | **165 (94%)** | 162 | 5 |
| okx_web3 | 201 | 201 | **166 (83%)** | **166 (83%)** | 139 | 0 |
| phemex | 86 | 86 | **86 (100%)** | **86 (100%)** | **86 (100%)** | 0 |
| gateio | 78 | 78 | 34 (44%) | 39 (50%) | **76 (97%)** | 0 |
| blofin | 38 | 38 | **37 (97%)** | 0 | **37 (97%)** | 0 |
| bitget_futures | 28 | 28 | **21 (75%)** | 19 (68%) | 16 | 0 |
| aevo | 24 | 24 | **23 (96%)** | **23 (96%)** | **23 (96%)** | 0 |
| toobit | 21 | 21 | **21 (100%)** | **21 (100%)** | 18 | 0 |
| okx_futures | 19 | 19 | 0 | 5 | **19 (100%)** | 0 |
| htx_futures | 15 | 15 | 0 | 0 | **15 (100%)** | 0 |
| binance_web3 | 13 | 13 | 6 (46%) | **13 (100%)** | 9 | 0 |
| bitfinex | 11 | 4 | 0 | 0 | 4 | **11 (100%)** |
| lbank | 10 | 10 | 5 (50%) | 4 | **10 (100%)** | 0 |
| bybit | 10 | 10 | 0 | **10 (100%)** | 7 | 0 |
| dydx | 7 | 7 | **7 (100%)** | **7 (100%)** | 6 | 0 |
| weex | 3 | 3 | **3 (100%)** | **3 (100%)** | 3 | 0 |
| bingx | 2 | 2 | **2 (100%)** | **2 (100%)** | 2 | 0 |
| bitget_spot | 3 | 3 | **3 (100%)** | **3 (100%)** | 3 | 0 |
| coinex | 2 | 2 | 1 | 1 | 2 | 0 |
| binance_spot | 61 | 61 | 0 | 0 | 9 | 0 |
| binance_futures | 58 | 58 | 0 | 0 | 0 | 0 |
| kucoin | 33 | 33 | 3 | 3 | 2 | 0 |
| bybit_spot | 14 | 14 | 0 | 2 | 6 | 0 |
| gmx | 32 | 32 | 1 | 9 | 6 | 0 |
| btcc | 31 | 31 | 0 | 0 | **31 (100%)** | 0 |
| hyperliquid | 6 | 6 | 0 | 0 | 0 | 0 |
| jupiter_perps | 11 | 11 | 0 | 0 | 0 | 0 |
| xt | 5 | 5 | 0 | 0 | 5 | 0 |
| gains | 2 | 1 | 0 | 0 | 0 | 1 |

### Summary
- **Traders with ROI but missing win_rate:** 584 (across all platforms)
- **Traders with ROI but missing max_drawdown:** 582
- **Traders with ROI but missing trades_count:** 614
- **Traders with null arena_score:** 17 (bitfinex: 11, mexc: 5, gains: 1)

### Worst Coverage (>50% missing key fields)
| Platform | Issue |
|---|---|
| **phemex** | 100% missing win_rate, max_drawdown, trades_count — no enrichment at all |
| **mexc** | 94% missing win_rate & max_drawdown |
| **okx_web3** | 83% missing win_rate & max_drawdown |
| **toobit** | 100% missing win_rate & max_drawdown |
| **aevo** | 96% missing all three fields |
| **dydx** | 100% missing win_rate & max_drawdown |
| **blofin** | 97% missing win_rate & trades_count |
| **weex** | 100% missing all three fields (only 3 traders) |
| **bingx** | 100% missing all three fields (only 2 traders) |
| **bitget_futures** | 75% missing win_rate |
| **bitget_spot** | 100% missing all three fields (only 3 traders) |

---

## 2. Data Freshness

All 29 platforms are **fresh** (updated within the last 2 hours as of 16:43 UTC):

| Platform | Last Update | Staleness |
|---|---|---|
| bitget_spot | 16:40 UTC | 0.0h |
| jupiter_perps | 16:38 UTC | 0.1h |
| bitget_futures | 16:36 UTC | 0.1h |
| bybit_spot | 16:33 UTC | 0.2h |
| bybit | 16:28 UTC | 0.2h |
| binance_web3 | 16:23 UTC | 0.3h |
| toobit / gmx / hyperliquid / aevo | ~16:19 UTC | 0.4h |
| All others | 15:44–16:18 UTC | 0.4–1.6h |

**Stalest:** blofin at 1.6h, okx_futures at 1.0h — still within acceptable range.

✅ **No platform is stale (>24h).**

---

## 3. VPS Cron Health (root@45.76.152.169)

### Cron Schedule (14 active jobs)
| Job | Schedule | Status |
|---|---|---|
| cron_refresh.sh (major scrape) | Every 30 min | ✅ Running (last: 16:43 UTC) |
| compute-leaderboard-local.mjs | :15, :45 | ✅ Running (last: 16:17 UTC) |
| sync-sharpe-to-leaderboard.mjs | :20, :50 | ✅ Running (last: 16:21 UTC) |
| flash-news/collect.mjs | Every 30 min | ✅ Running (last: 16:30 UTC) |
| fetch-market-data.mjs | Hourly | ✅ Running (last: 16:00 UTC) |
| fetch-missing-avatars.mjs | 6AM/6PM UTC | ✅ Running (last: 06:00 UTC) |
| vps-health-check.mjs | Every 2h :30 | ✅ Running (last: 16:30 UTC) |
| enrich_bybit_detail.mjs | Every 3h :10 | ✅ Running (last: 15:20 UTC) |
| enrich_bitget_futures_detail.mjs | Every 3h :20 | ✅ Running (last: 15:20 UTC) |
| enrich_okx_detail.mjs | Every 6h :30 | ✅ Running (last: 12:40 UTC) |
| enrich_htx_detail.mjs | Every 6h :40 | ✅ Running (last: 12:49 UTC) |
| enrich_kucoin_detail.mjs | Every 6h :50 | ✅ No traders from API (empty result) |
| Log cleanup | Weekly Sun 4AM | ✅ Scheduled |
| **scrape-and-upsert.mjs** | Every 2h :45 | ❌ **BROKEN** |

### 🔴 Critical Issue: `scrape-and-upsert.mjs` is completely broken

**Error:** `Error: supabaseUrl is required.` — repeated 22 times in the log.

**Root cause:** The cron uses `export $(grep -v ^# .env | xargs)` but `scrape-and-upsert.mjs` runs from `/opt/arena` where the `.env` file exists and contains `SUPABASE_URL`. However, the cron entry uses `flock` which changes the execution context:

```
45 */2 * * * cd /opt/arena && export $(grep -v ^# .env | xargs) && flock -xn /tmp/arena_cron.lock timeout 900 node scripts/scrape-and-upsert.mjs
```

The `export` happens but `flock` spawns a new subshell that doesn't inherit the exports. Additionally, before the env issue started, the script was already failing with timeout errors on all 5 platforms (bingx, weex, kucoin, blofin, bitget).

**Impact:** This script handles CF-protected platform scraping. However, the `cron_refresh.sh major` job (running every 30min) appears to cover the same platforms via a different mechanism, so data freshness is NOT affected.

### Other Errors Noted
- `enrich_kucoin_detail.mjs`: Returns 0 traders from KuCoin API (API may be empty/broken)
- `enrich_okx_detail.mjs`: Minor `ON CONFLICT DO UPDATE` duplicate row warnings (non-fatal)
- `manual_refresh.log`: Weex headful browser fails (missing X server) — old issue from Feb 8

---

## 4. Enrichment Coverage

### Detail enrichment crons running:
- **Bybit**: Running every 3h, processing 300 traders per run
- **Bitget Futures**: Running every 3h, 0 traders left to process (100% done)
- **OKX**: Running every 6h, processing 200 traders
- **HTX**: Running every 6h, processing 425 traders
- **KuCoin**: Running every 6h, but **returns 0 traders** (API issue)
- **Hyperliquid**: Custom enrichment running daily, making progress

### Platforms with NO enrichment cron:
- **Phemex** — 86 traders, 0% enriched (no win_rate/max_drawdown/trades_count)
- **MEXC** — 176 traders, 6% enriched
- **OKX Web3** — 201 traders, 17% enriched
- **Toobit** — 21 traders, 0% enriched
- **Aevo** — 24 traders, 4% enriched
- **dYdX** — 7 traders, 0% enriched
- **Blofin** — 38 traders, 3% enriched (win_rate only)
- **Gate.io** — 78 traders, 56% win_rate but 3% trades_count
- **BingX** — 2 traders, 0% enriched
- **LBank** — 10 traders, 50% enriched
- **BTCC** — 31 traders, 0% trades_count (win_rate/mdd OK)

---

## 5. Actionable Recommendations

### 🔴 P0 — Fix Immediately

1. **Fix `scrape-and-upsert.mjs` cron env issue**
   - The `flock` command spawns a subshell. Change the cron to:
   ```
   45 */2 * * * cd /opt/arena && source .env && flock -xn /tmp/arena_cron.lock timeout 900 node scripts/scrape-and-upsert.mjs
   ```
   - Or wrap in a shell script that sources `.env` first.
   - Also investigate the underlying timeout errors on all 5 platforms.

### 🟡 P1 — Write Enrichment Scripts for Missing Platforms

2. **Phemex** (86 traders, 100% missing) — Check if Phemex has a detail API for win_rate/drawdown
3. **MEXC** (176 traders, 94% missing) — High volume, needs enrichment
4. **OKX Web3** (201 traders, 83% missing) — Largest gap by trader count
5. **Toobit** (21 traders, 100% missing) — Small but fully missing
6. **Aevo/dYdX** (DeFi) — May need on-chain enrichment approach

### 🟢 P2 — Minor Fixes

7. **Bitfinex arena_score null** (11 traders) — Check scoring logic, may need minimum data threshold
8. **KuCoin enrichment returning 0** — Debug API endpoint, may need auth update
9. **BTCC/OKX Futures trades_count** — These platforms expose PnL but not trade count; consider marking as "N/A" rather than null
10. **Clean up scrape_upsert.log** — 22 repeated error entries, consider log rotation or dedup

---

*Report generated automatically. No data was modified.*
