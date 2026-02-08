# Cron Optimization Plan

## Current State: 40 crons (Vercel limit: 40)

### All Crons by Frequency

| # | Path | Schedule | Frequency |
|---|------|----------|-----------|
| 1 | `run-jobs?max=20` | `*/2 * * * *` | Every 2 min |
| 2 | `run-worker` | `*/5 * * * *` | Every 5 min |
| 3 | `refresh-hot-scores` | `*/5 * * * *` | Every 5 min |
| 4 | `trader/sync` | `*/5 * * * *` | Every 5 min |
| 5 | `fetch-details?tier=hot` | `*/15 * * * *` | Every 15 min |
| 6 | `calculate-tiers` | `*/15 * * * *` | Every 15 min |
| 7 | `compute-leaderboard` | `0 * * * *` | Hourly |
| 8 | `fetch-followed-traders` | `0 * * * *` | Hourly |
| 9 | `fetch-market-data?type=prices` | `0 */1 * * *` | Hourly |
| 10 | `fetch-open-interest` | `0 * * * *` | Hourly |
| 11 | `fetch-details?tier=active` | `15 * * * *` | Hourly |
| 12 | `check-data-freshness` | `0 */3 * * *` | Every 3h |
| 13-17 | `fetch-traders/{binance_futures,binance_spot,bybit,bitget_futures,okx_futures}` | `55-59 */3 * * *` | Every 3h |
| 18-21 | `fetch-details?tier=normal`, `calculate-advanced-metrics`, `discover-traders`, `discover-rankings` | `*/4 h` | Every 4h |
| 22-28 | `fetch-traders/{mexc,kucoin,okx_web3,hyperliquid,gmx,jupiter_perps,aevo}` | Various `*/4 * * *` | Every 4h |
| 29 | `fetch-funding-rates` | `0 */4 * * *` | Every 4h |
| 30-31 | `enrich?platform=binance_futures`, `enrich?platform=bybit` | `*/4 h` | Every 4h |
| 32 | `scrape/proxy?period=all` | `0 2,6,10,14,18,22 * * *` | Every 4h |
| 33-36 | `fetch-traders/{coinex,bitget_spot,xt,vertex}` | Various `*/6 * * *` | Every 6h |
| 37 | `subscription-expiry` | `0 0 * * *` | Daily |
| 38 | `aggregate-daily-snapshots` | `5 0 * * *` | Daily |
| 39 | `fetch-details?tier=dormant` | `30 3 * * *` | Daily |
| 40 | `cleanup-deleted-accounts` | `0 3 * * *` | Daily |

### Recommended Merges (save ~10 cron slots)

#### 1. Merge 3x "every 5 min" → 1 batch cron
**Merge:** `run-worker` + `refresh-hot-scores` + `trader/sync`  
**Into:** `/api/cron/batch-5min` that calls all three internally  
**Saves:** 2 slots

#### 2. Merge 3x hourly → 1 batch cron  
**Merge:** `compute-leaderboard` + `fetch-followed-traders` + `fetch-open-interest`  
**Into:** `/api/cron/batch-hourly`  
**Saves:** 2 slots

#### 3. Merge 5x "every 3h" fetch-traders → 1 dispatcher
**Merge:** `fetch-traders/{binance_futures,binance_spot,bybit,bitget_futures,okx_futures}`  
**Into:** `/api/cron/fetch-traders-batch-3h` that dispatches to each platform sequentially  
**Saves:** 4 slots

#### 4. Merge 4x "every 6h" fetch-traders → 1 dispatcher
**Merge:** `fetch-traders/{coinex,bitget_spot,xt,vertex}`  
**Into:** `/api/cron/fetch-traders-batch-6h`  
**Saves:** 3 slots

#### 5. Merge daily tasks → 1 batch
**Merge:** `subscription-expiry` + `cleanup-deleted-accounts` + `aggregate-daily-snapshots`  
**Into:** `/api/cron/batch-daily`  
**Saves:** 2 slots

**Total savings: ~13 slots → down to ~27 crons**

### Candidates to Move to VPS

These are long-running or compute-heavy tasks better suited to a VPS:

1. **`run-jobs?max=20`** (every 2 min) — Job processor, runs frequently, would benefit from persistent process
2. **`run-worker`** (every 5 min) — Worker process, natural fit for a long-running VPS daemon
3. **All `fetch-traders/*`** (13 crons) — Scraping tasks that may hit timeouts on serverless
4. **`scrape/proxy?period=all`** — Heavy scraping task
5. **`enrich?platform=*`** — Data enrichment, potentially long-running
6. **`fetch-details?tier=*`** (4 crons) — Bulk detail fetching

Moving workers + scrapers to VPS would free up ~20 cron slots.
