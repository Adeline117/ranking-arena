import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { parsePublicActiveRankingSource } from '@/lib/constants/exchanges'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

export interface OgExchangeTopTrader {
  readonly handle: string | null
  readonly avatar_url: string | null
  readonly roi: number | null
  readonly arena_score: number | null
  readonly rank: number
}

export interface OgExchangeRanking {
  readonly traders: OgExchangeTopTrader[]
  readonly total: number
}

/** Read one exchange card from one immutable 90D public generation. */
export async function readOgExchangeRanking(
  supabase: SupabaseClient<Database>,
  requestedSource: string
): Promise<OgExchangeRanking> {
  const source = parsePublicActiveRankingSource(requestedSource)
  if (!source || !isPublicRankingSourceAllowed(source)) {
    throw new TypeError('OG exchange source is not a canonical public ranking source')
  }

  return (
    await readSealedRankingGeneration(
      supabase,
      { season: '90D', sources: [source] },
      async (publication) => {
        const { data, error } = await supabase
          .from('leaderboard_ranks')
          .select('source, handle, avatar_url, roi, arena_score')
          .eq('source', source)
          .eq('season_id', '90D')
          .filter('rank_publication_id', 'eq', publication.scoreCohortId)
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .order('arena_score', { ascending: false, nullsFirst: false })
          .limit(3)

        if (error || data === null) {
          throw new Error(`OG exchange ranking query failed: ${error?.message ?? 'null payload'}`)
        }
        if (data.some((row) => row.source !== source)) {
          throw new Error('OG exchange ranking query returned a source outside its authority')
        }

        const proof = publication.proofs.find((candidate) => candidate.source === source)
        if (!proof || proof.published_rank_count < data.length) {
          throw new Error('OG exchange publication proof does not authorize the returned rows')
        }

        return {
          traders: data.map((row, index) => ({
            handle: row.handle,
            avatar_url: row.avatar_url,
            roi: row.roi,
            arena_score: row.arena_score,
            rank: index + 1,
          })),
          total: proof.published_rank_count,
        }
      },
      { timeoutMs: 10_000 }
    )
  ).value
}
