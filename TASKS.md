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
- [x] TraderHeader complete decomp: badge row → b11eeeea1; avatar +
      actions blocks → b2ff1ff59 (581→370 lines). 40-prop interface
      still big — defer trim until data-flow refactor.
- [x] compute-leaderboard cleanup: 2033 → 1775 lines via post-processing.ts
      (fc9142bee), warmupLeaderboardCache extract (f7f7645c6), and helpers.ts
      dedupe (1a0f6b7a2). computeSeason main loop (~1400 lines) still
      monolithic — defer to dedicated session.
- [x] Scope audit P0 deletions: /frame and /kol deleted (a0535f99e,
      c123bf429, 68e421aba). /tip and /channels CANNOT delete — both
      have live consumers the audit missed (Stripe success_url, group
      chat). proxy.ts has the redirect for /frame and /kol.
- [x] Plausible instrumentation on pricing funnel: click_upgrade_cta +
      start_checkout events shipped via b2ff1ff59. Combined funnel:
      view_pricing → click_upgrade_cta → start_checkout → pro_subscribe.
- [x] Trust ratio RPC: get_top_trust_ratio() shipped in
      20260409173653_get_top_trust_ratio_rpc.sql. Both
      scripts/openclaw/weekly-metrics.mjs and /api/cron/weekly-metrics
      now call it (no more 30s timeouts).

### Open follow-ups
- [~] computeSeason main loop split: 1775 → 972 lines in route.ts (-45%)
      via 9 extractions in 2026-04-09 session. New files:
      trader-row.ts (TraderRow + sanitize/merge), scoring-helpers.ts
      (calmar/style/outliers/arena-followers), freshness-check.ts,
      fetch-handles.ts, enrich-stats-detail.ts, enrich-equity-curve.ts
      (Phase 4 + 4b), enrich-daily-snapshots.ts (Phase 4b2), fetch-phase1.ts.
      Remaining in route.ts: scoring loop, degradation check, upsert,
      zero-out, re-rank, stale cleanup — all higher-risk and explicitly
      deferred. Next session can target ~972 → ~600.
- [ ] TraderHeader 40-prop interface trim (requires data-flow changes)
- [x] paywall_blocked tracking shipped in 8f1da3fbf — wired into
      home filter, trader-detail tab gate, and claimed-profile tab gate

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
