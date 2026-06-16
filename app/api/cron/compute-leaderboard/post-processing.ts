/**
 * compute-leaderboard post-processing
 *
 * Extracted from route.ts (2026-04-09) to shrink the 2000+ line god function
 * flagged by Retro 2026-04-09 (69 modifications in 2 weeks). Each of these
 * runs as a fire-and-forget background task after the main leaderboard
 * upsert completes — they warm caches, sync Redis, and revalidate ISR.
 *
 * Keeping them in a separate file doesn't change behavior. It just makes
 * the main route file readable and each post-step individually findable.
 *
 * The caller (route.ts) wraps each of these in `fireAndForget()` with a
 * stable label so background failures surface via getFireAndForgetStats()
 * → /api/health/pipeline → OpenClaw Telegram alert.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('compute-leaderboard:post')

type SupabaseAdmin = SupabaseClient

// (removed 2026-06-15) syncSubscoresToV2 — wrote sub-scores back into
// trader_snapshots_v2 (retiring). Uncalled since the route stopped invoking it;
// leaderboard_ranks is the canonical sub-score store.

/** Warm the SSR homepage cache (home-initial-traders:90D). */
export async function warmupSsrHomepageCache(): Promise<void> {
  const { fetchLeaderboardFromDB } = await import('@/lib/getInitialTraders')
  await fetchLeaderboardFromDB('90D', 50)
  logger.info('[warmup] Refreshed home-initial-traders:90D SSR cache')
}

/** Sync Redis sorted sets for near-real-time rankings across all seasons. */
export async function syncRedisSortedSet(
  supabase: SupabaseAdmin,
  seasons: readonly string[]
): Promise<void> {
  const { syncSortedSetFromLeaderboard } = await import('@/lib/realtime/ranking-store')
  for (const season of seasons) {
    await syncSortedSetFromLeaderboard(supabase, season)
  }
}

/** Revalidate top exchange ranking pages so ISR picks up fresh data. */
export async function revalidateRankingPages(): Promise<void> {
  const { revalidatePath } = await import('next/cache')
  const topExchanges = ['binance_futures', 'bybit', 'hyperliquid', 'okx_futures', 'bitget_futures']
  for (const exchange of topExchanges) {
    revalidatePath(`/rankings/${exchange}`)
  }
  revalidatePath('/') // homepage

  // Invalidate Redis cache so API routes serve fresh data immediately
  // (ISR revalidation only refreshes server-rendered pages, not API responses)
  try {
    const { tieredDelByTag } = await import('@/lib/cache/redis-layer')
    await tieredDelByTag('rankings')
    logger.info('[post-processing] Rankings Redis cache invalidated')
  } catch (e) {
    logger.warn('[post-processing] Failed to invalidate rankings cache:', e)
  }
}

/**
 * Pre-populate the exact Redis cache keys that /api/traders uses for the
 * arena_score-desc top-50 query of each season. Without this warmup the first
 * post-leaderboard request pays a cold cache penalty.
 *
 * Key pattern: leaderboard:{season}:{exchange}:{sort}:{order}:{cursor}:{limit}
 */
export async function warmupLeaderboardCache(
  supabase: SupabaseAdmin,
  seasons: readonly string[]
): Promise<void> {
  const { tieredSet } = await import('@/lib/cache/redis-layer')
  const defaultLimit = 50

  await Promise.all(
    seasons.map(async (season) => {
      const key = `leaderboard:${season}:all:arena_score:desc:start:${defaultLimit}`
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select(
          'source, source_trader_id, rank, arena_score, roi, pnl, win_rate, max_drawdown, handle, avatar_url, followers, copiers, trades_count, sharpe_ratio, trader_type, source_type, season_id'
        )
        .eq('season_id', season)
        .not('arena_score', 'is', null)
        .gt('arena_score', 0)
        .order('arena_score', { ascending: false })
        .limit(defaultLimit)

      if (error || !data?.length) return

      await tieredSet(key, data, 'warm', ['rankings', `season:${season}`])
      logger.info(`[warmup] Cached ${data.length} rows → ${key}`)
    })
  )
}
