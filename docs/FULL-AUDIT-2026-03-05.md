# Arena Full Project Audit Report
**Date:** 2026-03-05 | **Auditor:** 10-Agent Team (Claude Opus 4.6) | **Branch:** feature/autonomous-ops

---

## Executive Summary

| Dimension | Health | Critical Issues | Key Strength |
|-----------|--------|----------------|--------------|
| Architecture | STRONG | 0 | Well-modularized, modern stack (Next.js 16, React 19) |
| Database | EXCELLENT | 0 | 275 indexes, 100 migrations, comprehensive RLS |
| API Routes | STRONG | 0 | 289 routes, standardized error handling, rate limiting |
| Exchange Connectors | GOOD | 2 | 45+ connectors, circuit breakers, proxy fallback |
| Performance | NEEDS WORK | 3 | Good caching infra, but N+1 queries in cron jobs |
| Security | NEEDS WORK | 3 | Strong RLS/auth, but exposed secrets & auth bypasses |
| Silent Failures | CRITICAL | 6 | fireAndForget util exists but unused in 30+ locations |
| Data Quality | CRITICAL | 3 | normalizeROI() dead code, Arena Score divergence |
| Frontend/UI | STRONG | 0 | 262 components, SSR+CSR hybrid, PWA+Capacitor |
| Infrastructure | GOOD | 0 | 27 cron jobs, tiered cache, Sentry monitoring |

**Overall Assessment:** Production-grade platform with strong architecture and database design. The highest-risk area is the data pipeline -- silent failures in enrichment, inconsistent ROI normalization, and divergent Arena Score implementations threaten data integrity for 32,000+ traders.

---

## Top 15 Issues (Priority Order)

### CRITICAL (Fix Immediately)

#### 1. Hardcoded Production Secrets in Committed File
- **File:** `infra/bullmq/.env:3-7`
- **Risk:** CRON_SECRET and SUPABASE_SERVICE_ROLE_KEY exposed
- **Fix:** Rotate keys immediately, delete file, add to .gitignore

#### 2. Missing Auth on Stripe Session Verification
- **File:** `app/api/stripe/verify-session/route.ts:47-56`
- **Risk:** Anyone with a Stripe session ID can upgrade accounts to Pro
- **Fix:** Add `getAuthUser(request)` and verify user.id matches session metadata

#### 3. Admin Auth Bypass When Secrets Not Configured
- **Files:** `app/api/admin/data-freshness/route.ts:20-25`, `app/api/monitoring/freshness/route.ts:69-73`
- **Risk:** `if (validSecret && token !== validSecret)` fails open when env vars unset
- **Fix:** Change to `if (!validSecret || token !== validSecret)`

#### 4. Two Divergent Arena Score Implementations
- **Files:** `lib/cron/fetchers/shared.ts:89` vs `lib/utils/arena-score.ts:339`
- **Risk:** Ingestion uses 4-component (ROI:70 + PnL:15 + DD:8 + Stability:7), leaderboard uses 2-component (ROI:60 + PnL:40). Scores diverge.
- **Fix:** Consolidate to single implementation; either compute at ingestion or at leaderboard time, not both

#### 5. `normalizeROI()` Dead Code; 30+ Fetchers Use Ad-Hoc Normalization
- **File:** `lib/cron/fetchers/shared.ts:281` (never called)
- **Risk:** Gate.io uses threshold `< 100` (can inflate 50% ROI to 5000%), LBank/Pionex use `< 1`, most use `< 10`
- **Fix:** Centralize with per-platform ROI format metadata (decimal vs percentage)

#### 6. Enrichment Functions Return `[]` on All Errors
- **File:** `lib/cron/fetchers/enrichment.ts` (15+ functions)
- **Risk:** Network errors, API changes, rate limits all silently return empty data. Caller counts these as "success."
- **Fix:** Return discriminated union `{ ok, data } | { ok: false, error, retryable }`

### HIGH (Fix This Sprint)

#### 7. N+1 Query in Daily Snapshot Aggregation
- **File:** `app/api/cron/aggregate-daily-snapshots/route.ts:77-175`
- **Risk:** 2 queries per trader x 32,000 traders = 64,000 queries per run
- **Fix:** Batch-fetch all snapshots for the day in one query, build in-memory map

#### 8. `exec_sql` RPC Function Exists in Database
- **File:** `app/api/cron/refresh-hot-scores/route.ts:106-118`
- **Risk:** If any route passes user input to this RPC, enables full SQL injection
- **Fix:** Remove `exec_sql` RPC, replace with dedicated parameterized functions

#### 9. 30+ Supabase Queries in Cron Jobs Ignore Error Field
- **Files:** `app/api/cron/weekly-ranking/route.ts`, `subscription-expiry/route.ts`, `backfill-data/route.ts`, etc.
- **Risk:** Database errors silently produce empty results; subscription downgrades can leave users in inconsistent state
- **Fix:** Check `{ data, error }` on all Supabase operations in cron routes

#### 10. NULL Win Rate/MDD Gives Free Score Bonus
- **File:** `lib/cron/fetchers/shared.ts:111-120`
- **Risk:** NULL win_rate gets 3.5/7 stability points. dYdX traders (always null) score higher than Binance traders with 48% actual win rate
- **Fix:** Use confidence multiplier (like V3 scorer) instead of 50% default

#### 11. 30+ `.catch(() => {})` in Production Code
- **Files:** `lib/cache/index.ts:472`, 9 market components, `lib/middleware/error-interceptor.ts:37,70`
- **Risk:** Entire classes of errors invisible; Sentry import failure kills all error reporting
- **Fix:** Replace with `fireAndForget()` or at minimum `console.error`

### MEDIUM (Fix Next Sprint)

#### 12. CRON_SECRET Accepted as GET Query Parameter
- **File:** `app/api/scrape/trigger/route.ts:3,210,214`
- **Risk:** Secret exposed in server logs, browser history, CDN logs
- **Fix:** Only accept via Authorization header

#### 13. Batch Cron Routes Return 200 on Failure
- **Files:** `app/api/cron/batch-fetch-traders/route.ts:98-108`, `batch-enrich/route.ts:124`
- **Risk:** Vercel Cron treats 200 as success; failed platforms never trigger alerts
- **Fix:** Return 500 or 207 when sub-operations fail

#### 14. Missing Timeouts on Connector Fetch Calls
- **Files:** `lib/connectors/binance-futures.ts`, `hyperliquid.ts`, `okx.ts` (9+ private methods)
- **Risk:** Hung requests can exhaust serverless function time
- **Fix:** Add AbortController with 30s timeout to all direct fetch calls

#### 15. No Pre-Insertion Data Validation
- **File:** `lib/cron/fetchers/shared.ts:129-210`
- **Risk:** Bad API data flows directly to database. `quality_flags.is_suspicious` always `false`, `data_completeness` always `0.9`
- **Fix:** Add validation before DB write; integrate existing anomaly-detection.ts service

---

## Dimension Details

### 1. Architecture (STRONG)

**Stats:** 2,612 TS files | 950 app/ | 393 lib/ | 822 scripts/ | 447 worker/

**Strengths:**
- Clean separation: app/ (pages) -> lib/ (business logic) -> scripts/ (maintenance)
- Modern stack: Next.js 16 + React 19 + Turbopack + Tailwind v4
- 45+ remote image domains whitelisted for exchange CDNs
- Tree-shaking for 25+ large packages
- Security headers: CSP, HSTS, X-Frame-Options, Permissions-Policy

**Issues Found:** None critical. Well-organized codebase.

### 2. Database (EXCELLENT)

**Stats:** 85+ tables | 275 indexes | 100 migrations | 200+ RLS policies | 40+ functions

**Strengths:**
- RLS enabled on ALL tables with proper policy coverage
- Comprehensive CHECK constraints (win_rate 0-100, MDD -100 to 0, etc.)
- Atomic counter functions prevent race conditions
- Trigram indexes enable fast fuzzy search
- Safe migration practices (IF NOT EXISTS, NOT VALID constraints)
- 48-hour leaderboard snapshot retention prevents data explosion

**Watch Items:**
- Partition `trader_snapshots` after 500K rows
- Validate NOT VALID constraints in production
- Add TTL to `translation_cache` table

### 3. API Routes & Crons (STRONG)

**Stats:** 289 routes | 27 scheduled crons | 214 auth-required (74%)

**Strengths:**
- Standardized error system with error codes (1xxx-7xxx)
- Rate limiting on 214 routes via Upstash Redis
- Granular cache headers (30s-1800s based on data volatility)
- Batch fetch groups (A-F) distribute load across 3-12 hour intervals

**Issues:** Covered in Top 15 (#12, #13)

### 4. Exchange Connectors (GOOD)

**Stats:** 45+ implementations | 9 CEX + 9 DEX main connectors

**Strengths:**
- BaseConnector pattern with unified interface
- Circuit breaker + rate limiter built-in
- CloudFlare Worker proxy for geo-blocked APIs (Binance, OKX, dYdX)
- Enrichment pipeline: equity curves, position history, stats detail

**Issues:** Missing timeouts (#14), inconsistent ROI normalization (#5)

### 5. Performance (NEEDS WORK)

**Critical N+1 Patterns:**
- `aggregate-daily-snapshots`: 64,000 queries per run (#7)
- `fetch-details`: 200 sequential UPDATE queries for `details_fetched_at`
- `getAllLatestTimestamps`: 31 parallel queries instead of 1 GROUP BY query

**Over-Fetching:** 80+ instances of `.select('*')` across API routes

**React:** TraderRow creates 400 Zustand subscriptions for 100 rows; unused virtualizer imported

**Positive:** Good caching infra (memory -> Redis -> DB), `React.memo` on TraderRow, `Promise.all` parallelization in data layer

### 6. Security (NEEDS WORK)

**Critical:** Exposed secrets (#1), missing auth on payment endpoint (#2), admin auth bypass (#3)

**High:** CRON_SECRET in query params, `exec_sql` RPC, no auth on rankings export, `x-cron-secret` custom header

**Positive:** Stripe webhook signature verification, RLS on all tables, DOMPurify for XSS, CSRF infrastructure (though disabled on some routes), proper service role isolation

### 7. Silent Failures (CRITICAL)

**Systematic Pattern:** catch -> log warn -> return empty default

**Most Dangerous:**
- 15+ enrichment functions return `[]` on any error
- 30+ Supabase queries ignore error field
- Subscription downgrade operations unchecked
- Sentry import failure kills all error reporting
- Compute leaderboard "rollback" detection happens AFTER overwrite

**Positive:** `fireAndForget` utility exists but needs wider adoption

### 8. Data Quality (CRITICAL)

**Arena Score:** Two implementations with different weights produce different results

**ROI Normalization:** Each of 30+ fetchers has its own threshold logic:
- Gate.io: `< 100` (can 100x inflate legitimate percentages)
- LBank/Pionex: `< 1`
- Most others: `< 10`
- `normalizeROI()` in shared.ts: never called

**Period Mapping Issues:**
- Gains/GMX serve identical all-time data for 7D/30D/90D
- Hyperliquid maps 90D to "allTime"

**Positive:** Database CHECK constraints catch some bad data; `clean_trader_snapshot_outliers()` function exists

### 9. Frontend/UI (STRONG)

**Stats:** 262 components | 30 hooks | 4 Zustand stores | 79 pages | 2 languages

**Strengths:**
- SSR ranking table for LCP, client hydration with code-splitting
- Design token system with 400+ CSS variables
- 3-level error boundaries (Page/Section/Compact)
- PWA + Capacitor for iOS/Android
- Dual auth: Supabase (email) + Privy (Web3)
- 50,000+ URL sitemap with ISR revalidation

**Issues:** None critical. Some hardcoded strings that should be translated.

### 10. Infrastructure (GOOD)

**Stats:** 27 cron jobs | 140+ scripts | 3 deployment targets (Vercel, CF Worker, VPS)

**Strengths:**
- Tiered cache: memory (1-5min) -> Redis (5-60min) -> DB
- CI pipeline: lint -> type-check -> unit tests -> build -> E2E
- Sentry with lazy client loading (avoids 700KB bloat)
- Comprehensive env var management (187 vars in .env.example)

**Issues:** Coverage threshold at 7-9% (very low); no automated pipeline failure alerting

---

## Recommended Fix Batches

### Batch 1: Security (1-2 days)
1. Rotate exposed keys, delete `infra/bullmq/.env`
2. Add auth to `verify-session` endpoint
3. Fix admin auth bypass (fail-closed)
4. Remove `exec_sql` RPC from database
5. Remove CRON_SECRET from query params

### Batch 2: Data Integrity (2-3 days)
6. Consolidate Arena Score to single implementation
7. Centralize ROI normalization with per-platform config
8. Add pre-insertion validation in `upsertTraders()`
9. Fix NULL win_rate/MDD scoring bonus
10. Fix Gate.io ROI threshold (`< 100` -> `< 10`)

### Batch 3: Silent Failures (2-3 days)
11. Replace 30+ `.catch(() => {})` with `fireAndForget()`
12. Add Supabase error checking to all cron queries
13. Return proper HTTP status from batch cron routes
14. Fix enrichment return types (discriminated union)

### Batch 4: Performance (1-2 days)
15. Fix N+1 in `aggregate-daily-snapshots` (batch queries)
16. Fix N+1 in `getAllLatestTimestamps` (GROUP BY)
17. Replace `.select('*')` with explicit columns in critical paths

### Batch 5: Hardening (1-2 days)
18. Add timeouts to connector fetch calls
19. Integrate anomaly-detection.ts into pipeline
20. Increase test coverage from 7% to 15%+

---

## Project Metrics Summary

| Metric | Value |
|--------|-------|
| Total TypeScript Files | ~2,612 |
| React Components | 262 |
| API Routes | 289 |
| Exchange Connectors | 45+ |
| Database Tables | 85+ |
| Database Indexes | 275 |
| Database Migrations | 100 |
| RLS Policies | 200+ |
| Cron Jobs | 27 scheduled |
| Custom Hooks | 30 |
| Zustand Stores | 4 |
| Total Traders | 32,000+ |
| Exchanges Supported | 27+ |
| Env Variables | 187 |
| Scripts | 140+ |
| Sitemap URLs | 50,000+ |
| Languages | 2 (en, zh) |
