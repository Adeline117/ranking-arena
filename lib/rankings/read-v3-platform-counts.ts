import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import {
  filterPublicRankingSources,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'
import { tieredDel, tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

const V3_PLATFORM_COUNT_SEASON = '90D' as const
export const V3_PLATFORM_COUNT_SOURCES = Object.freeze(
  filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)
)
const V3_PLATFORM_COUNT_CACHE_KEY = publicRankingCacheKey('api-v3-platform-counts-sealed-v2:90D')

function parseCountMap(value: unknown): Readonly<Record<string, number>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const actualKeys = Object.keys(record).sort()
  const expectedKeys = [...V3_PLATFORM_COUNT_SOURCES].sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null
  }

  const counts: Record<string, number> = {}
  for (const source of V3_PLATFORM_COUNT_SOURCES) {
    const count = record[source]
    if (!Number.isSafeInteger(count) || (count as number) < 0) return null
    counts[source] = count as number
  }
  return Object.freeze(counts)
}

/** Return exact per-source counts from one sealed 90D generation. */
export async function readV3PlatformCounts(
  supabase: SupabaseClient<Database>
): Promise<Readonly<Record<string, number>>> {
  const cached = await tieredGet<unknown>(V3_PLATFORM_COUNT_CACHE_KEY, 'cold')
  const cachedEntry = parseSealedRankingCacheEntry<unknown>(
    cached.data,
    V3_PLATFORM_COUNT_SEASON,
    V3_PLATFORM_COUNT_SOURCES
  )
  const cachedCounts = cachedEntry ? parseCountMap(cachedEntry.value) : null
  if (cachedCounts) return cachedCounts
  if (cached.data !== null) await tieredDel(V3_PLATFORM_COUNT_CACHE_KEY)

  const sealedRead = await readSealedRankingGeneration(
    supabase,
    { season: V3_PLATFORM_COUNT_SEASON, sources: V3_PLATFORM_COUNT_SOURCES },
    async (publication) =>
      Object.fromEntries(
        publication.proofs.map((proof) => [proof.source, proof.published_rank_count])
      ),
    { timeoutMs: 10_000 }
  )
  const counts = parseCountMap(sealedRead.value)
  if (!counts) {
    throw new Error('v3 platform proof set produced an invalid count map')
  }
  await tieredSet(
    V3_PLATFORM_COUNT_CACHE_KEY,
    createSealedRankingCacheEntry({ ...sealedRead, value: counts }),
    'cold',
    ['rankings']
  )
  return counts
}
