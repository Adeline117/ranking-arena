/**
 * compute-leaderboard / rerank-cleanup
 *
 * Two end-of-season housekeeping phases:
 *
 *   • rerankAllRows() — fix rank-drift after the incremental upsert. Calls
 *     the transaction-scoped rerank_public_eligible_leaderboard RPC and fails
 *     closed when that required finalizer is unavailable.
 *
 *   • cleanupStaleRows() — delete old computed rows only when their SOURCE
 *     currently has a fresh source-data watermark. A wholly stale source keeps
 *     its last-good rows so the public board can serve them with an honest
 *     stale flag.
 *
 * Re-ranking and per-platform cleanup finalize the current publication cohort:
 * their failures must propagate. Legacy stale-row cleanup is deliberately
 * different post-publication maintenance and remains best-effort.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import { RANKING_SOURCE_STALE_MS } from '@/lib/rankings/source-freshness'

const logger = createLogger('compute-leaderboard')

const STALE_ROW_AGE_MS = 5 * 24 * 60 * 60 * 1000

async function runDatabaseOperation<T>(
  context: string,
  operation: () => PromiseLike<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Atomically assign ranks to the database-defined public-eligible cohort and
 * clear rank from every ineligible row. The required RPC owns one snapshot,
 * one authority lookup, and one set-based UPDATE. A client-side fallback
 * cannot reproduce that transaction boundary and therefore must not publish.
 */
export async function rerankAllRows(supabase: SupabaseClient, season: Period): Promise<void> {
  const { data: rerankedRows, error: rerankErr } = await runDatabaseOperation(
    `[${season}] rerank RPC threw`,
    () => supabase.rpc('rerank_public_eligible_leaderboard', { p_season_id: season })
  )
  if (rerankErr) {
    throw new Error(
      `[${season}] required eligibility-aware rerank RPC failed (${rerankErr.code ?? 'unknown'}): ${
        rerankErr.message
      }`
    )
  }
  if (!Number.isSafeInteger(rerankedRows) || rerankedRows < 0) {
    throw new Error(`[${season}] eligibility-aware rerank RPC returned an invalid result`)
  }
}

/**
 * Delete leaderboard_ranks rows whose `computed_at` is older than 5 days only
 * when the same source has a fresh source-data watermark. This removes
 * excluded/zombie rows from active boards without deleting a stale source's
 * last-good board.
 *
 * Limits to 5000 rows per cron cycle so a backlog can't blow the time
 * budget; the next cron picks up where this one left off. This helper is
 * best-effort maintenance only: callers must never treat its result as proof
 * that the current publication cohort was finalized.
 */
export async function cleanupStaleRows(supabase: SupabaseClient, season: Period): Promise<number> {
  try {
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

    let deleted = 0
    for (let i = 0; i < staleIds.length; i += 500) {
      const batch = staleIds.slice(i, i + 500)
      const { error } = await supabase.from('leaderboard_ranks').delete().in('id', batch)
      if (error) {
        logger.warn(`[${season}] best-effort stale-row delete failed: ${error.message}`)
        return deleted
      }
      deleted += batch.length
    }
    return deleted
  } catch (error) {
    logger.warn(
      `[${season}] best-effort stale-row cleanup threw: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return 0
  }
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
    if (traderIds === undefined) {
      throw new Error(
        `[${season}] atomic cleanup missing publication cohort for fresh platform ${platform}`
      )
    }
    // An explicit empty keep-set is authoritative: the source was evaluated
    // and published zero eligible rows, so cleanup must remove its old rows.
    // A missing map key is the ambiguous/error case handled above.

    const { data, error } = await runDatabaseOperation(
      `[${season}] atomic cleanup RPC threw for ${platform}`,
      () =>
        supabase.rpc('cleanup_stale_platform_rows', {
          p_season_id: season,
          p_source: platform,
          p_keep_trader_ids: traderIds,
        })
    )

    if (!error) {
      if (typeof data !== 'number' || !Number.isSafeInteger(data) || data < 0) {
        throw new Error(`[${season}] atomic cleanup RPC returned an invalid count for ${platform}`)
      }
      if (data > 0) logger.info(`${season}: cleaned ${data} zombie rows from ${platform}`)
      totalDeleted += data
      continue
    }

    throw new Error(`[${season}] atomic cleanup RPC failed for ${platform}: ${error.message}`)
  }

  return totalDeleted
}
