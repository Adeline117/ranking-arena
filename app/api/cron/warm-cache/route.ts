/**
 * GET /api/cron/warm-cache
 *
 * Lightweight cron that keeps the Supabase connection pool warm
 * and refreshes the SSR homepage Redis cache (home-initial-traders:90D).
 *
 * Runs every 5 minutes (configured in vercel.json) to ensure:
 * 1. Supabase connection pool stays warm (no cold-start latency)
 * 2. Homepage SSR cache stays fresh (TTL=2min, so we refresh every 5min)
 *    Prevents cold-DB-query on page load -> faster LCP
 *
 * Schedule: every 5 minutes (configured in vercel.json)
 */

import { NextRequest } from 'next/server'
import { refreshHomeInitialTradersCache } from '@/lib/getInitialTraders'
import { createLogger } from '@/lib/utils/logger'
import { withCron } from '@/lib/api/with-cron'

const logger = createLogger('warm-cache')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const GET = withCron('warm-cache', async (request: NextRequest) => {
  // Warm the SSR homepage cache — 10s timeout to prevent hang during DB spikes.
  // refreshHomeInitialTradersCache actually WRITES the Redis keys; the old
  // fetchLeaderboardFromDB call dropped its result (cache.set only lived in
  // getInitialTraders), so this cron never warmed the SSR cache at all.
  let tradersCached = 0
  let dbError: string | null = null
  try {
    tradersCached = await Promise.race([
      refreshHomeInitialTradersCache('90D', 50),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('warm-cache DB timeout')), 10000)
      ),
    ])
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
    logger.error(`[warm-cache] DB fetch failed: ${dbError}`)
  }

  // Pre-warm only endpoints that still have a trusted cache to populate.
  // Platform statistics are intentionally quarantined until a sealed
  // aggregate publication exists, so fetching them here must not be counted
  // as a successful cache warm.
  const baseUrl = request.nextUrl.origin
  const warmResults = await Promise.allSettled([
    fetch(`${baseUrl}/api/traders?timeRange=90D&limit=50`, { cache: 'no-store' }),
  ])
  const warmedApis = warmResults.filter((r) => r.status === 'fulfilled' && r.value.ok).length
  const failedApis = warmResults.filter(
    (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)
  ).length
  if (failedApis > 0) {
    logger.warn(`[warm-cache] ${failedApis} API warmup(s) returned non-200 or failed`)
  }

  // A failed warm is a failed run: throwing lets withCron record an error
  // instead of a count:0 "success" (audit P2-6).
  if (dbError || failedApis > 0) {
    throw new Error(
      `warm-cache failed: ${[
        dbError ? `SSR cache refresh: ${dbError}` : null,
        failedApis > 0 ? `${failedApis} API warmup(s) failed` : null,
      ]
        .filter(Boolean)
        .join('; ')}`
    )
  }

  return {
    count: tradersCached,
    traders_cached: tradersCached,
    apis_warmed: warmedApis,
  }
})
