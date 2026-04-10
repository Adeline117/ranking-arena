# compute-leaderboard cron contention — mitigation status

## Problem (backend audit P1-2)
During the ~30-minute window per hour when `compute-leaderboard` cron runs,
DB queries against `leaderboard_ranks` spike from <50ms to **15-30 seconds**.
Specifically:
- `get_diverse_leaderboard` (used by homepage SSR)
- `get_leaderboard_category_counts` (used by homepage SSR for category tabs)

This caused user-visible flashes:
- Homepage: empty `categoryCounts: {all:0, futures:0, ...}` for 5-30 minutes
- Trader pages: hung indefinitely with empty `<main>` Suspense placeholders

## Verified mitigations (shipped 2026-04-09)

### 1. SSR detail timeout race (commit `e189c823a`)
`page.tsx` wraps `cachedGetTraderDetail` in a 4-second `Promise.race`.
On timeout, returns null. The page proceeds with `serverTraderData = null`,
renders the JSON-LD + skeleton fallback. TraderProfileClient refetches
client-side after hydration.

### 2. Stale cache fallback (commit `fa3d4ac60`)
`lib/getInitialTraders.ts` retains the previous Redis cache value as a
fallback. On DB timeout, returns stale cache (5 minutes old by default)
instead of empty zeros. User sees real data — possibly slightly stale.

### 3. ETH address case normalization (commit `9e094253b`)
`resolveTrader` lowercases ETH addresses before query. Was a separate
bug uncovered when the timeout race made the page fast enough that the
resulting 404 became visible.

### 4. Background team's cron staggering
Recent commits from concurrent sessions have added:
- `d23db8cf6 perf(crons): stagger heavy jobs to reduce DB contention`
- `850492ac2 fix(compute-leaderboard): sequential queries + 30s timeout + limit 1000`
- `f4624605c docs(tasks): mark computeSeason split partially complete (1775 → 972, -45%)`
- Phase split into smaller chunks reduces lock window

## What's left (NOT in scope for code fixes)

### Real root cause: write contention on shared rows
`compute-leaderboard` UPSERTs ~12,000 rows per season. While the locks
are held, `get_diverse_leaderboard` waits because it scans the same
rows via `idx_leaderboard_ranks_diverse`.

### Options that would actually fix it (none code-only):
1. **Supabase read replica** — route SSR reads to a replica, isolate
   from cron writes. Requires Supabase Pro tier upgrade.
2. **Table partitioning by season_id** — separate partitions for 7D/30D/90D
   so cron writes to ONE partition while reads target ANOTHER. Schema
   migration; requires backfill.
3. **Move compute to a separate Postgres role with lower priority** —
   Postgres doesn't natively support priority; would need pgBouncer
   shaping or RLS-based throttling. Complex.

## Residual user impact (post-mitigation)
- Homepage during cron windows: shows stale rankings (5min old) instead
  of empty zeros. Functional but slightly behind.
- Trader pages during cron windows: SSR returns ~4s with skeleton, then
  client-side SWR fetches in ~1-2s. User sees a brief skeleton flash
  instead of an indefinite hang.
- Search engine crawlers during cron windows: see SSR HTML with the
  layout JSON-LD, but missing the trader-specific schema (because
  TraderProfileClient hits its loading-state early return). Acceptable
  for SEO since 95%+ of the time the cron isn't running.

## Decision
**Mitigated.** Real fix requires infra (replica) or schema change
(partitioning). Filed as long-term backlog. Code-side mitigations
have reduced user-visible impact from "broken page" to "stale data
flash" — acceptable until infra work happens.
