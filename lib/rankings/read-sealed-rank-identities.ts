import type { getSupabaseAdmin } from '@/lib/api'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import {
  readSealedRankingAuthorityGeneration,
  type SealedRankingGenerationRead,
} from '@/lib/rankings/read-sealed-ranking-generation'
import type { LeaderboardPublicationSeason } from '@/lib/rankings/read-publication-proofs'

type RankIdentityClient = Pick<ReturnType<typeof getSupabaseAdmin>, 'from' | 'rpc'>

export interface RankingIdentity {
  readonly source: string
  readonly sourceTraderId: string
}

export interface SealedRankIdentityRow {
  readonly source: string
  readonly source_trader_id: string
  readonly handle: string | null
  readonly avatar_url: string | null
  readonly roi: number | null
  readonly pnl: number | null
  readonly win_rate: number | null
  readonly followers: number | null
  readonly arena_score: number | null
  readonly rank: number | null
}

const IDENTITY_CHUNK_SIZE = 100
const QUERY_CONCURRENCY = 3
const QUERY_TIMEOUT_MS = 15_000

function identityKey(source: string, sourceTraderId: string): string {
  return `${source}\u0000${sourceTraderId}`
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  worker: (input: Input) => Promise<Output>
): Promise<Output[]> {
  const outputs = new Array<Output>(inputs.length)
  let nextIndex = 0
  let failed = false
  let failure: unknown

  const consume = async () => {
    while (!failed) {
      const index = nextIndex
      if (index >= inputs.length) return
      nextIndex += 1

      try {
        outputs[index] = await worker(inputs[index])
      } catch (error) {
        failed = true
        failure = error
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => consume()))
  if (failed) throw failure
  return outputs
}

/**
 * Read rank materialization for exact composite identities from one stable
 * public leaderboard generation.
 *
 * Private edge tables may retain retired, quarantined, or malformed sources.
 * Those identities remain owned by the caller but receive no public rank
 * enrichment. They must never widen this service-role query.
 */
export async function readSealedRankIdentities(
  supabase: RankIdentityClient,
  season: LeaderboardPublicationSeason,
  identities: readonly RankingIdentity[]
): Promise<SealedRankingGenerationRead<SealedRankIdentityRow[]> | null> {
  const idsBySource = new Map<string, Set<string>>()
  for (const identity of identities) {
    if (
      !isPublicRankingSourceAllowed(identity.source) ||
      typeof identity.sourceTraderId !== 'string' ||
      identity.sourceTraderId.length === 0
    ) {
      continue
    }
    const sourceIds = idsBySource.get(identity.source) ?? new Set<string>()
    sourceIds.add(identity.sourceTraderId)
    idsBySource.set(identity.source, sourceIds)
  }

  if (idsBySource.size === 0) return null

  return readSealedRankingAuthorityGeneration(
    supabase,
    season,
    async (publication) => {
      const authoritySources = new Set(publication.proofs.map((proof) => proof.source))
      const sources = [...idsBySource.keys()]
        .filter((source) => authoritySources.has(source))
        .sort()
      const jobs: Array<{ source: string; ids: string[] }> = []
      for (const source of sources) {
        const ids = [...(idsBySource.get(source) ?? [])].sort()
        for (let index = 0; index < ids.length; index += IDENTITY_CHUNK_SIZE) {
          jobs.push({ source, ids: ids.slice(index, index + IDENTITY_CHUNK_SIZE) })
        }
      }

      const batches = await mapWithConcurrency(jobs, QUERY_CONCURRENCY, async ({ source, ids }) => {
        const result = await supabase
          .from('leaderboard_ranks')
          .select(
            'source, source_trader_id, handle, avatar_url, roi, pnl, win_rate, followers, arena_score, rank'
          )
          .eq('source', source)
          .in('source_trader_id', ids)
          .eq('season_id', season)
          .filter('rank_publication_id', 'eq', publication.scoreCohortId)
          .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))

        if (result.error) {
          throw new Error(`sealed rank identity query failed: ${result.error.message}`)
        }
        if (!Array.isArray(result.data)) {
          throw new Error('sealed rank identity query returned no row array')
        }
        return result.data as SealedRankIdentityRow[]
      })

      const requested = new Set(
        [...idsBySource.entries()].flatMap(([source, ids]) =>
          [...ids].map((sourceTraderId) => identityKey(source, sourceTraderId))
        )
      )
      const seen = new Set<string>()
      const rows: SealedRankIdentityRow[] = []
      for (const row of batches.flat()) {
        const key = identityKey(row.source, row.source_trader_id)
        if (!requested.has(key)) {
          throw new Error('sealed rank identity query returned an unrequested identity')
        }
        if (seen.has(key)) {
          throw new Error('sealed rank identity query returned a duplicate identity')
        }
        seen.add(key)
        rows.push(row)
      }

      return rows
    },
    { timeoutMs: 10_000 }
  )
}
