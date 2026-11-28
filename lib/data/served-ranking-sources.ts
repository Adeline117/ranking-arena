/**
 * The sources the public ranked leaderboard is serving right now, with the
 * number of rows published for each and when that publication was recorded.
 *
 * Operator surfaces used to read public.leaderboard_count_cache for this. That
 * cache counts the raw rank table, is not refreshed by the sealing publisher,
 * and keeps listing a source the public view has stopped serving (issue #554),
 * so a dropped source still looked healthy. arena_visible_sources() reads the
 * same served-source function as the public view.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

export interface ServedRankingSource {
  /** Public source name, as in public_ranked_leaderboard.source. */
  source: string
  /** Rows published for the source, idle-window rows included. */
  publishedCount: number
  /** When the serving publication recorded this source. */
  recordedAt: string
}

/** Throws on a database error: a caller must not read a failure as "no sources". */
export async function readServedRankingSources(
  supabase: SupabaseClient<Database>,
  seasonId: '7D' | '30D' | '90D' = '90D'
): Promise<ServedRankingSource[]> {
  const { data, error } = await supabase.rpc('arena_visible_sources', { p_season_id: seasonId })
  if (error) throw new Error(`arena_visible_sources failed: ${error.message}`)
  if (!Array.isArray(data)) throw new Error('arena_visible_sources returned no list')

  // Several registry rows can share one public source name; they carry the
  // same publication record, so keep one entry per name.
  const bySource = new Map<string, ServedRankingSource>()
  for (const row of data) {
    if (typeof row.filter_source !== 'string' || row.filter_source.length === 0) continue
    bySource.set(row.filter_source, {
      source: row.filter_source,
      publishedCount: row.trader_count,
      recordedAt: row.cache_updated_at,
    })
  }
  return Array.from(bySource.values())
}
