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

### Hybrid Pivot: B2B Data API + Leaderboard as Showcase

**Decision (2026-05-12)**: 2 paying subs after 30 days → B2C alone isn't working.
Pivot to B2B data API as primary revenue, keep leaderboard as showcase/SEO funnel.

**Existing foundation**: `/api/v3` — rankings, trader, search endpoints with
API key auth, rate limiting (100/day free), edge runtime, CORS, Zod validation.

#### API Product (build)

- [x] **API docs page** (`/api-docs`) — pricing tiers, code examples (curl/Python/JS), endpoint docs
- [x] **Self-service API keys** — create/revoke in /settings, usage stats, max 5 per user
- [x] **Usage tracking** — atomic per-key counting, daily rollups, 30-day bar chart in settings
- [x] **Pricing tiers** — Free (100/day) / Starter $49/mo (10k/day) / Pro $199/mo (unlimited + webhooks)
- [x] **Stripe integration** — API tier checkout + subscription management (env: STRIPE_API_STARTER_PRICE_ID, STRIPE_API_PRO_PRICE_ID)

#### New Endpoints (build)

- [x] `platforms` — list active exchanges with name, type, trader count
- [x] `history` — daily performance time series (ROI, PnL, win rate, up to 90 days)
- [x] `bulk` — export top N traders across all platforms (up to 500)

#### Go-to-Market (do)

- [ ] Landing section on homepage or dedicated `/api` page
- [ ] Reach out to copy-trading platforms, analytics tools, hedge funds
- [ ] Add API link to README + socials

---

## 🟠 P1 - High Priority

### Data Quality (feeds directly into API product value)

- [ ] Verify overall Sharpe lifts from 29% → 45%+ (root causes fixed in 064989ff4, ee81aa2f4)
- [ ] Verify okx_futures staleness (occasionally 10h, should be ≤6h)
- [ ] Gains enrichment: native API dead, Etherscan rate-limited — needs alternative data source

### Infrastructure

- [ ] BloFin Sharpe: Mac Mini only (geo-blocked from VPS + CF). Watch success rate
- [ ] eToro CopySim: retry after 24h IP cooldown

### Code Quality

- [~] computeSeason main loop split: 972 lines → ~600 target
- [x] TraderHeader 40-prop interface trim (40 → 34: removed uid, following, isPro, maxDrawdown, winRate, profileUrl)

---

## 🟡 P2 - Should Do Soon

_None currently_

---

## 🟢 P3 - Nice to Have

- [ ] Lighthouse re-audit on production (API quota previously exhausted)
- [x] Monthly dependency update review (14 dependabot PRs merged 2026-05-28)

---

## ⚪ Backlog

- [ ] US/EU VPS for BloFin + other geo-restricted platforms

---

## Notes

- Don't start P2/P3 until P1 is clear
- Each task should be doable in one session
- Large tasks should be broken into subtasks
