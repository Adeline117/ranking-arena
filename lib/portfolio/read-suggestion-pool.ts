import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { getLeaderboard } from '@/lib/data/unified'
import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

/**
 * Read the candidate pool from one immutable public 90D generation.
 *
 * Portfolio suggestions are actionable ranking output. They must not combine
 * a Redis live view, quarantined sources, or rows from different publications.
 */
export async function readSealedPortfolioSuggestionPool(supabase: SupabaseClient<Database>) {
  return (
    await readSealedRankingAuthorityGeneration(
      supabase,
      '90D',
      async (publication) => {
        const authoritySources = publication.proofs.map((proof) => proof.source)
        const result = await getLeaderboard(supabase, {
          period: '90D',
          limit: 200,
          sortBy: 'roi',
          excludeOutliers: true,
          scoreCohortId: publication.scoreCohortId,
          allowedSources: authoritySources,
          excludeSources: PUBLIC_RANKING_QUARANTINED_SOURCES,
        })
        if (result.error) {
          throw new Error(`sealed portfolio candidate query failed: ${result.error}`)
        }
        return result.traders
      },
      { timeoutMs: 15_000 }
    )
  ).value
}
