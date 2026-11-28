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
 * Returns null when any read fails, when the per-source counts do not add up
 * to the season total (a source outside the served list), or when the served
 * sources' publication records changed while counting. A caller must treat
 * null as "unknown", never as zero.
 */
export async function countPublicRankedTradersBySource(
  supabase: SupabaseClient<Database>,
  seasonId: '7D' | '30D' | '90D'
): Promise<PublicRankedSourceCounts | null> {
  /** Served source -> its publication record (published rows, recorded time). */
  const readServedPublication = async (): Promise<Map<string, string> | null> => {
    const { data, error } = await supabase.rpc('arena_visible_sources', { p_season_id: seasonId })
    if (error || !Array.isArray(data)) return null
    const publication = new Map<string, string>()
    for (const row of data) {
      if (typeof row.filter_source !== 'string' || row.filter_source.length === 0) continue
      publication.set(row.filter_source, `${row.trader_count}@${row.cache_updated_at}`)
    }
    return publication
  }

  const nonIdleCount = (source?: string) => {
    const query = supabase
      .from(PUBLIC_RANKED_LEADERBOARD)
      .select('source_trader_id', { count: 'exact', head: true })
      .eq('season_id', seasonId)
      .not('rank', 'is', null)
      .eq('idle_window', false)
    return source === undefined ? query : query.eq('source', source)
  }

  // Read first, on its own: every count below must fall between this read and
  // the one at the end.
  const before = await readServedPublication()
  if (before === null) return null
  const totalResult = await nonIdleCount()
  if (totalResult.error) return null
  const total = exactCount(totalResult.count)
  if (total === null) return null

  const sources = Array.from(before.keys())

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

  if (counted !== total) return null

  // The counts above are separate requests. A publication switch between them
  // can leave a sum that still matches, so the served sources' publication
  // records must be the same after the last count as before the first.
  const after = await readServedPublication()
  if (after === null || after.size !== before.size) return null
  for (const [source, record] of before) {
    if (after.get(source) !== record) return null
  }

  return { total, bySource }
}
