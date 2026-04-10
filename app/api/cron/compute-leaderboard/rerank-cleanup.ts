/**
 * compute-leaderboard / rerank-cleanup
 *
 * Two end-of-season housekeeping phases:
 *
 *   • rerankAllRows() — fix rank-drift after the incremental upsert. Calls
 *     rerank_leaderboard(p_season_id) RPC; falls back to inline ORDER BY +
 *     batched UPSERT if the RPC isn't installed (fresh databases).
 *
 *   • cleanupStaleRows() — delete leaderboard_ranks rows whose computed_at
 *     is older than 5 days. Excluded traders never get a re-compute, so
 *     without this cleanup their stale high-scores persist at the top of
 *     the rankings forever (root cause of the multi-day "stuck #1" bugs).
 *
 * Both are LOW-risk: each runs late, neither blocks the upsert, both are
 * skip-on-deadline. Extracted from route.ts as part of the computeSeason
 * main-loop split (TASKS.md "Open follow-ups").
 */

import { getSupabaseAdmin } from '@/lib/api'
import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('compute-leaderboard')

const STALE_ROW_AGE_MS = 5 * 24 * 60 * 60 * 1000

/**
 * Re-rank every row for the given season so `rank` matches `arena_score`
 * DESC ordering. Tries the rerank_leaderboard RPC first, falls back to an
 * inline SELECT + batched UPSERT if the RPC is missing (Postgres error
 * code 42883 = "function does not exist"). Non-critical: any failure is
 * logged and swallowed so the cron returns success.
 */
export async function rerankAllRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
): Promise<void> {
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
        const rerankUpdates = allRows.map((r: { id: string }, idx: number) => ({ id: r.id, rank: idx + 1 }))
        for (let i = 0; i < rerankUpdates.length; i += 500) {
          await supabase.from('leaderboard_ranks').upsert(rerankUpdates.slice(i, i + 500), { onConflict: 'id' })
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
 * Delete leaderboard_ranks rows whose `computed_at` is older than 5 days.
 * Excluded traders (negative ROI, <5 trades, etc.) never get re-computed
 * so their stale high-scores would persist at the top of rankings forever
 * without this cleanup. Returns the deleted count for logging.
 *
 * Limits to 5000 rows per cron cycle so a backlog can't blow the time
 * budget; the next cron picks up where this one left off.
 */
export async function cleanupStaleRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_ROW_AGE_MS).toISOString()
  const { data: staleRows, error: staleErr } = await supabase
    .from('leaderboard_ranks')
    .select('id')
    .eq('season_id', season)
    .lt('computed_at', cutoff)
    .limit(5000)

  if (staleErr || !staleRows || staleRows.length === 0) return 0

  const staleIds = staleRows.map((r: { id: string }) => r.id)
  for (let i = 0; i < staleIds.length; i += 500) {
    await supabase.from('leaderboard_ranks').delete().in('id', staleIds.slice(i, i + 500))
  }
  return staleIds.length
}
