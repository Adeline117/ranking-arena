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

### 2026-05-09 Commercial Go/No-Go (30 days from paywall live)
- [ ] **Decision point: paying subs ≥ 20 by 2026-05-09?**
      Current: 2 (per `/admin/pro-metrics` + weekly-metrics Telegram push).
      If YES → accelerate product on core path (live signals, copy flow).
      If NO → re-evaluate per CEO review 2026-04-09: pivot to B2B data API,
      or execute scope kill list (`docs/reviews/scope-audit-2026-04-09.md`).
      Source: `docs/reviews/2026-04-09-full-review.md` bottom line.

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

### Follow-ups from 5-agent review 2026-04-09
- [ ] TraderHeader complete decomp: extract avatar block + actions block
      (badge row already extracted in b11eeeea1). 40-prop interface still
      needs trimming.
- [ ] compute-leaderboard main loop split: computeSeason + main season loop
      still in route.ts (2000 lines). Post-processing already extracted in
      fc9142bee.
- [ ] Execute scope audit P0 deletions: `/frame`, `/kol`, `/tip`,
      `/channels`. Spec at `docs/reviews/scope-audit-2026-04-09.md`.
- [ ] PostHog instrumentation on pricing checkout funnel — signup rate /
      paywall hit rate / cart abandonment. weekly-metrics only sees the
      result, not the funnel.
- [ ] Trust ratio metric: needs dedicated RPC or materialized view. Current
      query against `leaderboard_ranks` times out at 30s Supabase statement
      limit (known in weekly-metrics.mjs). Add `get_top_trust_ratio()` RPC.

---

## 🟡 P2 - Should Do Soon

_None currently — see Retired below_

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
- ~~Trading signal alerts refinement~~ — `lib/services/trading-signals.ts`
  was completely orphaned dead code (zero importers). Deleted in 578a909a0.
  Re-add only when there's a UX decision to actually ship the feature.

## Completed (March 2026)
_See PROGRESS.md archive section for full list_

---

## Notes
- Don't start P2/P3 until P1 is clear
- Each task should be doable in one session
- Large tasks should be broken into subtasks
