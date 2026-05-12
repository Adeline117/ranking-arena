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

### Commercial Go/No-Go (deadline was 2026-05-09)

- [ ] **Decision needed**: paying subs ≥ 20? Check `/admin/pro-metrics`.
      If YES → accelerate core path (live signals, copy flow).
      If NO → pivot to B2B data API or execute scope kill list
      (`docs/reviews/scope-audit-2026-04-09.md`).

---

## 🟠 P1 - High Priority

### Data Quality

- [ ] Verify overall Sharpe lifts from 29% → 45%+ (root causes fixed in 064989ff4, ee81aa2f4)
- [ ] Verify okx_futures staleness (occasionally 10h, should be ≤6h)
- [ ] Gains enrichment: native API dead, Etherscan rate-limited — needs alternative data source

### Infrastructure (external dependencies)

- [ ] BloFin Sharpe: now Mac Mini only (geo-blocked from VPS + CF). Watch
      `scripts/openclaw/fetch-blofin.mjs` success rate
- [ ] eToro CopySim: retry after 24h IP cooldown

### Code Quality

- [~] computeSeason main loop split: currently 972 lines (-45% from 1775).
  Next target ~600. Higher-risk extractions remain: scoring loop,
  degradation check, upsert, zero-out, re-rank, stale cleanup.
- [ ] TraderHeader 40-prop interface trim (requires data-flow changes)

---

## 🟡 P2 - Should Do Soon

_None currently_

---

## 🟢 P3 - Nice to Have

- [ ] Lighthouse re-audit on production (API quota previously exhausted)
- [ ] Monthly dependency update review (dependabot PRs merging)

---

## ⚪ Backlog

- [ ] US/EU VPS for BloFin + other geo-restricted platforms

---

## Notes

- Don't start P2/P3 until P1 is clear
- Each task should be doable in one session
- Large tasks should be broken into subtasks
