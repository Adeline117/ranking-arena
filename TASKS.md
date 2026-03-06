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

_No critical issues currently_

---

## 🟠 P1 - High Priority

### Infrastructure
- [ ] Run pipeline_logs migration on Supabase production
- [ ] Set up Telegram bot + chat ID for alerts
- [ ] Configure OpenClaw skills on Mac Mini

---

## 🟡 P2 - Should Do Soon

### Features
- [x] Improve search ranking algorithm (exact > prefix > arena_score ranking)
- [x] Add more filter options to leaderboard (min_roi, min_pnl, min_win_rate, max_drawdown, min_score)

### UI/UX
- [ ] Loading skeleton improvements
- [ ] Mobile pull-to-refresh consistency

### Developer Experience
- [ ] Add API documentation (OpenAPI spec)

---

## 🟢 P3 - Nice to Have

- [ ] Dark mode refinements
- [ ] Sentry error convergence (weekly auto-fix from Sentry API)

---

## ⚪ Backlog

- [ ] Add WebSocket real-time updates for rankings
- [ ] Multi-language support expansion (beyond zh/en)
- [ ] Mobile app improvements (Capacitor)
- [ ] Add more DEX platforms (Perpetual Protocol, etc.)
- [ ] User portfolio analytics dashboard
- [ ] Social features: trader following notifications

---

## Completed This Sprint
_Move items here when done, then archive weekly_

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

---

## Notes
- Don't start P2/P3 until P1 is clear
- Each task should be doable in one session
- Large tasks should be broken into subtasks
