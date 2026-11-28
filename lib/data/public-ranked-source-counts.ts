/**
 * Per-source trader counts on the public ranked leaderboard, counted by the
 * database.
 *
 * PostgREST returns at most 1,000 rows per request, and the public board has
 * several thousand, so reading rows back and counting them in the application
 * silently counts only the first page (issue #563). Each number here is an
 * exact `count` over the public view instead; no row is read.
 *
 * Idle-window rows (no PnL in the period) are not counted, as in
 * get_hero_stats.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

const PUBLIC_RANKED_LEADERBOARD = 'public_ranked_leaderboard'
/** Count requests in flight at once; a season serves a few dozen sources. */
const SOURCE_COUNT_CONCURRENCY = 8

export interface PublicRankedSourceCounts {
  /** Non-idle ranked traders in the season. */
  total: number
  /** Non-idle ranked traders per source; sources with none are absent. */
  bySource: Map<string, number>
}

function exactCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Returns null when any read fails or the per-source counts do not add up to
 * the season total (a source outside the served list, or a publication switch
 * between reads). A caller must treat null as "unknown", never as zero.
 */
export async function countPublicRankedTradersBySource(
  supabase: SupabaseClient<Database>,
  seasonId: '7D' | '30D' | '90D'
): Promise<PublicRankedSourceCounts | null> {
  const nonIdleCount = (source?: string) => {
    const query = supabase
      .from(PUBLIC_RANKED_LEADERBOARD)
      .select('source_trader_id', { count: 'exact', head: true })
      .eq('season_id', seasonId)
      .not('rank', 'is', null)
      .eq('idle_window', false)
    return source === undefined ? query : query.eq('source', source)
  }

  const [served, totalResult] = await Promise.all([
    supabase.rpc('arena_visible_sources', { p_season_id: seasonId }),
    nonIdleCount(),
  ])
  if (served.error || !Array.isArray(served.data) || totalResult.error) return null
  const total = exactCount(totalResult.count)
  if (total === null) return null

  const sources = Array.from(
    new Set(
      served.data
        .map((row) => row.filter_source)
        .filter((source): source is string => typeof source === 'string' && source.length > 0)
    )
  )

  const bySource = new Map<string, number>()
  let counted = 0
  for (let start = 0; start < sources.length; start += SOURCE_COUNT_CONCURRENCY) {
    const batch = sources.slice(start, start + SOURCE_COUNT_CONCURRENCY)
    const results = await Promise.all(batch.map((source) => nonIdleCount(source)))
    for (const [index, result] of results.entries()) {
      const count = result.error ? null : exactCount(result.count)
      if (count === null) return null
      counted += count
      if (count > 0) bySource.set(batch[index], count)
    }
  }

  return counted === total ? { total, bySource } : null
}
