# Arena Task Queue

> Priority-ordered task list. Update as tasks complete or priorities change.

## Priority Legend
- 🔴 P0: Critical/Blocking
- 🟠 P1: High priority this sprint
- 🟡 P2: Should do soon
- 🟢 P3: Nice to have
- ⚪ Backlog: Future consideration

---

## 🔴 P0 - Critical

- [x] Monitor enrichment after raceWithTimeout fix — dydx disabled (30+ min hangs), other platforms stable
- [x] Remove dead platforms from pipeline — kucoin, weex, okx_web3 removed from batch-fetch groups

---

## 🟠 P1 - High Priority

### Infrastructure
- [x] Run pipeline_logs migration on Supabase production (verified present)
- [x] Set up Telegram bot + chat ID for alerts (bot @Adeline07bot, chat 5646617467, token in Vercel env)
- [x] Configure OpenClaw skills on Mac Mini (crontab + dotenv + Telegram alerts verified)
- [x] Verify Lighthouse scores on production — site loads correctly, manual PageSpeed check needed (API quota exhausted)

---

## 🟡 P2 - Should Do Soon

### Features
- [x] Improve search ranking algorithm (exact > prefix > arena_score ranking)
- [x] Add more filter options to leaderboard (min_roi, min_pnl, min_win_rate, max_drawdown, min_score)

### UI/UX
- [x] Loading skeleton improvements (already comprehensive — 30+ page skeletons, shimmer animation, DataStateWrapper)
- [x] Mobile pull-to-refresh consistency (added to /hot, /notifications, /following)

### Observability
- [x] Correlation ID system (AsyncLocalStorage + middleware + auto-inject into logs)
- [x] Structured JSON logging in production (for Vercel Logs / log aggregation)

### Developer Experience
- [x] Add API documentation (OpenAPI spec) — already exists at public/openapi.json

---

## 🟢 P3 - Nice to Have

- [x] Dark mode refinements (design tokens + var(--color-on-accent) across 15+ components)
- [x] Sentry error convergence (weekly report + stale auto-resolve, Friday 10 AM cron)

---

## ⚪ Backlog

- [x] Add WebSocket real-time updates for rankings (useRealtimeRankings hook + ExchangeRankingClient integration)
- [x] Multi-language support expansion (ja/ko 100% complete — 3977/3977 keys each)
- [x] Mobile app improvements (Capacitor push notifications, network status, app badge hooks)
- [x] Add more DEX platforms (Perpetual Protocol v2 on Optimism via The Graph)
- [x] User portfolio analytics dashboard (stats cards, L/S distribution, equity curve)
- [x] Social features: trader following notifications (rank change alerts in trader-alerts.ts)

---

## Completed This Sprint
_Move items here when done, then archive weekly_

- [x] **Team Audit 2026-03-15** — 28 fixes across security, performance, pipeline
  - Security: translate auth, library upload ADMIN_SECRET, timingSafeEqual, notification spoofing, rate limits, error leak removal
  - Performance: resolveTrader 4→2 queries, follower RPC, TradingViewChart dynamic import (-300KB), warmupCache pipeline, LazyMotion (-84KB)
  - Pipeline: remove dead enrichments (dydx/aevo), stagger midnight crons, add PipelineLogger to 4 crons, re-enable bitunix
  - React.memo on ExchangeRankingClient, CORS fix, DEGRADATION.md update, prefetch throttle
- [x] PipelineLogger integrated into 13 cron jobs (was 2)
- [x] Dependencies health API (`/api/health/dependencies`)
- [x] E2E smoke test + visual regression test
- [x] HTX Futures added to batch-enrich MEDIUM_PRIORITY
- [x] Vercel cron schedule staggered (4 jobs moved off minute :00)
- [x] Monthly dependency update script
- [x] API response snapshot script
- [x] CLAUDE.md product priority section
- [x] N+1 query audit (no issues — already batched/parallelized)
- [x] Database index audit (36+ indexes, comprehensive)
- [x] Proxy fallback for Binance geo-blocking
- [x] 7 missing platforms to batch groups
- [x] OKX Futures MDD enrichment 100%
- [x] Cleanup unused code
- [x] Data validation (Zod schema for trader snapshots — already existed)
- [x] Anomaly detection cron job (already existed)
- [x] Data freshness monitoring (already existed)
- [x] VPS cron optimization (OpenClaw scripts already exist)
- [x] Orphaned trader_sources cleanup script (already existed)
- [x] SEO + OG for trader pages (already fully implemented)
- [x] First-screen load optimization (ISR + two-phase rendering already done)
- [x] Search ranking: exact match > prefix > arena_score performance ranking
- [x] V2 rankings API: added 5 new filter params (min_roi, min_pnl, min_win_rate, max_drawdown, min_score)
- [x] Fix O(n*m) indexOf in exchange ranking render (useMemo rankMap)
- [x] Composite index for exchange ranking queries (source, season_id, arena_score)
- [x] Stagger fetch-details cron to avoid :30 triple collision
- [x] HTX enrichment module (equity curve + stats detail from profitList)
- [x] Restored 18 files incorrectly deleted + reinstalled 4 npm packages
- [x] Fix broken TypeScript build (missing modules from cleanup commit)
- [x] Correlation ID tracing (AsyncLocalStorage + middleware X-Correlation-ID header)
- [x] Structured JSON logging in production
- [x] Logger auto-injects correlation ID into every log line
- [x] Loading skeletons verified comprehensive (30+ page skeletons)
- [x] pipeline_logs migration verified in Supabase production
- [x] Telegram bot configured (@Adeline07bot, chat 5646617467)
- [x] Pull-to-refresh on /hot, /notifications, /following
- [x] Dark mode: design tokens across sidebar, PK, portfolio, user-center, SSR ranking
- [x] P3 UX: swipe-to-reveal actions, scroll-snap gallery, comment thread lines, avatar stack
- [x] OpenAPI spec verified (public/openapi.json)
- [x] Zero TypeScript errors (all pre-existing errors fixed)

---

## Notes
- Don't start P2/P3 until P1 is clear
- Each task should be doable in one session
- Large tasks should be broken into subtasks
