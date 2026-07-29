import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import {
  PUBLIC_ACTIVE_RANKING_SOURCES,
  parsePublicActiveRankingSource,
} from '@/lib/constants/exchanges'
import {
  filterPublicRankingSources,
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import type { LeaderboardPublicationSeason } from '@/lib/rankings/read-publication-proofs'

export interface RankingExportReadInput {
  exchange?: string
  season: LeaderboardPublicationSeason
  limit: number
}

/** Read one deterministic export slice from an immutable public generation. */
export async function readRankingExportRows(
  supabase: SupabaseClient<Database>,
  input: RankingExportReadInput
): Promise<Record<string, unknown>[]> {
  const exchange = input.exchange ? parsePublicActiveRankingSource(input.exchange) : null
  if (input.exchange && !exchange) {
    throw new TypeError('ranking export exchange is not a canonical public source')
  }
  const sources = exchange ? [exchange] : filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)

  return (
    await readSealedRankingGeneration(
      supabase,
      { season: input.season, sources },
      async (publication) => {
        let query = supabase
          .from('leaderboard_ranks')
          .select(
            'rank, trader_id:source_trader_id, handle, source, arena_score, roi, pnl, win_rate, max_drawdown, followers, trades_count'
          )
          .eq('season_id', input.season)
          .filter('rank_publication_id', 'eq', publication.scoreCohortId)
          .in('source', sources)
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false')

        if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
          query = query.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
        }

        const { data, error } = await query
          .order('rank', { ascending: true })
          .order('source', { ascending: true })
          .order('source_trader_id', { ascending: true })
          .limit(input.limit)

        if (error || data === null) {
          throw new Error(`ranking export query failed: ${error?.message ?? 'null payload'}`)
        }
        return data as Record<string, unknown>[]
      },
      { timeoutMs: 10_000 }
    )
  ).value
}
