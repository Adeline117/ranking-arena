/**
 * compute-leaderboard / rerank-cleanup
 *
 * Two end-of-season housekeeping phases:
 *
 *   • rerankAllRows() — fix rank-drift after the incremental upsert. Calls
 *     rerank_leaderboard(p_season_id) RPC; falls back to inline ORDER BY +
 *     batched UPSERT if the RPC isn't installed (fresh databases).
 *
 *   • cleanupStaleRows() — delete old computed rows only when their SOURCE
 *     currently has a fresh source-data watermark. A wholly stale source keeps
 *     its last-good rows so the public board can serve them with an honest
 *     stale flag.
 *
 * Both are LOW-risk: each runs late, neither blocks the upsert, both are
 * skip-on-deadline. Extracted from route.ts as part of the computeSeason
 * main-loop split (TASKS.md "Open follow-ups").
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import { RANKING_SOURCE_STALE_MS } from '@/lib/rankings/source-freshness'

const logger = createLogger('compute-leaderboard')

const STALE_ROW_AGE_MS = 5 * 24 * 60 * 60 * 1000

/**
 * Re-rank every row for the given season so `rank` matches `arena_score`
 * DESC ordering. Tries the rerank_leaderboard RPC first, falls back to an
 * inline SELECT + batched UPSERT if the RPC is missing (Postgres error
 * code 42883 = "function does not exist"). Non-critical: any failure is
 * logged and swallowed so the cron returns success.
 */
export async function rerankAllRows(supabase: SupabaseClient, season: Period): Promise<void> {
  try {
    const { error: rerankErr } = await supabase.rpc('rerank_leaderboard', { p_season_id: season })
    if (!rerankErr) return

    if (rerankErr.code === '42883') {
      // RPC not available — re-rank inline (slower but correct)
      const { data: allRows } = await supabase
        .from('leaderboard_ranks')
        .select('id, arena_score')
        .eq('season_id', season)
        .order('arena_score', { ascending: false, nullsFirst: false })
      if (allRows?.length) {
        const rerankUpdates = allRows.map((r: { id: string }, idx: number) => ({
          id: r.id,
          rank: idx + 1,
        }))
        // Batch size 100 (down from 500) to reduce lock hold time — large upserts
        // hold row locks that block concurrent SSR SELECT queries on leaderboard_ranks.
        for (let i = 0; i < rerankUpdates.length; i += 100) {
          await supabase
            .from('leaderboard_ranks')
            .upsert(rerankUpdates.slice(i, i + 100), { onConflict: 'id' })
        }
        logger.info(`${season}: re-ranked ${rerankUpdates.length} rows (inline fallback)`)
      }
      return
    }

    logger.warn(`${season}: re-rank failed: ${rerankErr.message}`)
  } catch (e) {
    logger.warn(`${season}: re-rank exception (non-critical):`, e)
  }
}

/**
 * Delete leaderboard_ranks rows whose `computed_at` is older than 5 days only
 * when the same source has a fresh source-data watermark. This removes
 * excluded/zombie rows from active boards without deleting a stale source's
 * last-good board.
 *
 * Limits to 5000 rows per cron cycle so a backlog can't blow the time
 * budget; the next cron picks up where this one left off.
 */
export async function cleanupStaleRows(supabase: SupabaseClient, season: Period): Promise<number> {
  const sourceCutoff = new Date(Date.now() - RANKING_SOURCE_STALE_MS).toISOString()
  const { data: freshSourceRows, error: freshnessError } = await supabase
    .from('leaderboard_source_freshness')
    .select('source')
    .eq('season_id', season)
    .gte('source_as_of', sourceCutoff)

  // Missing/unreadable provenance must never authorize deletion.
  if (freshnessError || !freshSourceRows?.length) return 0
  const freshSources = new Set(
    freshSourceRows.map((row: { source: string }) => row.source).filter(Boolean)
  )

  const cutoff = new Date(Date.now() - STALE_ROW_AGE_MS).toISOString()
  const { data: staleRows, error: staleErr } = await supabase
    .from('leaderboard_ranks')
    .select('id,source')
    .eq('season_id', season)
    .lt('computed_at', cutoff)
    .limit(5000)

  if (staleErr || !staleRows || staleRows.length === 0) return 0

  const staleIds = staleRows
    .filter((row: { source: string }) => freshSources.has(row.source))
    .map((row: { id: string }) => row.id)
  if (staleIds.length === 0) return 0

  for (let i = 0; i < staleIds.length; i += 500) {
    await supabase
      .from('leaderboard_ranks')
      .delete()
      .in('id', staleIds.slice(i, i + 500))
  }
  return staleIds.length
}

/**
 * ROOT CAUSE FIX: Atomic per-platform cleanup.
 *
 * After upsert, for each FRESH platform that was successfully computed,
 * delete all rows for (season, source) that are NOT in the new scored set.
 * This eliminates zombie rows immediately instead of waiting 5 days.
 *
 * Stale/query-failed platforms are untouched — their old data is preserved
 * until they return to fresh state.
 */
export async function atomicPlatformCleanup(
  supabase: SupabaseClient,
  season: Period,
  freshPlatforms: string[],
  scoredTradersByPlatform: Map<string, string[]>
): Promise<number> {
  let totalDeleted = 0

  for (const platform of freshPlatforms) {
    const traderIds = scoredTradersByPlatform.get(platform)
    if (!traderIds || traderIds.length === 0) continue

    try {
      const { data, error } = await supabase.rpc('cleanup_stale_platform_rows', {
        p_season_id: season,
        p_source: platform,
        p_keep_trader_ids: traderIds,
      })

      if (error) {
        // RPC not available yet — fall back to manual delete
        if (error.code === '42883') {
          const { data: existing } = await supabase
            .from('leaderboard_ranks')
            .select('id, source_trader_id')
            .eq('season_id', season)
            .eq('source', platform)

          if (existing) {
            const keepSet = new Set(traderIds)
            const toDelete = existing
              .filter((r: { source_trader_id: string }) => !keepSet.has(r.source_trader_id))
              .map((r: { id: string }) => r.id)

            for (let i = 0; i < toDelete.length; i += 500) {
              await supabase
                .from('leaderboard_ranks')
                .delete()
                .in('id', toDelete.slice(i, i + 500))
            }
            totalDeleted += toDelete.length
          }
        } else {
          logger.warn(`${season}: cleanup RPC failed for ${platform}: ${error.message}`)
        }
      } else {
        const deleted = typeof data === 'number' ? data : 0
        if (deleted > 0) {
          logger.info(`${season}: cleaned ${deleted} zombie rows from ${platform}`)
        }
        totalDeleted += deleted
      }
    } catch (e) {
      logger.warn(
        `${season}: atomicPlatformCleanup failed for ${platform}: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  return totalDeleted
}
