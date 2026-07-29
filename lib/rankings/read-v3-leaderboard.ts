import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { getLeaderboard } from '@/lib/data/unified'
import {
  PUBLIC_ACTIVE_RANKING_SOURCES,
  parsePublicActiveRankingSource,
} from '@/lib/constants/exchanges'
import {
  filterPublicRankingSources,
  PUBLIC_RANKING_QUARANTINED_SOURCES,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import type { LeaderboardPublicationSeason } from '@/lib/rankings/read-publication-proofs'

export interface V3LeaderboardReadInput {
  platform?: string
  period: LeaderboardPublicationSeason
  limit: number
  offset: number
}

/**
 * Authorize the developer-facing leaderboard against one immutable publication.
 * The helper deliberately ignores getLeaderboard's legacy count authority:
 * total always comes from the same proof set as the returned rows.
 */
export async function readV3Leaderboard(
  supabase: SupabaseClient<Database>,
  input: V3LeaderboardReadInput
) {
  const platform = input.platform ? parsePublicActiveRankingSource(input.platform) : null
  if (input.platform && !platform) {
    throw new TypeError('v3 leaderboard platform is not a canonical public source')
  }

  const sources = platform ? [platform] : filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)

  return (
    await readSealedRankingGeneration(
      supabase,
      { season: input.period, sources },
      async (publication) => {
        const result = await getLeaderboard(supabase, {
          platform: platform || undefined,
          period: input.period,
          limit: input.limit,
          offset: input.offset,
          scoreCohortId: publication.scoreCohortId,
          allowedSources: sources,
          excludeSources: PUBLIC_RANKING_QUARANTINED_SOURCES,
        })
        if (result.error) {
          throw new Error(`v3 sealed leaderboard query failed: ${result.error}`)
        }

        return {
          traders: result.traders,
          total: publication.proofs.reduce((sum, proof) => sum + proof.published_rank_count, 0),
        }
      },
      { timeoutMs: 10_000 }
    )
  ).value
}
