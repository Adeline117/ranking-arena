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

- [x] Landing section on homepage — API CTA banner below ranking table + nav/footer links to /api-docs
- [ ] Reach out to copy-trading platforms, analytics tools, hedge funds
- [x] Add API link to README (Data API section with pricing + curl example) + nav + footer

---

## 🟠 P1 - High Priority

### Data Quality (feeds directly into API product value)

- [x] Verify overall Sharpe lifts from 29% → 45%+ — actual: 77% (7D), 85% (30D), 91% (90D)
- [x] Verify okx_futures staleness — 0 gaps >2h in last 7 days (worker fixed it)
- [x] Gains enrichment: switched to leaderboard API + Sharpe estimate from avg_win/avg_loss

### Infrastructure

- [x] BloFin Sharpe: added 12h staleness alert in health monitor (Mac Mini only, no fallback)
- [x] eToro CopySim: added automatic 24h IP cooldown via PipelineState (enrichment-etoro detects 403/429, enrichment-runner skips until cooldown expires)

### Code Quality

- [x] computeSeason split: 1369 → 889 lines (-480). Extracted scoreTraders, checkDegradationGuard, fetchCurrentScoreMap + buildChangedTraders, upsertLeaderboard + zeroOutExcluded into 4 helper files
- [x] TraderHeader 40-prop interface trim (40 → 34: removed uid, following, isPro, maxDrawdown, winRate, profileUrl)
- [x] Deep 6-direction root-cause audit (2026-06-02 session #2) — see below

### Deep 6-Direction Audit (2026-06-02 session #2)

19 commits, all type-check + 2,612 tests passing. Post-deploy 5/5 healthy.

- [x] **C-1** Pin react to exact 19.2.6 (prevent version drift)
- [x] **C-2** Remove 10 redundant Vercel crons (54→44, BullMQ handles enrich/score/meilisearch)
- [x] **C-3** Batch hashtag post_count via `recount_hashtag_posts()` RPC (N+1 → 1 query)
- [x] **H-1** Delete 3 dead cron routes (-1,501 LOC: batch-fetch-traders, pipeline-fetch, auto-post-insights)
- [x] **H-2** Remove 5 dead deps + trigger.dev files (@trigger.dev/sdk, critters, puppeteer x3, chrome-launcher)
- [x] **H-3** Migrate TokenBucket from `redis` to `ioredis` (3→2 Redis clients)
- [x] **H-4** npm prune extraneous trigger.dev deps (21→11 vulns, 0 high)
- [x] **H-5** Fix silent cache failure logging in market overview
- [x] **H-6** Disable refetchOnWindowFocus on posts + notifications (tab-switch jank fix)
- [x] **H-7** Increase trader detail staleTime 10s→2min (match pipeline frequency)
- [x] **M-1** Handle Supabase errors in 4 group auth checks (security logging)
- [x] **M-4** Add min-height loading placeholders to dynamic imports (CLS fix: EquityCurve/ExchangeLinks/LinkedAccounts)
- [x] **M-5** Centralize React Query staleTime via `cache-presets.ts` (5 named tiers, 22 files updated)
- [x] **M-7** Remove deprecated `getSupportedInlinePlatforms` alias + dead `InlineFetcherFn` type
- [x] **M-8** Split pipeline-evaluator.ts (1743→236 LOC + 3 check files)
- [x] **M-9** Reduce React Query gcTime 5min→2min (prevent OOM on low-memory devices)
- [x] **L-2** Zustand `useShallow` in CompareFloatingBar (6 subscriptions → 1)
- [x] Remove dead devDep `@mathieuc/tradingview` (zero imports)

---

## 🟡 P2 - Should Do Soon

### From Retro 2026-06-02

- [ ] **Authenticated E2E test fixtures** — set up test account with OTP bypass for Playwright + Stripe test mode fixture. Unblocks E1-E4 test coverage gaps.
- [ ] **ja/ko translation batch** — 430 keys missing from ja.ts + ko.ts vs en.ts. Need full translation run (not a code fix).

---

## 🟢 P3 - Nice to Have

- [x] ~~**React version consistency CI check**~~ — fixed: pinned react to exact 19.2.6 (matches react-dom)
- [ ] **Automate weekly retro via OpenClaw** — `/retro` every Friday (carried from May 19 retro)
- [x] ~~**Review 5 TODO/FIXME markers**~~ — only 2 intentional TODOs remain (HEIC support + 2026-07-01 constant removal)
- [x] ~~**Check transitive npm vulns**~~ — 21 → 11 (npm prune removed trigger.dev extraneous deps; 0 high remaining, 11 moderate via viem→ws)
- [ ] Lighthouse re-audit on production (API quota previously exhausted)
- [x] Monthly dependency update review (14 dependabot PRs merged 2026-05-28)

---

## ⚪ Backlog

- [ ] US/EU VPS for BloFin + other geo-restricted platforms
- [ ] I18n: hardcoded English strings in 51 files (I5 — mostly placeholders + admin UI)
- [ ] I18n: numbers/dates hardcoded `'en-US'` in 20+ files (I6 — cosmetic for current locales)

---

## Notes

- Don't start P2/P3 until P1 is clear
- Each task should be doable in one session
- Large tasks should be broken into subtasks
