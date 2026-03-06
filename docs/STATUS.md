# CTO Audit - Status Report

**Date:** 2026-03-05
**Auditor:** New CTO (Claude Opus 4.6)
**Scope:** Full codebase audit for stability, cleanliness, and maintainability

---

## Issues Found

### Category 1: console.log/warn/error Instead of Logger (136 occurrences)

**Severity:** Medium
**Files affected:** 40+ files in `lib/cron/fetchers/`, `lib/monitoring/`, `lib/ws/`

The project has a well-designed logger system (`lib/utils/logger.ts`) but 136 instances of raw `console.log/warn/error` remain, primarily in:
- All fetcher files (`lib/cron/fetchers/*.ts`) - ~100 occurrences
- `lib/cron/fetchers/shared.ts` - upsert error warnings use `console.warn`
- `app/api/cron/fetch-funding-rates/route.ts` - uses `console.warn` for geo-block errors
- `app/api/cron/fetch-open-interest/route.ts` - uses `console.warn` for geo-block errors

**Fix:** Replace with appropriate logger calls.

### Category 2: Missing Timeouts on Fetch Calls in Connectors

**Severity:** High - can cause hung requests and timeout issues
**Files affected:** All connector files in `lib/connectors/`

The `BaseConnector.request()` method has timeout handling, but the legacy connectors (`BinanceFuturesConnector`, `HyperliquidConnector`, `OKXConnector`, etc.) make direct `fetch()` calls in their private methods WITHOUT AbortController/timeout:
- `lib/connectors/binance-futures.ts:236-258` - `fetchLeaderboardPage()` no timeout
- `lib/connectors/binance-futures.ts:260-290` - `fetchTraderDetailApi()` no timeout
- `lib/connectors/binance-futures.ts:292-319` - `fetchPerformanceCurve()` no timeout
- `lib/connectors/hyperliquid.ts:237-252` - `fetchLeaderboard()` no timeout
- `lib/connectors/hyperliquid.ts:254-269` - `fetchUserState()` no timeout
- `lib/connectors/hyperliquid.ts:271-316` - `fetchUserPnl()` no timeout
- `lib/connectors/hyperliquid.ts:318-333` - `fetchUserFills()` no timeout
- `lib/connectors/okx.ts:176-188` - `fetchLeaderboardApi()` no timeout
- `lib/connectors/okx.ts:190-209` - `fetchTraderDetailApi()` no timeout

Note: The inline fetchers in `lib/cron/fetchers/shared.ts:fetchJson()` DO have timeout (15s default).

**Fix:** Add AbortController with timeout to all direct fetch calls in connector private methods.

### Category 3: Duplicate Circuit Breaker Implementations

**Severity:** Medium - Code duplication, maintenance burden
**Files affected:**
- `lib/connectors/base.ts:70-127` - inline `CircuitBreaker` class
- `lib/connectors/circuit-breaker.ts:8-71` - `SimpleCircuitBreaker` class
- `lib/connectors/circuit-breaker.ts:106-131` - `ManagedCircuitBreaker` class

Three different circuit breaker implementations with slightly different behavior:
1. Base.ts uses `'half_open'` (underscore) state naming
2. circuit-breaker.ts uses `'half-open'` (hyphen) state naming
3. Base.ts circuit breaker doesn't track `openTime`
4. `ManagedCircuitBreaker.getStats()` hardcodes 60000ms recovery instead of using parent's `recoveryTimeMs`

**Fix:** Consolidate into single implementation.

### Category 4: Duplicate Supabase Client Creation

**Severity:** Medium - Inconsistent initialization, potential connection leaks
**Files affected:**
- `lib/cron/fetchers/shared.ts:48-53` - creates new client per call
- `app/api/cron/fetch-funding-rates/route.ts:168-170` - inline `createClient` with `!` assertions
- `app/api/cron/fetch-open-interest/route.ts:168-170` - same pattern
- `app/api/stripe/webhook/route.ts:11-23` - lazy singleton with Proxy

These should all use `getSupabaseAdmin()` from `lib/api`.

**Fix:** Standardize on single Supabase admin client factory.

### Category 5: Non-null Assertions on Env Vars

**Severity:** High - will crash at runtime if vars not set
**Files affected:**
- `app/api/cron/fetch-funding-rates/route.ts:168-169` - `process.env.NEXT_PUBLIC_SUPABASE_URL!`
- `app/api/cron/fetch-open-interest/route.ts:168-169` - same pattern
- Several other cron routes

The project has `lib/env.ts` for validated env access but some files bypass it.

**Fix:** Use `env` import or `getSupabaseAdmin()` instead.

### Category 6: Duplicate User-Agent Lists

**Severity:** Low - Maintenance burden
**Files affected:**
- `lib/connectors/binance-futures.ts:322-329` - 5 UAs
- `lib/connectors/okx.ts:213-217` - 2 UAs
- `lib/connectors/types.ts:105` - DEFAULT_CONNECTOR_CONFIG has 1 UA
- `lib/cron/fetchers/shared.ts:217-219` - 1 UA

**Fix:** Centralize User-Agent list in a shared constant.

### Category 7: Deprecated Webhook Endpoint Still Active

**Severity:** Medium - Security/maintenance concern
**File:** `app/api/webhook/stripe/route.ts`

Marked as `@deprecated` but still proxies requests to `/api/stripe/webhook`. This adds latency and a potential failure point for payment webhooks.

**Decision:** HIGH RISK - Removing this could break existing Stripe webhook configuration. Record for manual decision.

### Category 8: `_supabase` Proxy Pattern in Stripe Webhook

**Severity:** Medium - Unnecessary complexity
**File:** `app/api/stripe/webhook/route.ts:27-36`

Uses a JS Proxy for lazy Supabase initialization, but the code actually calls `getSupabase()` directly in most places. The `_supabase` proxy is declared but never used in the handler function.

**Fix:** Remove the unused `_supabase` proxy.

### Category 9: Unused Variable in Hyperliquid Connector

**Severity:** Low
**File:** `lib/connectors/hyperliquid.ts:129`

`_userState` is fetched in `fetchTraderSnapshot()` but never used (prefixed with `_`).

**Fix:** Remove the unused fetch call to save API calls and latency.

### Category 10: Missing Response Validation on API Data

**Severity:** High - Could write corrupt data to database
**Files affected:** All fetcher files

Fetchers parse API responses and write to database without schema validation:
- `lib/cron/fetchers/binance-futures.ts` - trusts Binance API response shape
- `lib/cron/fetchers/shared.ts:upsertTraders()` - no validation before DB write
- All connector `fetchLeaderboard*` methods trust response JSON structure

**Fix:** Add zod or similar schema validation before database writes.

### Category 11: Race Condition in Cache Lock

**Severity:** Medium
**File:** `lib/cache/index.ts:472`

Line 472: `.catch(() => {})` silently swallows cache set errors after lock timeout.

**Fix:** Already uses `dataLogger.warn` elsewhere - be consistent.

### Category 12: Arena Score Calculation Duplication

**Severity:** High - Scores could diverge
**Files affected:**
- `lib/utils/arena-score.ts` - canonical implementation
- `lib/cron/fetchers/shared.ts:89-123` - duplicate "synced" copy
- `scripts/lib/shared.mjs` - another copy

Three copies of arena score calculation. Comment says "synced" but there's no mechanism to ensure they stay in sync.

**Fix:** All callers should import from `lib/utils/arena-score.ts`.

### Category 13: Hardcoded Values

**Severity:** Medium
**Files affected:**
- `lib/cron/fetchers/binance-futures.ts:43-49` - TARGET=2000, ENRICH_LIMIT=300, etc.
- `lib/connectors/circuit-breaker.ts:119` - hardcoded 60000ms
- `app/api/cron/batch-fetch-traders/route.ts:20-33` - platform groups hardcoded
- `app/api/cron/batch-enrich/route.ts:18-33` - platform configs hardcoded
- Multiple cron routes: `maxDuration = 300` scattered everywhere

**Fix:** Move to configuration constants file.

### Category 14: `catch {}` Blocks That Silently Swallow Errors

**Severity:** Medium
**Files affected:** 30+ files with `catch {` blocks

Many fetcher files use bare `catch {}` (no error variable) which makes debugging impossible:
- All fetcher files in `lib/cron/fetchers/`
- `app/api/search/` routes

**Fix:** At minimum log the error, even if operation continues.

### Category 15: Duplicate Redis Client Initialization

**Severity:** Medium
**Files affected:**
- `lib/cache/index.ts:52-102` - one Redis initialization pattern
- `lib/cache/redis-layer.ts:152-180` - different Redis initialization pattern

Two separate Redis clients with different initialization logic, health checking, and error handling.

**Fix:** Consolidate into single Redis client.

### Category 16: Missing Error Handling in Stripe Webhook DB Operations

**Severity:** High - Payment data could be lost
**File:** `app/api/stripe/webhook/route.ts`

Several DB operations don't check for errors:
- Line 340-347: `handleSubscriptionCanceled` - `.update()` without error check
- Line 349-355: same function, second `.update()` without error check

**Fix:** Add error checking and logging for all DB operations in payment flows.

### Category 17: `fetchBinanceFutures` Enrichment `catch` Block Is Empty

**Severity:** Medium
**File:** `lib/cron/fetchers/binance-futures.ts:188`

Line 188: `catch { break }` silently stops pagination without logging what happened.

**Fix:** Log the error before breaking.

---

## HIGH RISK Items (Not Executing - Awaiting Decision)

### HR-1: Deprecated Stripe Webhook Endpoint
**File:** `app/api/webhook/stripe/route.ts`
**Risk:** Deleting could break Stripe webhook delivery if dashboard still points here.
**Recommendation:** Verify Stripe Dashboard webhook URL, then delete. Do NOT delete without checking.

### HR-2: Arena Score Formula Changes
**Files:** `lib/cron/fetchers/shared.ts`, `scripts/lib/shared.mjs`
**Risk:** Changing the duplicated arena score calculation could affect rankings for 32,000+ traders.
**Recommendation:** After consolidating, run a comparison test to verify scores match before deploying.

### HR-3: Database Schema Dependencies
**Tables:** `trader_profiles_v2`, `trader_snapshots_v2`, `leaderboard_ranks`, etc.
**Risk:** Any schema changes could affect live data pipeline serving 27 cron jobs.
**Recommendation:** No schema changes without migration + rollback plan.

---

## Fix Plan (In Order)

### Batch 1: Critical Safety Fixes
1. Add timeouts to all connector fetch calls
2. Fix non-null assertions on env vars (use getSupabaseAdmin)
3. Add error checking to Stripe webhook DB operations
4. Fix silent `catch {}` blocks in fetchers (add logging)

### Batch 2: Code Consolidation
5. Consolidate circuit breaker implementations
6. Remove unused `_supabase` proxy in webhook
7. Remove unused `_userState` fetch in Hyperliquid
8. Standardize Supabase client creation

### Batch 3: Logger Migration
9. Replace console.log/warn/error with logger in fetchers
10. Replace console.log/warn/error in cron routes

### Batch 4: Hardening
11. Add response schema validation for critical API data
12. Centralize User-Agent list
13. Move hardcoded values to config
14. Consolidate arena score to single source of truth

### Batch 5: Cleanup
15. Remove duplicate Redis initialization
16. Fix cache lock error handling
17. Clean up dead code identified by audit agents

---

## Summary

| Metric | Count |
|--------|-------|
| Total issues found | 17 categories |
| Critical (will fix) | 14 |
| High risk (need decision) | 3 |
| Skipped | 0 |

**Project assessment:** The codebase is functional and well-structured at the architecture level. The main problems are:
1. Inconsistent error handling patterns across fetchers/connectors
2. Code duplication (circuit breaker, arena score, Redis init, Supabase client)
3. Raw console.log instead of structured logger
4. Missing timeouts on external API calls in legacy connectors
5. Missing input validation before database writes

The data pipeline is the highest-risk area - 27 cron jobs writing to production database with minimal validation.
