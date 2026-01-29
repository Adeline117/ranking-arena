# TypeScript Strict Audit — Phase 0

**Date:** 2025-07-11
**Baseline:** 1 pre-existing TS error (TS5074 — `--incremental` config warning, not a code issue)
**tsconfig:** `strict: true` ✅ already enabled

---

## Summary

| Metric | Before | After |
|--------|--------|-------|
| `tsc --noEmit` errors | 1 (TS5074) | 1 (TS5074, unchanged) |
| `: any` / `as any` in source (non-test) | ~87 | 60 |
| `: any` / `as any` in tests | ~97 | 97 (not touched — test mocks are acceptable) |
| `@ts-ignore` | 1 | 0 |
| `@ts-expect-error` | 3 | 3 (all justified) |

**27 `any` usages removed in non-test code. 0 regressions.**

---

## Fixes Applied

### 1. Connector platform types — removed 20 × `as any` ✅

**Files:** `lib/connectors/platforms/{blofin,lbank,kwenta,mux,xt,gains,pionex}-*.ts`

All had `platform: 'xxx' as any` but the platform strings are already valid `LeaderboardPlatform` literals. The `as any` was completely unnecessary.

```diff
- platform: 'blofin' as any,
+ platform: 'blofin',
```

### 2. `catch (error: any)` → `catch (error: unknown)` — 16 catch blocks ✅

**Files:**
- `app/api/exchange/oauth/refresh/route.ts`
- `app/api/exchange/verify-ownership/route.ts` (2 blocks)
- `app/api/exchange/authorize/route.ts`
- `app/api/posts/link-preview/route.ts`
- `app/api/export/route.ts`
- `app/groups/apply/page.tsx`
- `app/welcome/page.tsx` (2 blocks)
- `app/reset-password/page.tsx` (2 blocks)
- `app/login/page.tsx` (5 blocks)

Pattern applied:
```diff
- } catch (error: any) {
-   return { error: error.message || 'fallback' }
+ } catch (error: unknown) {
+   const message = error instanceof Error ? error.message : 'fallback'
+   return { error: message }
```

### 3. Return type for `createConnector` ✅

**File:** `lib/connectors/index.ts`
```diff
- export function createConnector(platform: GranularPlatform): any {
+ export function createConnector(platform: GranularPlatform): BybitFuturesConnector | null {
```

### 4. `safeQuery` error parameter ✅

**File:** `app/api/traders/[handle]/route.ts`
```diff
- queryFn: () => PromiseLike<{ data: T | null; error: any }>
+ queryFn: () => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>
```

### 5. Supabase client parameter types ✅

**Files:** `app/api/traders/[handle]/positions/route.ts`, `app/api/traders/[handle]/equity/route.ts`
```diff
- supabase: any,
+ supabase: ReturnType<typeof createClient<any>>,
```
(Kept `<any>` generic because DB types aren't generated for these tables)

### 6. `(error as any).statusCode` → `Object.assign` ✅

**File:** `lib/supabase/server.ts`
```diff
- const error = new Error('未授权')
- ;(error as any).statusCode = 401
+ const error = Object.assign(new Error('未授权'), { statusCode: 401 })
```

### 7. `@ts-ignore` → removed ✅

**File:** `lib/performance/image-optimization.tsx`
React types already support `imageSrcSet` on `<link>` elements. The `@ts-ignore` was outdated.

### 8. `any[]` → `Record<string, unknown>[]` ✅

**File:** `app/api/export/route.ts`
```diff
- let data: any[] = []
+ let data: Record<string, unknown>[] = []
```

### 9. `updateData: any` → `Record<string, string>` ✅

**File:** `app/login/page.tsx`
```diff
- const updateData: any = { id: userId, email: userEmail }
+ const updateData: Record<string, string> = { id: userId, email: userEmail }
```

---

## Remaining `any` — Categorized by Fix Difficulty

### 🟢 Easy — Needs interface definitions (Phase 1)

| File | Line | Pattern | Suggested Fix |
|------|------|---------|---------------|
| `app/admin/hooks/useApplications.ts` | 16,36,38 | `role_names?: any`, `rules_json?: any` | Define `RoleNames` / `RulesJson` interfaces from DB schema |
| `app/admin/monitoring/components/SchedulerMetrics.tsx` | 10-12 | `tierDistribution?: any` etc. | Define `SchedulerMetricsData` interface |
| `app/admin/monitoring/page.tsx` | 38-40 | `scheduler: any` etc. | Define `MonitoringData` interface |
| `app/api/admin/monitoring/overview/route.ts` | 115-117 | `schedulerStats: any` etc. | Define `MonitoringOverview` interface |
| `app/api/users/[handle]/full/route.ts` | 68 | `let similarTraders: any[]` | `SimilarTrader[]` interface |
| `app/api/search/advanced/route.ts` | 322 | `let results: any` | Define `SearchResults` interface |
| `app/api/search/recommend/route.ts` | 280 | `let recommendations: any[]` | `Recommendation[]` interface |

### 🟡 Medium — Supabase join typing (Phase 2)

These arise because Supabase's `select()` with joins returns untyped nested objects.

| File | Lines | Pattern | Suggested Fix |
|------|-------|---------|---------------|
| `app/api/search/advanced/route.ts` | 234-240 | `(post.profiles as any)?.username` | Type the select query or add post-query type assertion |
| `app/api/search/recommend/route.ts` | 184-251 | `(post.profiles as any)?.username` | Same as above |
| `app/api/bookmark-folders/subscribed/route.ts` | 56,78 | `(s.bookmark_folders as any)` | Type the join result |
| `app/api/bookmark-folders/[id]/route.ts` | 113,120 | `(b.posts as any)` | Type the join result |
| `app/api/users/[handle]/followers/route.ts` | 83-106 | `(f: any) =>` | Define `FollowerRow` interface |
| `app/api/users/[handle]/following/route.ts` | 83-106 | `(f: any) =>` | Define `FollowingRow` interface |
| `app/api/traders/[handle]/route.ts` | 642 | `posts.map((post: any) =>` | Define `PostRow` interface |
| `lib/services/schedule-manager.ts` | 157 | `(row: any) =>` | Define `ScheduleRow` interface |
| `lib/services/risk-alert.ts` | 346,432 | `(row: any) =>` | Define `AlertRow` interfaces |

### 🔴 Complex — Requires architectural consideration (Phase 3)

| File | Lines | Pattern | Notes |
|------|-------|---------|-------|
| `app/components/exchange/ExchangeConnection.tsx` | 248 | `exchange.id as any` | `ExchangeLogo` prop type needs widening or exchange ID type needs alignment |
| `app/exchange/auth/api-key/page.tsx` | 283,307 | `id as any`, `selectedExchange as any` | Same ExchangeLogo type mismatch |
| `app/exchange/auth/page.tsx` | 122,177 | `selectedExchange.id as any` | Same |
| `app/components/ui/IconSystem.tsx` | 9 | `[key: string]: any` | SVG icon index signature — could use `React.SVGAttributes` |
| `app/components/post/components/PostCard.tsx` | 26 | `t: (key: any) => string` | i18n translation function type |
| `app/components/premium/TraderComparison.tsx` | 263,285 | `(t as any)[metric.key]` | Dynamic property access — needs `Record` type on trader |
| `app/components/base/Box.tsx` | 77 | `{...(props as any)}` | Generic component spread — consider generic type parameter |
| `lib/hooks/useRealtime.ts` | 245 | `'postgres_changes' as any` | Supabase Realtime channel type mismatch |
| `lib/premium/hooks.tsx` | 119 | `subscription.status as any` | Subscription status type mismatch |
| `lib/services/push-notification.ts` | 110-174 | `(this.supabase as any)` | DB types not generated for push tables |
| `lib/services/risk-alert.ts` | 174 | `private supabase: any` | DB types not generated for alert tables |

### ✅ Justified `@ts-expect-error` (keep as-is)

| File | Line | Reason |
|------|------|--------|
| `lib/compliance/consent.ts` | 220,232 | GA disable flag `window['ga-disable-xxx']` — not in Window type |
| `worker/src/scrapers/base.ts` | 220 | Adding `chrome` property to navigator for bot detection bypass |

---

## Recommendations

1. **Phase 1 (Easy):** Define interfaces for admin monitoring, search results, and user API routes. ~7 files, ~15 any removed.
2. **Phase 2 (Medium):** Generate Supabase DB types with `supabase gen types` to eliminate join-typing issues. ~9 files, ~20 any removed.
3. **Phase 3 (Complex):** Align ExchangeLogo prop types, add generics to Box component, fix Realtime channel types. ~11 files, ~18 any remaining.
4. **Tests:** 97 `as any` in tests are standard mock patterns — not a priority. Consider `vitest-mock-extended` for type-safe mocks if desired.
