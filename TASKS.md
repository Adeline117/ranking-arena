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

_None currently_

---

## 🟠 P1 - High Priority

### Data Quality
- [ ] Sharpe coverage: push from 59% → 75%+ (eToro, HL, Drift remaining)
- [ ] Monitor inline enrichment architecture (fetch+enrich one-pass)
- [ ] Verify okx_futures staleness (occasionally 10h, should be ≤6h)

### Infrastructure
- [ ] BloFin Sharpe: find US/EU proxy (SG VPS geo-blocked, Mac CF 403)
- [ ] eToro CopySim: retry after 24h IP cooldown

---

## 🟡 P2 - Should Do Soon

### Code Quality
- [ ] Clean up /tmp scripts (push-sharpe-raw.mjs, compute-sharpe-daily.mjs)
- [ ] Update CLAUDE.md metrics (connector count, enrichment platforms)
- [ ] Archive completed TASKS from March sprint

### Features
- [ ] Vertex/Apex/RabbitX DEX connectors (in progress from Sprint 3/31)
- [ ] Trading signal alerts refinement (position change detection)

---

## 🟢 P3 - Nice to Have

- [ ] Lighthouse re-audit on production (API quota previously exhausted)
- [ ] Monthly dependency update review (dependabot PRs merging)
- [ ] Test suite maintenance (139 suites — verify all still green)

---

## ⚪ Backlog

- [ ] snapshots_v2 monthly partitioning (migration prepared, needs maintenance window)
- [ ] Increase bybit/weex enrichment concurrency from 1 (if raceWithTimeout stable)
- [ ] US/EU VPS for BloFin + other geo-restricted platforms

---

## Completed (April 2026)
- [x] Remove 59 AI-generated slop docs (-16,494 lines)
- [x] Update README metrics (migrations 184, API routes 292, crons 53, i18n 4,800+)
- [x] Condense PROGRESS.md 621→142 lines
- [x] Fix PostDetailActions React compiler lint error
- [x] Inline enrichment architecture (5 commits)
- [x] 10x enrichment batch limits for low-sharpe platforms

## Completed (March 2026)
_See PROGRESS.md archive section for full list_

---

## Notes
- Don't start P2/P3 until P1 is clear
- Each task should be doable in one session
- Large tasks should be broken into subtasks
