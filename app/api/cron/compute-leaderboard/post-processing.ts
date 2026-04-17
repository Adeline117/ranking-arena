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

/**
 * Sync sub-scores + advanced metrics: leaderboard_ranks → trader_snapshots_v2.
 *
 * Fills orphan v2 columns (return_score / drawdown_score / stability_score = 0,
 * sortino_ratio / calmar_ratio historically sparse). Processes up to 1000 most
 * recent v2 rows missing return_score per invocation.
 */
export async function syncSubscoresToV2(supabase: SupabaseAdmin): Promise<void> {
  try {
    const { data: lrRows } = await supabase
      .from('leaderboard_ranks')
      .select(
        'source, source_trader_id, season_id, profitability_score, risk_control_score, execution_score, sortino_ratio, calmar_ratio',
      )
      .not('profitability_score', 'is', null)
      .limit(1000)
    if (!lrRows?.length) return

    const scoreMap = new Map<string, (typeof lrRows)[0]>()
    for (const r of lrRows) scoreMap.set(`${r.source}:${r.source_trader_id}:${r.season_id}`, r)

    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const { data: v2Rows } = await supabase
      .from('trader_snapshots_v2')
      .select('id, platform, trader_key, window')
      .is('return_score', null)
      .not('arena_score', 'is', null)
      .gte('created_at', cutoff)
      .limit(1000)
    if (!v2Rows?.length) return

    const updates: Array<Record<string, unknown>> = []
    for (const row of v2Rows) {
      const lr = scoreMap.get(`${row.platform}:${row.trader_key}:${row.window}`)
      if (lr?.profitability_score != null) {
        updates.push({
          id: row.id,
          return_score: Number(lr.profitability_score),
          drawdown_score: lr.risk_control_score != null ? Number(lr.risk_control_score) : null,
          stability_score: lr.execution_score != null ? Number(lr.execution_score) : null,
          sortino_ratio: lr.sortino_ratio != null ? Number(lr.sortino_ratio) : null,
          calmar_ratio: lr.calmar_ratio != null ? Number(lr.calmar_ratio) : null,
        })
      }
    }

    let synced = 0
    for (let i = 0; i < updates.length; i += 100) {
      const chunk = updates.slice(i, i + 100)
      const { error } = await supabase.from('trader_snapshots_v2').upsert(chunk, { onConflict: 'id' })
      if (!error) synced += chunk.length
    }
    if (synced > 0) logger.info(`Synced sub-scores to v2: ${synced}/${v2Rows.length} rows`)
  } catch (e) {
    logger.warn('Sub-score sync to v2 failed (non-critical):', e)
  }
}

/** Warm the SSR homepage cache (home-initial-traders:90D). */
export async function warmupSsrHomepageCache(): Promise<void> {
  const { fetchLeaderboardFromDB } = await import('@/lib/getInitialTraders')
  await fetchLeaderboardFromDB('90D', 50)
  logger.info('[warmup] Refreshed home-initial-traders:90D SSR cache')
}

/** Sync Redis sorted sets for near-real-time rankings across all seasons. */
export async function syncRedisSortedSet(
  supabase: SupabaseAdmin,
  seasons: readonly string[],
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
  seasons: readonly string[],
): Promise<void> {
  const { tieredSet } = await import('@/lib/cache/redis-layer')
  const defaultLimit = 50

  await Promise.all(
    seasons.map(async (season) => {
      const key = `leaderboard:${season}:all:arena_score:desc:start:${defaultLimit}`
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select(
          'source, source_trader_id, rank, arena_score, roi, pnl, win_rate, max_drawdown, handle, avatar_url, followers, copiers, trades_count, sharpe_ratio, trader_type, source_type, season_id',
        )
        .eq('season_id', season)
        .not('arena_score', 'is', null)
        .gt('arena_score', 0)
        .order('arena_score', { ascending: false })
        .limit(defaultLimit)

      if (error || !data?.length) return

      await tieredSet(key, data, 'warm', ['rankings', `season:${season}`])
      logger.info(`[warmup] Cached ${data.length} rows → ${key}`)
    }),
  )
}
