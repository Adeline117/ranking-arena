# Arena Progress Tracker

> Auto-read by Claude Code at session start. Keep concise — archive completed items weekly.

## Maintenance Sprint (2026-04-03)

### Completed
1. **Disk cleanup**: Cleared 16.5GB (12G Turbopack .next/dev cache + 4.5G npm cache)
2. **Lint cleanup**: 5 errors → 0 (moved stray script, removed unused imports/types)
3. **ESLint v10**: Tested — incompatible with eslint-plugin-react, reverted to v9.39.4
4. **Blofin removed**: Confirmed dead (geo-blocked ALL IPs), removed from pipeline
5. **Sharpe backfill**: SQL-computed sharpe from equity curves → 1,820 leaderboard_ranks + 91,504 snapshots_v2 updated. Coverage: **60.5% → 64.3%**
6. **LCP optimization**: Restored SSR shell (HomeHeroSSR + SSRRankingTable) — was removed due to reconciliation crashes, now placed outside ssr:false boundary. Expected LCP 13.4s → ~2s
7. **Vertex/Apex/RabbitX**: Confirmed DEAD (DNS dead / API 404 / no leaderboard). No action needed.

### Lighthouse Scores (local headless)
| Metric | Value |
|--------|-------|
| Performance | 75 |
| Accessibility | 97 |
| Best Practices | 96 |
| SEO | 100 |
| FCP | 1.3s |
| LCP | 13.4s → TBD (SSR shell restored, needs re-test after deploy) |
| TBT | 10ms |
| CLS | 0.05 |

### Pipeline Health
- 30/31 platforms fresh (okx_futures 10h ago, yellow)
- 6 enrichment warnings (dead platforms missing rate limiting annotations — cosmetic)
- 0 failures

## Inline Enrichment — Fetch+Enrich in One Pass (2026-04-02)

**Goal**: New traders get complete profile pages immediately (no waiting for batch-enrich cron).

### Changes
1. `enrichment-runner.ts`: Added `traderKeys` + `timeBudgetMs` params to `runEnrichment`
2. `connector-db-adapter.ts`: `AdapterResult.savedTraderKeys` + `runConnectorBatch` runs enrichment for 90D→30D→7D with time budget
3. `batch-fetch-traders/route.ts`: Passes `platformTimeBudgetMs` to `runConnectorBatch`
4. `inlineEnrich` defaults to `true` — all platforms auto-enrich after fetch

### How It Works
- After leaderboard fetch+write, remaining platform time budget goes to enrichment
- Batch-cached platforms (bitunix, xt, coinex, etc.): enrich ALL traders instantly
- API platforms: enrich within time budget, excess deferred to batch-enrich
- batch-enrich cron continues as safety net for stragglers

---

## Sharpe Coverage Overhaul (2026-04-02)

### 5 Commits Pushed
1. `fix(mexc)`: scraper-cron compute Sharpe from curveValues (was hardcoded null)
2. `fix: boost sharpe across 8+ platforms`: binance guard 10→20, bitunix dailyWinRate, DEX shared computeStatsFromPositions sharpe, blofin VPS scraper
3. `fix(enrichment): Hyperliquid + Drift critical bugs`: HL userFills→userFillsByTime, Drift nested accounts parsing + ts field + string→Number
4. `fix(etoro)`: CopySim API for daily equity curve (was monthly-only, 3 pts → 198 pts)
5. `fix(mexc)`: VPS deploy of scraper-cron sharpe fix

### Coverage Results (leaderboard_ranks)
| Platform | Before | After | Δ |
|----------|--------|-------|---|
| gateio | 33% | **75%** | +42% |
| coinex | 57% | **70%** | +13% |
| aevo | 43% | **50%** | +7% |
| htx_futures | 50% | **57%** | +7% |
| toobit | 26% | **33%** | +7% |
| mexc | 62% | **68%** | +6% |
| drift | 28% | **34%** | +6% |
| jupiter_perps | 29% | **34%** | +5% |
| etoro | 22% | **26%** | +4% |
| binance_spot | 92% | **90%** | ✅ |

### Verified in snapshots_v2 (will propagate over enrichment cycles)
- drift: **95%** sharpe in latest batch (nested accounts bug was blocking ALL data)
- mexc: **90%** (curveValues fix)
- gateio: **98%** (enrichment equity curve)
- etoro: CopySim daily API discovered, 198 data points per trader

### Sharpe Coverage Analysis (2026-04-02 session 2)

**Fixes pushed:**
1. `fix(bingx)`: enrichment was hardcoding `sharpeRatio: null` despite connector reading `sharpe30d`/`sharpeRatio`/`sharpe`/`sharpRatio` from API. Now extracts from CF Worker proxy response. (0/208 v2 traders had sharpe)
2. `fix(aggregate-daily-snapshots)`: fallback query had 50K global limit dominated by gmx (156K) + hyperliquid (155K rows in 2 days). Small platforms (bingx: 228, toobit: 1.6K, gains: 2.3K) were entirely crowded out — daily snapshots stopped flowing since March 18. Now queries per-platform with 5K limit each.
3. This unblocks `compute-derived-metrics` (00:20 UTC) from computing Sharpe from daily returns for toobit/bingx/gains/drift/hyperliquid/blofin/etoro.

**Root cause analysis per platform:**
- **BingX** (0% sharpe in v2): enrichment hardcoded null (FIXED). Also: connector reads sharpe from ranking API, but enrichment ignored it.
- **Toobit** (33% sharpe): API `sharpeRatio` field missing for most traders. Both connector + enrichment already try. Need daily snapshot path (FIXED via aggregate fix).
- **Gains** (32% sharpe): on-chain events sparse (<3 unique trading days per trader). Copin API position filter returns `[]` for GNS. Native `personal-trading-history-table` API is 404.
- **eToro** (26% sharpe): CopySim API works but CF rate limits all IPs. Not a code bug.
- **Drift** (34% sharpe in LR, 95% in v2): already fixed. Remaining nulls = traders with <3 snapshots.
- **Hyperliquid** (37% sharpe): whales have <5 closing days in 90d. Not a code bug.
- **BloFin** (11% sharpe): CF WAF blocks API + VPS scraper. Not a code bug.

**Key insight:** The aggregate-daily-snapshots bottleneck was the #1 blocker. Once daily snapshots resume for all platforms, the compute-derived-metrics and compute-leaderboard crons will auto-compute Sharpe from daily returns (needs 7+ days of history).

### Still Low (API limitations, not code bugs)
- hyperliquid 37%: userFillsByTime helps mid-tier; whales have <5 closing days in 90d
- blofin 11%: Cloudflare WAF blocks even Playwright stealth
- bingx 23%: no daily curve in API, sharpe extraction from API now enabled
- gains 32%: onchain events sparse, Copin position API empty for GNS

### Key Bugs Found & Fixed
1. **Drift**: API returns `{accounts:[{snapshots:[...]}]}` but code did `Array.isArray(response)` = FALSE → snaps=[] for ALL traders
2. **Drift**: API field is `ts` not `epochTs`, values are strings not numbers
3. **Hyperliquid**: `userFills` returns latest 2000 (covers <5 days for active traders), switched to `userFillsByTime` with startTime
4. **MEXC scraper-cron**: `sharpe_ratio: null` hardcoded despite curveValues available
5. **eToro**: gain history only returns monthly data (3 pts); CopySim API returns daily (198 pts)
6. **Binance**: sharpRatio guard `<=10` was too tight, widened to `<=20`
7. **DEX shared**: `computeStatsFromPositions` had no sharpe computation

### Scripts Created
- `scripts/vps-fetch-geoblocked.mjs`: One-shot VPS fetch for binance/htx/gateio
- `/tmp/push-sharpe-raw.mjs`: Push sharpe from snapshots_v2 → leaderboard_ranks
- `/tmp/compute-sharpe-daily.mjs`: Compute sharpe from trader_daily_snapshots history


---

## Session Handoff Notes
- Last updated: 2026-04-02
- Pipeline: 31/32 platforms fresh (okx_futures occasionally 10h stale)
- Sharpe coverage: 47%→59% overall, see "Still Low" section above
- Inline enrichment architecture shipped — needs monitoring
- VPS: SG + JP both healthy, PM2 arena-scraper + arena-proxy + arena-cron
- Dead: kucoin, weex, lbank, bitmart, synthetix, mux, whitbit, btse

## Key Metrics
- Total Traders: 34,000+
- Active Platforms: 32
- Enrichment: 40 platform configs
- Cron Jobs: 53 active
- API Routes: 292
- SQL Migrations: 184
- Tests: 139 suites, 2,271 tests
- Languages: 4 (en/zh/ja/ko, 4,800+ keys each)

---

## Archive (March 2026 and earlier)

<details>
<summary>Click to expand completed work</summary>

### Leaderboard 3-Day Stale Fix (2026-03-28)
Cache tier mismatch bug + dead platforms inflating expected count. Fixed in 1f30c853.

### Optimization Sprint (2026-03-31)
5 phases: pipeline reliability (crons consolidated 18→6), frontend resilience (3 components split), performance (SWR softExpiresAt), social (achievements, competitions), Pro monetization (CSV export, signals, referrals).

### Lighthouse Performance (2026-03-22)
LCP/CLS/TBT optimization, 29-file UI audit, data quality bounds added.

### Enrichment Timeout (2026-03-22)
raceWithTimeout() hard deadline. Re-enabled 4 platforms. KuCoin confirmed dead.

### DB Performance Crisis (2026-03-22)
914K dead rows in leaderboard_ranks. REINDEX CONCURRENTLY 565MB→22MB. API 24.8s→1.0s.

### Data Quality Bugs (2026-03-22)
4 connector bugs: HL ROI 33M%, GMX MDD=100%, Jupiter ±800K%, Binance Sharpe -219.

### Wave 2 Platforms (2026-03-21)
WooX, Polymarket, Copin.io added. 8/8 data gaps closed.

### Pipeline Overhaul (2026-03-21)
Arena Score dedup, aggregate cron split, 20 duplicate fetchers removed, health check 3→33 platforms.

### Frontend Audit (2026-03-18)
AdvancedMetrics/Movers/rank gaps fixed. All 25 platforms × 3 periods verified.

### Data Completeness (2026-03-18)
6 new enrichment modules, 17+ exchange APIs. win_rate 94.5%, max_drawdown 95.1%, sharpe 83.8%.

### Team Audit (2026-03-15)
10 security + 7 performance + 7 pipeline fixes.

### DeSoc Platform (2026-03-08)
Trader claims, bot/human classification, reputation social, EAS attestation, copy trade links.

### Mobile (2026-03-10)
BottomSheet, SwipeableView, MobileFilterSheet, ChartFullscreen, infinite scroll.

### Earlier (2026-03-06–10)
SEO, data coverage expansion, pipeline fixes, connector framework, unified data layer, portfolio dashboard, WebSocket rankings, i18n ja/ko.

</details>
