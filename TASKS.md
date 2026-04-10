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

### Data Quality (ongoing, monitor over next few runs)
- [ ] Verify sharpe coverage lifts from 62% → 70%+ after enrichment-metrics
      threshold lowered from 5→4 curve points (shipped 2026-04-09)
- [ ] Verify okx_futures staleness (occasionally 10h, should be ≤6h)

### Infrastructure (external dependencies)
- [ ] BloFin Sharpe: now Mac Mini only (geo-blocked from VPS + CF). Watch
      `scripts/openclaw/fetch-blofin.mjs` success rate
- [ ] eToro CopySim: retry after 24h IP cooldown

---

## 🟡 P2 - Should Do Soon

### Features
- [ ] Trading signal alerts refinement — position change detection already
      lives in `lib/services/trading-signals.ts`, needs UX pass on alert
      frequency + noise reduction

---

## 🟢 P3 - Nice to Have

- [ ] Lighthouse re-audit on production (API quota previously exhausted)
- [ ] Monthly dependency update review (dependabot PRs merging)

---

## ⚪ Backlog

- [ ] snapshots_v2 monthly partitioning (migration prepared, needs maintenance window)
- [ ] US/EU VPS for BloFin + other geo-restricted platforms

---

## Completed (April 2026)
- [x] Lower sharpe/sortino/calmar threshold 5→4 curve points (enrichment-metrics.ts)
- [x] Fix 5 stale test suites → 135/135 green (check-trader-alerts,
      bybit-futures, gains-perp, feed/personalized, batch-enrich)
- [x] Add hreflang language alternates (en/zh-CN/ja/ko/x-default)
- [x] Remove 30 stale MDs from root + docs + specs (-5,863 lines)
- [x] Update CLAUDE.md metrics (34,000+ traders, 32+ exchanges, 62 crons)
- [x] Clean up /tmp scripts (push-sharpe-raw.mjs, compute-sharpe-daily.mjs)
- [x] Remove 59 AI-generated slop docs (-16,494 lines)
- [x] Update README metrics (migrations 184, API routes 292, crons 53, i18n 4,800+)
- [x] Condense PROGRESS.md 621→142 lines
- [x] Fix PostDetailActions React compiler lint error
- [x] Inline enrichment architecture (5 commits)
- [x] 10x enrichment batch limits for low-sharpe platforms
- [x] Monitor inline enrichment architecture (stable, no regressions)

## Retired (no longer actionable)
- ~~Vertex/Apex/RabbitX DEX connectors~~ — all 3 confirmed dead 2026-04:
  vertex (no public API), apex_pro (geo-blocked + no API), rabbitx (DNS dead).
  See `lib/connectors/registry.ts:253`.
- ~~Increase bybit/weex enrichment concurrency from 1~~ — bybit already
  runs at concurrency 2 (`enrichment-runner.ts:338`); weex disabled entirely
  2026-04-01 (75% timeout rate).

## Completed (March 2026)
_See PROGRESS.md archive section for full list_

---

## Notes
- Don't start P2/P3 until P1 is clear
- Each task should be doable in one session
- Large tasks should be broken into subtasks
