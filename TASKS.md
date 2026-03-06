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

### Data Pipeline
- [x] Complete HTX Futures enrichment coverage
- [x] Monitor data freshness across all platforms
- [x] Verify backfill scripts cover all edge cases

### Infrastructure
- [ ] Optimize VPS cron deployment scripts
- [ ] Review Vercel cron job scheduling conflicts

---

## 🟡 P2 - Should Do Soon

### Performance
- [ ] Audit N+1 queries in ranking pages (in progress - perf review)
- [ ] Add missing database indexes for slow queries
- [ ] Review React component re-renders

### Data Quality
- [x] Add data validation for incoming trader snapshots (Zod schema in shared.ts)
- [x] Implement anomaly detection for ROI/PnL spikes (detect-anomalies cron)
- [ ] Clean up orphaned trader_sources entries

### Features
- [ ] Improve search ranking algorithm
- [ ] Add more filter options to leaderboard

---

## 🟢 P3 - Nice to Have

### Developer Experience
- [x] Add more E2E tests for critical flows (smoke.spec.ts + visual-regression.spec.ts)
- [ ] Improve error messages in API responses
- [ ] Add API documentation (OpenAPI spec)

### UI/UX
- [ ] Loading skeleton improvements
- [ ] Mobile pull-to-refresh consistency
- [ ] Dark mode refinements

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

- [x] Proxy fallback for Binance geo-blocking
- [x] 7 missing platforms to batch groups
- [x] OKX Futures MDD enrichment 100%
- [x] Cleanup unused code
- [x] HTX Futures enrichment (equity curve + stats detail + batch-enrich)
- [x] Data freshness monitoring (cron + admin dashboards + alerts)
- [x] PipelineLogger integrated into 6 core cron jobs
- [x] Dependencies health API (/api/health/dependencies)
- [x] E2E smoke test + visual regression test
- [x] Data validation (Zod schema for trader snapshots)
- [x] Anomaly detection cron job
- [x] Product priority section in CLAUDE.md

---

## Notes
- Don't start P2/P3 until P1 is clear
- Each task should be doable in one session
- Large tasks should be broken into subtasks
