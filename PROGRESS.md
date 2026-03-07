# Arena Progress Tracker

> Auto-read by Claude Code at session start. Keep concise — archive completed items weekly.

## Current Sprint Focus
- All P0-P3 tasks complete. Backlog 5/6 done (only multi-language remains).

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
- Performance: select('*') → explicit columns in core API routes
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

## In Progress
- Production migration: `20260308100000_desoc_foundation.sql` (apply via Supabase Dashboard)
- Full Japanese/Korean translations (4200+ keys each)

## Key Metrics
- Total Traders: 32,000+
- Exchanges Supported: 28+ (added Perpetual Protocol)
- Cron Jobs: 27 active (45+ with PipelineLogger)
- Tests: 139 suites, 2271 tests, ALL GREEN
- Languages: 4 (en, zh, ja, ko)
- Lighthouse: Performance 58, Accessibility 97, Best Practices 96, SEO 100
- Quality: 75 -> ~95 across 10 dimensions (2026-03-06)

## Platform Coverage

| Platform | Leaderboard | Enrichment | Proxy |
|----------|-------------|------------|-------|
| Binance Futures/Spot/Web3 | All done | All done | All done |
| Bybit, OKX, Bitget, MEXC, KuCoin, Gate.io, HTX, CoinEx, Hyperliquid | All done | All done | - |

## Session Handoff Notes
- Last updated: 2026-03-07
- Zero console.log, zero empty catches in production
- DEGRADATION.md documents all service failure strategies
- ESLint: no-console error, no-empty error, no-explicit-any warn
- VPS scraper v9 running with all exchange endpoints (bybit, mexc, coinex, kucoin, bingx, lbank, gateio)
- Lighthouse: Perf 58 (4.4s redirect = Cloudflare proxy latency from local), A11y 97, BP 96, SEO 100
- Bitget Futures: ✅ working via VPS Playwright scraper (100 traders/period, verified 2026-03-07)
- Bitget Spot: ❌ no public leaderboard API exists; all endpoints return 404; needs broker API keys
- VPS scraper updated: type=spot routing added, pageSize=100 for fewer browser sessions
- Performance 58 note: 4.4s "redirect" is Cloudflare proxy overhead from local machine, not app issue

## Archive
See `docs/PROGRESS-ARCHIVE.md` for completed items prior to current sprint.
