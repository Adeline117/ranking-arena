/**
 * compute-leaderboard post-processing
 *
 * Extracted from route.ts (2026-04-09) to shrink the 2000+ line god function
 * flagged by Retro 2026-04-09 (69 modifications in 2 weeks). Each of these
 * runs under the leaderboard owner-token lease after the database publication
 * completes — they invalidate old cache state, warm the new state, sync Redis,
 * and revalidate ISR.
 *
 * Keeping them in a separate file doesn't change behavior. It just makes
 * the main route file readable and each post-step individually findable.
 *
 * The caller (route.ts) awaits every task before releasing the lease so one
 * publication's cache writes cannot overlap the next publication.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'
import { advanceSharedCacheWriteFenceAndDeleteTag } from '@/lib/cache'
import { TOP_EXCHANGE_SLUGS } from '@/lib/constants/exchange-slugs'
import {
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
} from '@/lib/rankings/publication-policy'

const logger = createLogger('compute-leaderboard:post')

type SupabaseAdmin = SupabaseClient
interface PublicationLeaseGuard {
  readonly keys: readonly string[]
  readonly ownerToken: string
}

/** Warm the SSR homepage cache (home-initial-traders v3, 90D page 0). */
export async function warmupSsrHomepageCache(): Promise<void> {
  // refreshHomeInitialTradersCache actually WRITES the cache keys. The old
  // code called fetchLeaderboardFromDB and dropped the result — cache.set
  // only lived inside getInitialTraders, so this "warm" never warmed anything
  // (a no-op DB query and a log line that lied).
  const { refreshHomeInitialTradersCache } = await import('@/lib/getInitialTraders')
  const rows = await refreshHomeInitialTradersCache('90D', 50)
  if (rows <= 0) throw new Error('SSR homepage cache warmup returned no eligible rows')
  // Revalidate only after the shared SSR Redis generation is warm. Otherwise
  // a request in the invalidate-before-warm window can rebuild ISR from the
  // previous Redis value and pin an old homepage for another cache interval.
  const { revalidatePath } = await import('next/cache')
  revalidatePath('/')
  logger.info(`[warmup] Refreshed home-initial-traders v3 SSR cache (${rows} rows)`)
}

/** Revalidate every real ranking cache/page surface. */
export async function revalidateRankingPages(lease: PublicationLeaseGuard): Promise<void> {
  const { revalidatePath, revalidateTag } = await import('next/cache')

  // Redis backs API responses; the Next tag backs unstable_cache on exchange
  // and weekly rankings. They are separate cache systems and both are required.
  // Advance first: any old request that finishes after deletion is then unable
  // to restore its pre-publication snapshot into Redis.
  await advanceSharedCacheWriteFenceAndDeleteTag(
    PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
    PUBLIC_RANKING_REDIS_TAG,
    lease
  )
  revalidateTag('rankings', { expire: 0 })
  for (const slug of TOP_EXCHANGE_SLUGS) revalidatePath(`/exchange/${slug}`)
  revalidatePath('/rankings/exchanges')
  revalidatePath('/rankings/weekly')
  logger.info('[post-processing] Ranking Redis, Data Cache, and ranking ISR invalidated')
}

/**
 * Pre-populate the exact versioned, full-response Redis key consumed by the
 * default /api/traders request for each season.
 */
export async function warmupLeaderboardCache(
  supabase: SupabaseAdmin,
  seasons: readonly string[]
): Promise<void> {
  const { warmDefaultPublicTradersCache } = await import('@/app/api/traders/route')
  await Promise.all(
    seasons.map(async (season) => {
      const rows = await warmDefaultPublicTradersCache(supabase as never, season as never, 50)
      logger.info(`[warmup] Cached ${rows} ranked rows for /api/traders ${season}`)
    })
  )
}
