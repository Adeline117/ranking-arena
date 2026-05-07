# Arena Progress Tracker

> Auto-read by Claude Code at session start. Keep concise — archive completed items weekly.

## 6-Domain Root-Root Cause Audit (2026-05-07)

**Trigger**: User requested 全部根源的根源修复 — deep systemic fix across all layers.

**Process**:

1. Phase 1: 6 parallel Explore agents audited: data pipeline, frontend, API security, performance, type safety, DB schema
2. Phase 2: Identified 5 systemic root causes (silent failures, concurrency safety, hardcoded config, lifecycle cleanup, boundary validation)
3. Phase 3: Fixed all root causes + remaining known issues from backlog
4. Phase 4: Verified false positives (cron monitoring was 55% → actually 98%, chart height already responsive, batch-enrich already has 4 timeout layers)

**Shipped (13 commits, 2 prod migrations)**:

### Silent Failures + Concurrency (5 fixes)

- `57de764` smoke-test: PipelineLogger (failures now visible in monitoring)
- `57de764` enrichment-runner: log empty fallback results (gains/kwenta silent data loss)
- `57de764` enrichment-db: return error when v2 sync fully rejected by sanitizeRow
- `57de764` compute-leaderboard: fail-safe when Redis unavailable (was: proceed without lock → double-compute)
- `57de764` NetworkStatusBanner: ref-based timer cleanup (was: unbounded setTimeout accumulation)

### Design Token Consolidation (3 commits)

- `6303db0` VerifiedBadge + RankPercentileBadge: 11 hardcoded hex → tokens.colors.medal/verified.badge
- `e9fd23d` DailyReturnsChart: 6 hardcoded hex → tokens.colors.sentiment.bear/bull + color-mix()
- `9a1303e` MessageButton + UserFollowButton + ContactSupportButton: extracted shared button-styles.tsx

### Performance (1 migration)

- `76bc0c2` 2 missing DB indexes applied to prod:
  - `idx_posts_author_id_created_at` (author feed composite)
  - `idx_user_profiles_handle_btree` (exact handle lookup)

### Pipeline Reliability (1 commit)

- `daf9160` batch-enrich: pass timeBudgetMs to runEnrichment (graceful bail vs killed mid-write)
- `daf9160` enrichment-runner: dead-letter tracking for failed trader IDs in PipelineState

### UX + i18n (3 commits)

- `26692fb` Compare checkbox: `@media (hover: none)` shows at 50% opacity on touch devices
- `c91bec1` SSR Hero: getServerTranslation() for 6 strings (zh/en/ja/ko) — no more all-English first paint
- `b89cb85` SwipeableView: Overview tab always mounted, Posts uses visitedTabs — no skeleton flash on swipe-back

### DB Cleanup (1 migration)

- `fd093bd` Dropped 6 verified-unused RPC functions: compute_leaderboard_snapshot, migrate_position_history_batch, recalculate_all_user_weights, expire_trader_flags, fix_snapshot_violations, get_latest_timestamps_by_source

### React Query Migration (1 commit)

- `55ae3e4` useServerSearch: manual fetch+AbortController+debounce → useQuery
- `55ae3e4` useSavedFilters: manual fetch callbacks → useMutation with optimistic delete

### False Positives Corrected

- "25 crons missing monitoring" → actually 24/25 use withCron() which wraps PipelineLogger (55% → 98%)
- "Chart height fixed 400px" → SVG viewBox is responsive (width: 100%, height: auto)
- "Batch-enrich no enforcement" → already 4 layers (route→batch→period→hard deadline)
- "Parallel snapshot race" → ON CONFLICT DO UPDATE + truncateToHour converges safely
- "/api/v3 CORS wildcard" → intentional (public API, no credentials)
- "user_profiles.referred_by FK" → column doesn't exist in prod

### Remaining (backlog, not blocking)

- 37 files doing direct fetch() without React Query (gradual migration, useTraderData/PostFeed need dedicated sessions)
- TypeScript quality verified excellent: 0 `any`, 0 `console.log`, 0 TODO across 1,697 files

---

## Enterprise Agent Team Review + Root-Root Cause Fix (2026-05-05)

**Trigger**: User invoked `功能企业级agent team 测试` — full conductor.json review cycle.

**Process**:

1. Phase 1: 5 parallel review agents (CEO, Eng, Security, QA, Design)
2. Phase 2: Fixed all P0+P1 findings (7 bugs + 1 test)
3. Phase 3: Root cause fixes (ILIKE consolidation, postcss override)
4. Phase 4: Root-root cause fixes (shared Stripe wrapper, pre-push guards, coverage ratchet)
5. Migration `20260505131451_lifetime_spots_advisory_lock` applied to prod via MCP

**Review Grades**: CEO B- | Eng B+ | Security B+ | QA 82/100 | Design B

**Shipped (12 commits, 1 prod migration)**:

### Security P0 (2)

- `b9045fd` Lifetime checkout TOCTOU: `check_lifetime_spots_available()` RPC with `pg_advisory_xact_lock`. Comment claimed lock existed but code had none — two concurrent requests could oversell 200-spot limit.
- `dcb8a41` Tip checkout: added Stripe idempotency key (user+post+amount+minute). Was completely missing.

### Security P1 (3)

- `ed4035e` Account recovery: try-finally guarantees re-ban even on unexpected errors. Previously unbanned account stayed accessible if an error occurred between unban and re-ban.
- `7cdf1e4` Group subscription: Stripe amount verification (±5% tolerance) + mandatory metadata checks. Previously metadata checks were optional (`if(x)` guard allowed bypass when absent).
- `7879db0` postcss override to 8.5.14: npm audit now **0 vulnerabilities** (was 5 moderate + 2 high).

### QA P1 (2)

- `84aa8c6` Chat search ILIKE: escaped `%` `_` `\` to prevent wildcard injection. Quiz: removed direct `document.body.style.overflow` manipulation.
- `3159b51` npm audit fix: resolved fast-xml-parser XML injection.

### Root Cause Fixes (2)

- `e18c3b5` Consolidated 3 routes (chat search, unified search, users search) to shared `escapeLikePattern()` from `lib/sanitize.ts`. Users search was also missing backslash escaping.
- `7879db0` postcss forced to 8.5.14 via `overrides` in package.json — Next.js pinned vulnerable 8.4.31.

### Root-Root Cause Fixes (1 commit, 3 changes)

- `4f0761e` **A)** `createOneTimePaymentSession()` in `lib/stripe/` — shared wrapper with mandatory idempotency + metadata for all one-time payments. Tip checkout migrated to use it.
- `4f0761e` **B)** 2 pre-push pattern guards: `.ilike()` without `escapeLikePattern` → blocked; `sessions.create` without `idempotencyKey` → blocked.
- `4f0761e` **C)** Jest coverage ratchet: thresholds lowered from aspirational 30-40% (never enforced) to just-above-current 10-14% (enforced). Added `test:ci` script.

### Test Fix (1)

- `e4615fd` Added `rpc` mock to checkout route test for new advisory lock RPC.

### Key Insight

The 5-agent review found 2 P0 + 5 P1 bugs. All were fixable in hours. But the root-root cause was: **conventions existed (CLAUDE.md) but nothing enforced them automatically**. Pre-push guards now catch the exact patterns that caused these bugs. Coverage ratchet prevents regression.

### Verification

- TypeScript: 0 errors ✅
- Tests: 155 suites, 2645 tests, all pass ✅
- npm audit: 0 vulnerabilities ✅
- Pre-push guards: both patterns verified ✅

---

## Retro 2026-04-09 (first on file)

1009 commits / 7 days, 49.5% fixes, type-check clean, 2212/2235 tests pass,
27/27 platforms fresh. compute-leaderboard split 1775→940 lines this session.
Top hotspot: route.ts (54 changes/wk, expected to drop next week post-split).
Action items in `docs/retros/retro-2026-04-09.md`.

## Agent-Team Deep Optimization Session (2026-04-09)

**Trigger**: User invoked `/agent team 深度优化` requesting parallel review across 5 dimensions (perf, data, security, product, infra).

**Process**:

1. Launched 5 parallel review agents in one message (perf-reviewer, data-auditor, security-reviewer, 2× Explore agents)
2. Compiled prioritized findings into 13 P0 + 9 P1 tasks
3. Worked through tasks one at a time with `git-push-safe.sh` flock-serialized commits
4. Manual prod application of 2 SQL migrations + 1 Vercel env var

**Shipped (17 commits, 2 prod migrations, 1 Vercel env var)**:

### Security (9)

- `bf168e94d` user_profiles RLS: REVOKE SELECT FROM anon + GRANT only safe columns. Closes PII dump (email, wallet, totp, stripe ids). Migration `20260409170117` applied to prod.
- `44bc401ff` cron `[platform]` route: removed dev-mode auth bypass + crypto.timingSafeEqual (Edge runtime fix in `a3f5814ec`)
- `706626971` invite tokens: full 256-bit HMAC + HKDF derivation from service-role key + timing-safe compare + auth-required verify (4 issues, 1 commit)
- `7888b7339` MDD CHECK constraint re-added with positive convention `[0, 100]` + fixed stale code in `anomaly-rules.ts` and `score-explain.ts`. Migration `20260409180432` applied to prod.
- `ac1264357` link-preview SSRF: comprehensive IPv6 + redirect re-validation + DNS rebinding defense + 256KB body cap
- `6c87e1561` SIWE link route: domain/uri/chainId validation (mirrors verify route) — blocks cross-site signature replay
- `92f8bcd87` upload routes: magic-byte sniffing for posts/upload-image + /api/upload, server-derived extension, sniffed Content-Type override
- `0c8d707ab` shared `isAuthorized()` in lib/cron/utils.ts: hand-rolled constant-time XOR compare for 49 cron routes
- INVITE_SECRET set in Vercel (production + preview + development) via `vercel env add`

### Performance (5)

- `9fd90d017` batch-enrich: replaced 81 `count:exact` calls/cycle with `leaderboard_count_cache` lookup. Saves 30-60s per cron invocation.
- `578a909a0` (bundled by parallel session): removed duplicate prevRanks query in compute-leaderboard. Saves 200-600ms/cycle.
- `33176e560` dydx connector: per-instance Copin leaderboard cache. 1000 round trips → 1 per cron run, fixes 100% safety-timeout pattern.
- `64f6ac1a8` HomePage Phase 2: stagger sidebar widget mounts via new `<DeferredMount delayMs>` (0/800/1600/2400 ms). Spreads the 4-way fetch burst.
- (verified) `select('*')` in fetchPaginatedFromDB was already replaced with explicit SSR_COLS in a prior commit — audit was stale.

### Data Pipeline (4)

- `672b43cee` aggregate-daily-snapshots: split-and-retry isolation for non-transient errors + bad-row payload logging. Manual trigger after fix: **998 inserted, 0 errors, 5.3s** (was 0/day for 2026-04-09).
- `61d2654ec` batch-fetch-traders-b1: split bybit fetch into 30d / 7d+90d crons (mirrors a1 pattern) — 240s timeout no longer exhausted.
- (above) dydx 100% failure also fixed by Copin cache.
- (above) MDD constraint re-added.

### Product UX (2)

- `8a196bfb6` PremiumGate: new `featureKey` prop maps to contextual title + 3 benefit bullets per gate. 8 keys defined (advancedAlerts, comparison, csvExport, etc.). en + zh translations added.
- `06a1e61b7` RankingControls: 3s timeout (was 8s) + visible spinner during transition + Retry button on slow nav.

### Verified-not-vulnerable (audit overstated)

- `exec_sql` RPC: ACL is `postgres=X/postgres, service_role=X/postgres` only — not callable from anon/authenticated.
- CF worker `_requestOrigin` race: only allows already-validated allowed origins as values, worst case is browser CORS mismatch (defensive failure), not exploitable. Downgraded P0→P2.
- `fetchPaginatedFromDB` `select('*')`: already fixed in earlier commit.

### Still in progress / partial

- **compute-leaderboard 7D timeout**: code is fine — manual trigger completes in 92.6s with 3,387 records. Failures are cron-storm contention on the 60-connection Supabase pool. Real fix is cron consolidation.
- **Hyperliquid/dYdX win_rate, max_drawdown, sharpe_ratio still NULL on most rows**: long-tail data fetcher work. ~30% of all traders affected. Deferred.
- **trader_daily_snapshots historical volume drop** (18.8k → ~1k/day on 2026-04-06): separate upstream issue. Aggregator runs clean now but the source data is sparse.

### Lessons learned

- Audit had ~30% false-positive rate. Always verify findings against current code before acting.
- 7 parallel `claude` sessions + OpenClaw daemon → frequent ref-lock rejections. `scripts/git-push-safe.sh` flock wrapper is mandatory but not sufficient (still saw a few state resets).
- Supabase pooler shut down briefly under cron storm pressure — the exact failure mode P0-INFRA-1 (856 daily cron invocations vs 60 max_connections) predicts.

## Docs cleanup sweep (2026-04-09)

- Removed 25 historical one-off fix reports from root (-3,989 lines) + `OPTIMIZATION_PLAN.md` (-234 lines, all P0 items shipped)
- Verified P0-4 Compare toggle (`TraderHeader.tsx:694`), P0-1 bitget_futures cron (group b2), P0-2 lbank in NO_ENRICHMENT_PLATFORMS, P0-3 diagnostic scripts on v2
- P1-8/P1-10 already done: `lib/utils/copy-trade.ts` has all 9 previously-missing exchanges (MEXC, Gate, BingX, Phemex, Blofin, Coinex, BTCC, Bitfinex, XT) and both `CopyTradeButton` + `ExchangeLinksBar` import from it
- P2-2 hreflang: added `alternates.languages` (en/zh-CN/ja/ko/x-default) in `app/layout.tsx` — single-URL model, Google can now associate all 4 locales with canonical URL
- Refreshed CLAUDE.md metrics: 32→62 crons, 27→32 exchanges, 32k→34k+ traders

## Inline Enrichment — Fetch+Enrich in One Pass (2026-04-02)

**Goal**: New traders get complete profile pages immediately (no waiting for batch-enrich cron).

### Changes

1. `enrichment-runner.ts`: Added `traderKeys` + `timeBudgetMs` params to `runEnrichment` — allows batch-fetch to pass freshly-fetched keys directly, skipping leaderboard_ranks DB read
2. `connector-db-adapter.ts`: `AdapterResult` returns `savedTraderKeys`; `runConnectorBatch` collects unique keys across all windows and runs enrichment for 90D→30D→7D with time budget awareness
3. `batch-fetch-traders/route.ts`: Passes `platformTimeBudgetMs` to `runConnectorBatch`
4. `inlineEnrich` now defaults to `true` (was `false`) — all platforms auto-enrich

### How It Works

- After leaderboard fetch+write, remaining platform time budget goes to enrichment
- Batch-cached platforms (bitunix, xt, coinex, etc.): enrich ALL traders instantly (0ms delay)
- API platforms: enrich within time budget, excess deferred to batch-enrich
- batch-enrich cron continues as safety net for stragglers

### Verification

- TypeScript: clean ✅
- Tests: 15/15 adapter tests pass, 2214/2221 total (4 pre-existing failures) ✅
- No FK constraints on enrichment tables — safe to write before leaderboard_ranks exists ✅

---

## Sharpe Coverage Overhaul (2026-04-02)

### 6 Commits Pushed

1. `fix(mexc)`: scraper-cron compute Sharpe from curveValues (was hardcoded null)
2. `fix: boost sharpe across 8+ platforms`: binance guard 10→20, bitunix dailyWinRate, DEX shared computeStatsFromPositions sharpe, blofin VPS scraper
3. `fix(enrichment): Hyperliquid + Drift critical bugs`: HL userFills→userFillsByTime, Drift nested accounts parsing + ts field + string→Number
4. `fix(etoro)`: CopySim API for daily equity curve (was monthly-only, 3 pts → 198 pts)
5. `fix(mexc)`: VPS deploy of scraper-cron sharpe fix
6. `fix: 10x enrichment batch limits`: HL 400→2000, drift 100→2000, etoro 100→1000, gateio 100→1000, jupiter 50→500, gains 30→200

### Final Coverage (after 6 rounds enrichment + blitz)

Overall: **46% → 62%** (+16%)
| Platform | Start | Final | Δ |
|----------|-------|-------|---|
| binance_spot | 78% | **88%** | +10% ✅ |
| jupiter_perps | 28% | **77%** | +49% 🔶 |
| binance_futures | 55% | **77%** | +22% 🔶 |
| gateio | 65% | **72%** | +7% 🔶 |
| polymarket | 70% | **72%** | +2% 🔶 |
| coinex | 56% | **65%** | +9% 🔶 |
| aevo | 42% | **63%** | +21% 🔶 |
| mexc | 53% | **60%** | +7% 🔶 |
| htx_futures | 50% | **59%** | +9% |
| drift | 25% | **58%** | +33% |
| dydx | 33% | **53%** | +20% |
| hyperliquid | 30% | **44%** | +14% |
| toobit | 26% | **37%** | +11% |
| etoro | 22% | **34%** | +12% |

### Saturated — remaining nulls are data-insufficient traders

- Numbers stabilized after round 3 (rounds 4-6 added <1% each)
- Root cause: enrichment processed all reachable traders, but many have <3 days of equity curve / closing fills / daily snapshots
- enrichment batch limits already 10x'd — not a throughput issue anymore
- To go higher: lower sharpe threshold from 3→2 days, use unrealized PnL for HL whales, or accept null for truly inactive traders

### Remaining null (verified 2026-04-03, total 47%→59%)

- **eToro 2911 null**: CopySim works but CF rate limit ~36 req/IP. All 3 IPs burned. Wait 24h then `node /tmp/etoro-browser-blitz.mjs`
- **HL 3198 null**: whale blitz done, 1417 traders <3d closing. Try clearinghouseState accountValue delta
- **Drift 2576 null**: <3 snapshots for new/inactive accounts
- **BloFin 964 null**: SG VPS geo-blocked, Mac CF 403. Need US/EU proxy
- **BingX 189 null**: no daily curve API. Scraper page timeout
- **Gains 413 null**: onchain events <3d per trader
- **Toobit 198 null**: ranking API missing sharpeRatio field

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

Cache tier mismatch bug + dead platforms inflating expected count. Fixed in `1f30c853`.

## Full Optimization + Feature Sprint (2026-03-31)

### Phase 1: Pipeline Reliability ✅

- Enrichment retry restored to 3 (shared AbortSignal bounds total time)
- Silent .catch(() => []) replaced with logged warnings + suppressedErrors counter
- dydx enrichment re-enabled (Copin API + AbortSignal.timeout 8s)
- batch-fetch-traders crons consolidated 18→6 super-groups
- warm-cache frequency reduced 5min→15min
- VPS scraper rate limiting added (30rpm + per-platform sequential)

### Phase 2: Frontend Resilience ✅

- 3 giant components split: CommentsModal 832→201, EquityCurve 766→299, SearchDropdown 698→233
- error.tsx + loading.tsx added to library/learn pages
- Ranking table ARIA labels + keyboard navigation
- System theme detection (dark/light/system 3-way)
- Watchlist UI page built (enriched trader data)
- Empty states unified across core path

### Phase 3: Performance + Cache ✅

- SWR cache: softExpiresAt eliminates duplicate swr: bucket (~50% memory reduction)
- snapshots_v2 monthly partitioning migration prepared (swap needs maintenance window)
- Edge cache headers: platform-stats 5min, movers 1min, prices 30s
- OG social cards: dynamic trader profile images already implemented

### Phase 4: Social + Retention ✅

- Email consolidated to Resend, weekly digest cron wired (Monday 09:00 UTC)
- 6 achievement toasts (first_watchlist, first_comparison, first_post, explorer_5, pro_subscriber, social_butterfly)
- Trader comparison enhanced: equity curve overlay SVG, limit 5→10
- Competitions completed: live standings, podium, share + OG meta

### Phase 5: New Platforms + Pro Monetization ✅

- Pro advanced ranking filters (ROI/WR/MDD/Sharpe ranges, URL-persisted)
- Pro CSV export from rankings page
- Trading signal alerts (position change detection → notifications)
- Referral system (codes, tracking, Pro reward after 3 referrals)
- Vertex/Apex/RabbitX DEX connectors (in progress)

## Current Sprint Focus

- **33+ active platforms** (+ Vertex, Apex, RabbitX pending)
- Enrichment: 33 platforms with enrichment configs (dydx re-enabled)
- Cron jobs: consolidated to ~45 active
- Code quality: type-check ✅, lint 0 errors

## Lighthouse Performance Optimization (2026-03-22)

Lighthouse scores were terrible: LCP 8.3s, CLS 0.235, TBT 260ms, Speed Index 5.9s.

### Fixes Applied (8 commits, 4 directions)

**LCP 优化**:

- BetaBanner 转 SSR 直出（消除 JS 依赖）
- Critical CSS 内联 three-col-layout（消除 render-blocking）
- 重复 CSS 删除：animations.css -2.4KB, responsive.css 去重

**CLS 优化**:

- three-col-layout 加 critical CSS min-height（0.233 偏移修复）
- `font-variant-numeric: tabular-nums` 全局应用
- SSR table desktop grid 列宽固定

**TBT 优化**:

- DOMPurify + Privy 隔离为 async-only chunk（不影响首屏）
- ExchangePartners 去掉 per-item contain（父已有）
- RankingTable startTransition + useMemo slices
- optimizePackageImports 清理 7 个不存在包

**其他**:

- NumberTicker 2G/saveData 跳过
- Layout.tsx deferred Suspense
- Browserslist 已配现代浏览器

### 全站 UI 审计（29 文件修复）

- 17 页重复 MobileBottomNav 删除
- 7 组件 z-index 冲突修复（BetaBanner 9999→700, CookieConsent→300, WelcomeModal→400）
- 5 组件移动端触摸目标 <44px 修复
- 3 组件 fixed/sticky 元素重叠修复（CookieConsent/FeedbackWidget 避开底部导航）
- 1 组件下拉截断修复（375px 适配）

### 数据质量审计（6 文件修复）

- compute-leaderboard 添加边界校验：ROI [-100%, 100000%], WR [0-100%], MDD [0-100%], Sharpe [-20, 20]
- enrichment-db 同步前边界检查
- gains-perp WR > 100% 修复（`Math.min`）
- bitget_spot normalizeWinRate 返回 null 替代越界值
- 新增 `safeWinRate()` 工具函数

### 交易员数据完整度（4 文件修复）

- okx_spot: 补 avatar_url + sharpe_ratio（API 已有但未解析）
- woox: equity curve 提取修复（metricCharts ROI）
- DEX followers: `?? 0` → `?? undefined`（不显示假数据）

### TODO

- Verify Lighthouse scores on production after Vercel deploy

## Enrichment Timeout Fix (2026-03-22) — P0

### Problem

5 enrichment platforms repeatedly hanging 45+ minutes, killing pipeline health (56.3%):

- `binance_futures` (5x hangs), `bybit/kucoin/weex/okx_web3` (3x hangs each)
- Cleanup cron couldn't catch them (query bug fixed in b464456a, but underlying cause remained)

### Root Cause

`AbortSignal.timeout()` doesn't reliably cancel stuck TCP connections in Node.js.
VPS scraper Playwright hangs and CF Worker proxy stuck requests linger in socket pool.

### Fix: `raceWithTimeout()` Hard Deadline

- `Promise.race` with hard rejection timer — guarantees unblock within deadline
- Applied at **per-trader** (15-30s) and **per-platform** (90-180s) levels
- CF Worker proxy: hard 15s deadline (was: no timeout)
- VPS proxy: hard deadline matching `timeoutMs + 2s` grace
- **Re-enabled**: binance_futures, bybit, weex, okx_web3
- **KuCoin**: confirmed dead (copy trading discontinued, all APIs 404) → DEAD_BLOCKED_PLATFORMS

### TODO

- Monitor next cron cycles to confirm no more 45-min hangs
- If stable, consider increasing bybit/weex concurrency from 1

## Critical Fixes (2026-03-22)

### DB Performance Crisis (P0 — Resolved)

- **Root cause**: `leaderboard_ranks` had 914K dead rows (37.8x dead ratio), causing all API/cron timeouts
- **Secondary**: Stuck COPY transaction on `eligible` table (33h idle in transaction)
- **Fix**: REINDEX CONCURRENTLY all 7 indexes (565MB → 22MB, 96% reduction) + VACUUM
- **Prevention**: Aggressive autovacuum (scale_factor=0.01, cost_delay=2ms) + computed_at index
- **Result**: API 24.8s → 1.0s, health 503 → 200

### Data Quality Bugs (P1 — Fixed, 4 connector bugs)

| Bug               | Platform             | Root Cause                                     | Fix                                         |
| ----------------- | -------------------- | ---------------------------------------------- | ------------------------------------------- |
| ROI 33M%          | Hyperliquid          | `roi * 100` but API returns percentage         | Smart detection: `\|roi\| <= 10` → multiply |
| MDD=100% (1175人) | GMX                  | `netCapital` field not in API response         | Removed broken formula, return null         |
| ROI ±800K%        | Jupiter              | `volume/5` estimate → tiny capital → explosion | $1000 minimum capital threshold             |
| Sharpe -219       | Binance Spot/Futures | API sharpRatio no validation                   | Added `\|sharpe\| <= 10` bounds             |

### Trader Count Limits (P1 — Fixed, awaiting cron cycle)

- **Root cause**: Global default limit=500 + per-connector hardcoded caps (100-500)
- **Also**: Cron route handlers overriding with `limit: 500` (found late, fixed separately)
- **Fix**: All 21 connectors raised to limit=2000, route handlers use global default
- Added pagination loops for Bybit and MEXC (were single-page only)
- Early results: drift 1254→1638, binance_web3 2178→2258 (still running)

## Wave 2 New Platforms (2026-03-21)

### Completed

- **WOO X** (`woox`): 8 curated lead traders, full data (ROI/PnL/MDD/Sharpe/WR/equity curve/positions/history)
- **Polymarket** (`polymarket`): 500+ prediction market traders, PnL/Volume rankings, positions/history from data-api
- **Copin.io** (`copin`): On-chain perp DEX aggregator, 6 protocols (Hyperliquid/GMX/GNS/dYdX/Kwenta/Synthetix), 60M+ positions
- All 3 platforms: data confirmed in DB, cron group L (every 6h), enrichment modules ready

### Key Fixes During Integration

- DB upsert batch 500→50 (Supabase statement timeout)
- Window writes parallel→sequential (deadlock 40P01 prevention)
- Polymarket limit capped at 100 (DB write timeout on 500)
- Copin: `/public/` statistic filter returns empty → use `/PROTOCOL/position/filter` (no auth needed, 60M+ real positions)
- WOO X: sorting-strategy-list returns 500 → use leaderboard-metrics endpoint

### Not Viable (researched but no public API)

BitMart (dead), Pionex (bot-focused), KCEX (403), OrangeX (private only), Backpack (no leaderboard), Kolscan (scrape only)

- Frontend: copiers/copiersPnl removed (Arena 无跟单功能). All 35 platforms trader pages accessible.
- VPS scraper v16 deployed, Mac Mini scripts for kucoin + bingx_spot.

## Recently Completed (2026-03-21) — Agent Team Data Pipeline Overhaul

### Architecture Improvements (5 core issues fixed)

1. **Arena Score 公式去重**: metrics-backfill.ts 删除重复 computeArenaScore，统一导入 arena-score.ts
2. **聚合 Cron 拆分**: aggregate-daily-snapshots 从 8-in-1 拆为 3 个独立 cron (aggregate/compute-derived-metrics/cleanup-data)
3. **重复 Fetch 清理**: 删除 20 个与 batch-fetch 重复的 individual fetch-traders cron
4. **健康检查修复**: 创建 get_platform_freshness RPC + 改进回退查询，从 3 平台扩展到 33 平台

### Data Gap 全部关闭 (8/8 fixed)

| Platform         | Gap              | Fix                                                    |
| ---------------- | ---------------- | ------------------------------------------------------ |
| bitget_futures   | ROI 14%          | ✅ 增加 enrich limit 50→200, 重新启用 enrichment       |
| bitfinex         | ROI 24%          | ✅ 新增 fetchBitfinexRoi 从 plu_diff + Copin 计算      |
| okx_web3         | ROI 10%          | ✅ 添加 dataRange 参数使 ROI 按周期计算                |
| gains            | ROI 20%          | ✅ normalize 添加 totalPnl/totalVolume fallback        |
| bybit/bybit_spot | PnL 0-29%        | ✅ VPS scraper detail.result.pnl 提取 + 写回 snapshots |
| kucoin           | WR/MDD/Sharpe 0% | ✅ 修复 baseValue=0 导致 equity curve ROI=0            |
| bingx_spot       | Curve 0          | ✅ 从 trader_daily_snapshots 查询生成 equity curve     |
| okx_spot         | Curve 0          | ✅ enrichment 已配置，cron 已触发                      |

### Commits (11 total)

- `a8f6c05` remove 20 duplicate fetch-traders cron entries
- `7d3a88b` deduplicate Arena Score formula
- `65ac189` bingx_spot equity curve from daily snapshots
- `d8e37fc` okx_web3 dataRange for period-specific ROI
- `4051629` KuCoin baseValue=0 fix for Sharpe/MDD derivation
- `ae015a3` pipeline health check 3→33 platforms
- `be7f385` bitget_futures coverage 50→200 traders/run
- `18a0a4e` split aggregate cron into 3 focused jobs
- `0d009a8` bitfinex ROI from plu_diff + Copin
- `5be8db7` gains ROI fallback from totalPnl/totalVolume
- `0ec5a0c` bybit PnL from VPS scraper detail

## Recently Completed (2026-03-18) — Frontend Data Display Audit + Fixes

### Critical Bugs Fixed

- **AdvancedMetrics never rendering**: bridge.ts missing sortino/calmar/profit_factor + score sub-components → added
- **Movers API 500 error**: referenced non-existent `rank_history` table → rewritten to use leaderboard_ranks + daily_snapshots
- **Leaderboard rank gaps**: ROI anomaly filter 5000% too aggressive (deleting top 4 traders) → raised to 50000%
- **Bitunix 0 enrichment**: triggered enrichment, 200 traders now enriched

### Audit Results (all 25 platforms × 3 periods verified)

- **7D/30D/90D rankings**: ROI, PnL, win_rate, max_drawdown, arena_score all 100% filled
- **Exchange-specific pages**: all 24 exchange endpoints return data, 0 stale
- **Trader detail pages**: Hero/Scores/Radar/EquityCurve all render across all platforms
- **Remaining known gaps**: sharpe_ratio 90%+ null in 7D/30D (needs daily history to accumulate), bitunix equity curves filling via enrichment

## Recently Completed (2026-03-18) — Per-Platform Data Quality Fixes

### P0 Fixes

- **bitunix enrichment**: Rewrote to batch-cache leaderboard API. Added to batch-enrich schedule. Was 0 enrichment data despite 7.8K snapshots.
- **bitget ROI/PnL 87% null**: Root cause = stale Feb 2026 data with old hex keys. Migration to clean up. Current data (Mar) is correct.
- **daily_snapshots only 1 day**: Fixed filter `created_at` → `as_of_ts`. Backfilled 421K rows across 25 dates (35K → 377K total, 142 days history).

### P1 Fixes

- **bybit enrichment re-enabled**: VPS scraper `/bybit/trader-detail` endpoint added. Enrichment now routes through Playwright instead of dead api2.bybit.com.
- **bitfinex ROI**: Cross-reference plu_diff + plu rankings for better ROI coverage.
- **weex → DEAD**: Removed from fetch groups and vercel.json (521 server down, 0 traders).
- **vertex/kwenta cleaned up**: Removed stale references from utility lists.
- **xt enrichment**: New module with batch-cache internal API. Added to ENRICHMENT_PLATFORM_CONFIGS.

## Recently Completed (2026-03-18) — GitHub Research Optimizations

### From Cockatiel (1.5k stars) — Retry + Circuit Breaker

- Replaced hand-rolled VPS retry with `cockatiel` `wrap(retry, circuitBreaker)` policy
- `ExponentialBackoff` 3s initial, 2 max attempts + `ConsecutiveBreaker(5)` with 60s recovery
- Static policy shared across all connector instances for global VPS health

### From Copin.io — Equity Curve Baseline Series

- Two-tone chart: green above zero (profit), red below (loss), dashed zero baseline
- SVG `clipPath` for smooth color transition at zero crossing
- Hover dot color matches profit/loss zone

### From Copin.io — Gap-Fill Daily PnL Chart

- `fillDateGaps()` inserts zero-value entries for missing dates
- Eliminates misleading visual jumps in equity curve

### From Healthchecks.io (14k stars) — Dead Man's Switch

- `lib/utils/healthcheck.ts`: `pingHealthcheck(slug, 'start'|'success'|'fail')`
- Integrated into `PipelineLogger` — 5 critical crons auto-ping: batch-fetch, compute-leaderboard, aggregate-daily, batch-enrich, check-freshness
- Controlled via `HEALTHCHECKS_PING_URL` env var

### Additional Fixes

- TraderCard: removed redundant `?? 0` for ROI
- Client-side resource leaks: VoiceRecorder, BottomSheet, AccountSection cleanup
- Exchange ranking sort: nulls always at bottom regardless of sort direction
- 2 new API endpoints: `/api/rankings/movers`, `/api/rankings/platform-stats`

## Recently Completed (2026-03-18) — Data Completeness + Frontend Fixes

### Data Completeness Overhaul (real API data only, no estimates)

- **6 new enrichment modules**: bitfinex, blofin, phemex, bingx, toobit, binance_spot
- **Backfill from 17+ exchange APIs**: hyperliquid userFills, binance performance, okx profit-detail, drift snapshots, dydx Copin, jupiter API, etc.
- **Sharpe ratio fix**: ROI delta for daily returns (was PnL chain that breaks on null/zero)
- **MDD computation**: from 90-day ROI equity curve in aggregate-daily-snapshots
- **Win rate computation**: from daily returns (% profitable days) + position history
- **VPS scraper reliability**: retry with 3s backoff, cache 30→90min (50%→75%+ success)
- **Coverage**: win_rate 66%→94.5%, max_drawdown 61%→95.1%, sharpe_ratio 37%→83.8%
- **Script**: `scripts/backfill-real-data.mjs` for re-running per-platform

### Frontend Display Fixes

- **TradingStyleRadar**: `||` → `!= null` (score=0 was hidden as falsy)
- **AdvancedMetrics**: forward sortino/calmar/profit_factor from server data (was always hidden)
- **score_confidence**: map numeric `score_completeness` to full/partial/minimal (was always showing warning)
- **ROI/PnL null display**: nullable types in TraderData interface, show "—" instead of "+0.00%"
- **SSR arena_score**: null shows "—" instead of "0"

### Pipeline Noise Reduction

- **enrich-gmx disabled**: removed from vercel.json (42% failure rate, subgraph unreliable)
- **Partial failures → warning**: multi-platform groups log success+warning instead of error
- **Health check**: skip enrichment sub-modules (eliminates 12 false WARN)

## Recently Completed (2026-03-18) — Leaderboard Fix + Supabase Singleton Migration

### Trader Count Anomaly Fix (3 root causes)

1. **`metrics_estimated` column in upsert**: Column doesn't exist in `leaderboard_ranks` → PGRST204 on every batch → 100% upsert failure. Removed from upsert payload.
2. **v1 fallback threshold**: v1 data only fetched for sources with <50 v2 traders, but v1 has 3-5x more data → always merge v1+v2 now.
3. **Degradation check too lenient**: Used absolute `< 500` floor instead of 85% threshold → now uses `DEGRADATION_THRESHOLD = 0.85`.

- **Result**: 7 exchanges → 28 exchanges, 9,133 → 9,212 traders visible in API.

### Supabase Admin Singleton Migration

- Migrated 111+ files from raw `createClient(url, key)` to `getSupabaseAdmin()` singleton.
- Covers all API routes, lib modules, and page components.
- Remaining legitimate uses: anon key auth flows, health check HTTP calls, standalone scripts.

## Recently Completed (2026-03-18) — Pipeline Critical Fix + QA Polish

### Pipeline: VPS Scraper + OKX Fix (4 root causes)

1. **VPS_PROXY_KEY trailing `\n`**: Vercel CLI stores literal newline → `.trim()` on all 5 usage sites
2. **Proxy-first anti-pattern**: bybit/bitget/mexc routed through HTTP proxy which returns 200 with empty data → flipped to scraper-first (`fetchViaVPS()` primary)
3. **BingX nested format**: scraper returns `traderInfoVo` wrapper → handle in `discoverLeaderboard()` + `normalize()`
4. **OKX proxy pagination timeout** (4 days stale): 15 pages × 3 windows through proxy exceeded Vercel 300s → switched to direct API (v5 public, not WAF-blocked), 5 pages, 10s timeout, 9s total

- **Result**: All 27 platforms green, health check 0 warnings

### QA, Performance, Pipeline Polish

- **Lighthouse optimization**: NumberTicker removed framer-motion (~50KB), defer hero stats + route prefetch via requestIdleCallback, enable Next.js image optimization
- **Connector timeout tiers**: fast/medium/slow (15s/30s/120s) based on platform WAF characteristics, lazy config in BaseConnector
- **metrics_estimated flag**: Phase 5 estimated win_rate/MDD marked in compute-leaderboard, visual indicator in UI
- **CRITICAL FIX**: compute-leaderboard arena_score sync used wrong column names (trader_key→source_trader_id, period→season_id)
- **trigger.dev Phase 2**: batch-fetch-traders fan-out tasks with 15min timeout per platform
- **Dead code cleanup**: deleted TraderPageClient.tsx (564 lines), fixed double API call in TraderProfileClient
- **i18n complete**: ja/ko 100% coverage (3977/3977 keys each)
- **Health check fix**: skip enrichment sub-modules (called by enrichment-runner.ts with withRetry) — eliminates 12 false WARN

## Recently Completed (2026-03-15) — Comprehensive Team Audit

5-agent parallel audit (pipeline, performance, security, frontend UX, operations).

**Security (10 fixes):**

1. Translate API: require auth to prevent anonymous OpenAI credit abuse
2. Library upload: replace SERVICE_ROLE_KEY bearer with ADMIN_SECRET + timingSafeEqual
3. Admin endpoints: crypto.timingSafeEqual for all secret comparisons
4. notifications/send: restrict actor_id to authenticated user
5. Library ratings + users/full: add Upstash rate limiting
6. Feedback: replace broken in-memory rate limit with Upstash, screenshot 500K→50K
7. 6 API routes: remove error.message leak to clients (checkout, manipulation alerts, ratings, metrics, cleanup-stuck-logs)
8. Export rankings: remove silent fallback to anon key
9. ExchangeConnection: explicit columns (never send API keys to client)
10. Cloudflare Worker CORS: fix origin.endsWith vulnerability

**Performance (7 fixes):**

1. resolveTrader: 4 sequential queries → OR query + Promise.all (200-400ms saved)
2. followerCountBatch: use RPC instead of fetching all rows (thousands of rows → 6 rows)
3. TradingViewChart: dynamic import lightweight-charts (~300KB bundle saved)
4. warmupCache: Redis pipeline batch writes (50 sequential → 1 round-trip)
5. TokenSidePanel: LazyMotion (~84KB saved)
6. Resources page: explicit columns instead of select('\*') on 60K table
7. ExchangeRankingClient: React.memo on inner components

**Pipeline (7 fixes):**

1. Remove okx_futures duplicate (was in both group a2 and c)
2. Remove empty group d2 from vercel.json
3. Remove dead dydx/aevo from enrichment (wasted cycles)
4. Re-enable bitunix in group c (3600+ traders)
5. Add PipelineLogger to 4 unmonitored crons
6. Stagger midnight thundering herd (10 jobs at :00 → spread to :00-:07)
7. Fix stale dead comment in batch-fetch-traders

**Code Quality:** React.memo, prefetch throttle, parallel queries, DEGRADATION.md update
**Tests:** 4 test suites updated, all pass. Zero TypeScript errors.

## Recently Completed (2026-03-10) — Mobile Comprehensive Plan

Branch: `feature/mobile-comprehensive`

**New components built:**

1. **BottomSheet** (`ui/BottomSheet.tsx`) — drag-to-resize (half/full/close), swipe-down-to-close, backdrop dismiss
2. **SwipeableView** (`ui/SwipeableView.tsx`) — horizontal swipe between children with direction lock
3. **MobileFilterSheet** (`ranking/MobileFilterSheet.tsx`) — quick filter chips + range sliders in BottomSheet
4. **ChartFullscreen** (`ui/ChartFullscreen.tsx`) — landscape-optimized overlay for charts
5. **MobileProfileMenu** (`profile/MobileProfileMenu.tsx`) — iOS Settings-style user profile + nav

**Enhancements to existing:** 6. **MobileSearchOverlay** — search history (localStorage, 10 items), chip-style recall 7. **TraderProfileClient** — swipeable tab content (overview/stats/portfolio via SwipeableView) 8. **TraderHeader** — stacks vertically on mobile, horizontal-scrolling action buttons 9. **RankingTable** — infinite scroll via IntersectionObserver sentinel (200px prefetch) 10. **Sticky tabs** — profile tabs sticky on mobile with mini header offset

**CSS improvements (responsive.css):** 11. Touch feedback: active press scale on cards/rows/buttons 12. Disabled hover on touch devices (`@media (hover: none)`) 13. Larger touch targets (36px minimum for info buttons) 14. Reduced motion support for accessibility 15. Groups/posts mobile (full-width cards, member avatar stacks) 16. Settings mobile layout (52px menu items)

**Already existed (no changes needed):**

- PullToRefresh component + hook
- Mobile gesture hooks (swipe, long press, swipe-to-delete)
- Card view with auto-switch on mobile (<768px)
- MobileBottomNav (5 tabs, scroll hide, haptics)
- Service Worker (full caching + push notifications)
- Capacitor (iOS + Android, splash, keyboard, status bar, share, haptics, biometrics, push, camera)
- Offline page

## Recently Completed (2026-03-10) — SEO + Enrichment + UX Optimization

1. **SEO: Exchange ranking pages** — English-first metadata, `generateStaticParams` for 30+ exchanges, JSON-LD ItemList schema (top 100 traders), h1/subtitle English rewrite
2. **SEO: Sitemap** — Added `/rankings/{exchange}` entries (~30 URLs), revalidation reduced from 6h to 1h
3. **SEO: ExchangePartners** — Fixed missing source links (toobit, btcc, bitfinex), added eToro to scrolling bar
4. **Enrichment: Gate.io** — New `enrichment-gateio.ts` module: equity curve from profitList, stats from web API detail endpoint
5. **Enrichment: MEXC** — New `enrichment-mexc.ts` module: equity curve + stats from copy-trade detail API (with proxy fallback)
6. **Enrichment: Drift** — New `enrichment-drift.ts` module: position history from fills API, stats from user stats endpoint
7. **Enrichment: Hyperliquid** — Expanded from position-history-only to full enrichment (equity curve from userFills, stats from clearinghouseState)
8. **Enrichment platforms**: 10 → 13 (added gateio, mexc, drift), Hyperliquid upgraded from position-only
9. **Trader detail ISR**: Removed `force-dynamic`, added `revalidate=300` (sidebar is client-only SWR, no server Redis dependency)
10. **Trader Watchlist**: Full feature — DB migration, API (GET/POST/DELETE), `useWatchlist` hook with SWR optimistic updates, `WatchlistButton` star icon
11. **eToro crypto-only filter**: Added `InstrumentTypeID=10` to API + fallback `TopTradedAssetClassName` filter to exclude stock/forex/commodity traders
12. **Tests**: Updated batch-enrich platform counts 9→12, all 137/139 suites GREEN

## Recently Completed (2026-03-06)

- Backlog: WebSocket real-time rankings (useRealtimeRankings hook + ExchangeRankingClient live merge)
- Backlog: Perpetual Protocol v2 DEX connector (The Graph subgraph, added to batch group D)
- Backlog: Portfolio analytics dashboard (stats cards, L/S distribution, by-exchange breakdown, equity curve)
- Backlog: Trader following notifications (rank change alerts in trader-alerts.ts, ±10/30 rank thresholds)
- Backlog: Capacitor mobile improvements (push notifications, network status, app badge hooks)
- P3 UX: swipe-to-reveal trader actions, scroll-snap image gallery, comment thread lines, group avatar stack
- Dark mode: design tokens across 15+ components (sidebar, PK, portfolio, user-center, SSR ranking)
- OpenClaw: Sentry convergence, dotenv loading, crontab with 6 scheduled jobs
- Zero TypeScript errors across entire codebase

## Recently Completed (2026-03-07)

- Performance: N+1 query elimination (35→1 getAllLatestTimestamps, 3→1 getTraderPerformance)
- Performance: batch-enrich parallelized (sequential 2s delay → concurrent batches of 3)
- Performance: fetch-details UPDATE batched by source (200→~5 queries)
- Performance: follower count queries grouped, timeseries capped at 500
- Performance: composite index on (source, season_id, captured_at DESC)
- Performance: select('\*') → explicit columns in core API routes
- Performance: animation limited to top 3, hover prefetch debounced, SWR 60s→300s
- Performance: dead code removed (trader-fetch.ts 564 lines, unused virtualizer -12KB)
- Frontend: WCAG contrast fix, LCP avatar preload, Zustand selector optimization
- Tests: 5 test suites fixed to match refactored code (135/135 suites, 2232/2232 tests GREEN)
- DB migrations: get_latest_timestamps_by_source RPC + composite index applied to production

## Recently Completed (2026-03-08) — DeSoc Platform

Branch: `feature/desoc-platform`, 23 files, +1310 lines

### P0: Trader Claim System

- DB migration: `trader_claims`, `verified_traders`, `user_exchange_connections` tables
- API: `/api/traders/claim` (GET/POST), `/api/traders/claim/review` (POST admin)
- API: `/api/traders/verified` (GET/PUT)
- API: `/api/exchange/verify-ownership` (POST)
- Frontend: `ClaimTraderButton`, `VerifiedBadge` components
- Tests: 24 new tests for claims, attestation, score gating

### P0: Bot + Human Unified Ranking

- DB: `is_bot`, `bot_category` columns on `trader_sources`
- Types: `is_bot`, `bot_category`, `is_verified` on `Trader`, `RankedTrader`
- UI: Bot badge + Verified badge in `TraderRow`
- Filter: Human/Bot/All filter in `RankingFilters`
- Leaderboard: `trader_type` field in `compute-leaderboard`

### P1: Reputation-Driven Social

- DB: `reputation_score`, `is_verified_trader` on `user_profiles`
- DB: `author_arena_score`, `author_is_verified` on `posts`
- DB: `min_arena_score`, `is_verified_only` on `groups`
- Group join API: score gate + verified-only check
- Post creation: auto-injects author arena score

### P2: On-Chain Attestation

- DB: `chain_id`, `score_period`, `minted_by` on `trader_attestations`
- API: `/api/attestation/mint` (GET/POST)
- Frontend: `MintArenaScore` component (EAS Base chain)
- i18n: mint/attestation keys in en + zh

### P3: Growth & Monetization

- `CopyTradeLink` component with referral URLs for 8 exchanges
- i18n: paid groups, referral, share rank card, embed widget keys
- 42 new i18n keys in both en + zh

## Recently Completed (2026-03-08) — DeSoc Enhancement

- EAS: attestation mint API now calls `publishAttestation` server-side (uses existing lib/web3/eas.ts)
- EAS: MintArenaScore simplified — no wallet needed, server attester key signs
- EAS: removed duplicate lib/eas/ dir, unified on lib/web3/eas.ts + lib/web3/contracts.ts
- i18n: Language type expanded to en/zh/ja/ko with lazy-loading framework
- i18n: LanguageProvider generalized for all 4 languages
- i18n: LanguageToggle upgraded from binary button to 4-language dropdown
- i18n: Locale type in date.ts/validation.ts updated for ja/ko fallback
- i18n: ja.ts + ko.ts placeholders created (full translations pending)
- feature/desoc-platform merged into main
- Fixed: DirectoryPage, SnapshotViewerClient hardcoded 'zh'|'en' types

## Recently Completed (2026-03-10) — Data Coverage Expansion

1. **P0 BUG FIX**: drift/bitunix/btcc/web3_bot fetchers were missing from INLINE_FETCHERS registry → silently failing in groups G1/G2/H
2. **eToro**: New fetcher — world's largest social trading platform, 3.4M+ traders, fully public API, no auth. Top 2000 per period.
3. **Removed stub fetchers**: WhiteBit (no copy-trading feature) and BTSE (no public API) → added to DEAD_BLOCKED_PLATFORMS
4. **Tests**: Fixed 5 test suites to match current platform registry and query chains (137 pass, 2 pre-existing dead connector failures)
5. **Kwenta/Toobit**: Re-enabled by linter (Copin fallback / VPS scraper)
6. Active platforms: 24 → 28+ (drift, bitunix, btcc, web3_bot, etoro now registered)
7. Batch group I added for eToro (every 6h at :24)

## Recently Completed (2026-03-09) — Pipeline Fix & Optimization

1. BitMart confirmed dead — copytrade API "service not open" globally, added to DEAD_BLOCKED_PLATFORMS
2. batch-fetch-traders: sequential→parallel execution for all groups (fixes a2/b/d2 timeouts)
3. batch-enrich: split period=all into 3 separate cron jobs (90D/30D/7D), each gets full 300s
4. batch-enrich: increased timeout 80s→120s, batch concurrency 3→5, reduced slow platform limits
5. MEXC fetcher: reordered to try VPS scraper first (direct APIs WAF-blocked + 404)
6. CF Worker: added www.bitmart.com to ALLOWED_HOSTS
7. Pipeline cleanup: deleted 357 ghost entries (discover-rankings, refresh-hot-scores, verify-weex, dead platform avatars, old group-g, batch-enrich-all)
8. Expected pipeline success rate: 80%→90%+
9. Lighthouse performance: AsyncStylesheets moved before Providers, ThreeColumnLayout CLS fix (CSS-only mobile widget), direct CDN avatar preloads
10. Full-stack audit: 5 parallel agents audited exchange data, avatars, pipeline, frontend, live data
11. max_drawdown validation: Zod schema capped 0-100%, Hyperliquid MDD threshold <=100
12. Arena score >100 bug: composite leaderboard now caps at 100 (was 125-180 for bitget_futures)
13. Rankings API: ROI/PnL null handling (was 0→null), ExchangeLogo 17 source name aliases
14. Sharpe ratio N+1→parallel batch (50x fewer DB calls)

## Recently Completed (2026-03-08) — Data Quality Fixes

- Composite leaderboard: freshness threshold 72h→168h (Bybit was excluded due to stale data)
- DEX avatars: SVG blockie generator for wallet addresses (MetaMask-style pixel art)
- v2/rankings: avatar_url now fetched from trader_sources fallback
- Bitunix ROI: fixed format from 'percentage' to 'decimal' + normalizeROI call
- Gains ROI: improved capital estimation, returns null when unreliable
- Avatar proxy: 403 retry with minimal headers for CDN hotlink protection
- Exchange logos: added bitunix.png + bitmart.png files

## Key Metrics

- Total Traders: 34,000+
- Exchanges Supported: 36 active (+ 9 dead/blocked)
- Enrichment: 33 platforms in ENRICHMENT_PLATFORM_CONFIGS
- Cron Jobs: 60 active (with PipelineLogger)
- Tests: 139 suites, 2271 tests, ALL GREEN
- Languages: 4 (en, zh, ja, ko — all 100%)
- Lighthouse: Performance optimized (9 fixes applied), Accessibility 97, Best Practices 96, SEO 100
- VPS scraper: v16 (pool of 3 contexts, PM2 on port 3457)

## Platform Coverage

| Platform                                                            | Leaderboard | Enrichment | Proxy    |
| ------------------------------------------------------------------- | ----------- | ---------- | -------- |
| Binance Futures/Spot/Web3                                           | All done    | All done   | All done |
| Bybit, OKX, Bitget, MEXC, KuCoin, Gate.io, HTX, CoinEx, Hyperliquid | All done    | All done   | -        |

## Session Handoff Notes

- Last updated: 2026-03-22
- **Enrichment**: 4 platforms re-enabled with `raceWithTimeout()` hard deadlines. Monitor for hangs.
- **VPS scraper v16**: PM2 `arena-scraper-3457` on port 3457, proxy on 3456. Pool of 3 browser contexts.
- **WAF platforms** (bybit/bitget/bingx/mexc/xt/toobit): use `fetchViaVPS()` FIRST — proxy returns 200 with empty data
- **OKX**: direct API works (v5 public, not WAF-blocked). Don't use proxy — pagination causes timeout.
- **Dead**: KuCoin (copy trading discontinued), LBank, BitMart, Synthetix, MUX, WhiteBit, BTSE, Bitget Spot, paradex
- ESLint: no-console error, no-empty error, no-explicit-any warn
- DEGRADATION.md documents all service failure strategies

## Archive

See `docs/PROGRESS-ARCHIVE.md` for completed items prior to current sprint.
