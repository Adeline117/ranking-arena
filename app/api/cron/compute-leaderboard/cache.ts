import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import type { Period } from '@/lib/utils/arena-score'

const logger = createLogger('compute-leaderboard')

const SEASONS: Period[] = ['7D', '30D', '90D']

/**
 * Pre-populate Redis with top 100 leaderboard rows for each season.
 * Runs as fire-and-forget after leaderboard computation so it doesn't
 * block the cron response. TTL = 30 min (matches cron schedule).
 */
export async function warmupLeaderboardCache(
  supabase: ReturnType<typeof getSupabaseAdmin>
): Promise<void> {
  const { tieredSet } = await import('@/lib/cache/redis-layer')

  // Pre-populate the exact cache keys that /api/traders uses
  // Key pattern: leaderboard:{season}:{exchange}:{sort}:{order}:{cursor}:{limit}
  const defaultLimit = 50
  const warmupTargets = SEASONS.map(season => ({
    season,
    key: `leaderboard:${season}:all:arena_score:desc:start:${defaultLimit}`,
  }))

  await Promise.all(
    warmupTargets.map(async ({ season, key }) => {
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, rank, arena_score, roi, pnl, win_rate, max_drawdown, handle, avatar_url, followers, trades_count, sharpe_ratio, trader_type, market_type, season_id')
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
