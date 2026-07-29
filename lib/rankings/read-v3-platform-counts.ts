import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { publicRankingCacheKey } from '@/lib/rankings/publication-policy'
import { tieredDel, tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

const V3_PLATFORM_COUNT_SEASON = '90D' as const
const V3_PLATFORM_COUNT_CACHE_KEY = publicRankingCacheKey('api-v3-platform-counts-sealed-v3:90D')

function parseCountMap(
  value: unknown,
  expectedSources: readonly string[]
): Readonly<Record<string, number>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const actualKeys = Object.keys(record).sort()
  const expectedKeys = [...expectedSources].sort()
  if (
    expectedKeys.length === 0 ||
    new Set(expectedKeys).size !== expectedKeys.length ||
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null
  }

  const counts: Record<string, number> = {}
  for (const source of expectedKeys) {
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
  const cachedEntry = parseSealedRankingCacheEntry<unknown>(cached.data, V3_PLATFORM_COUNT_SEASON)
  const cachedCounts = cachedEntry
    ? parseCountMap(
        cachedEntry.value,
        cachedEntry.publication.proofs.map((proof) => proof.source)
      )
    : null
  if (cachedCounts) return cachedCounts
  if (cached.data !== null) await tieredDel(V3_PLATFORM_COUNT_CACHE_KEY)

  const sealedRead = await readSealedRankingAuthorityGeneration(
    supabase,
    V3_PLATFORM_COUNT_SEASON,
    async (publication) =>
      Object.fromEntries(
        publication.proofs.map((proof) => [proof.source, proof.published_rank_count])
      ),
    { timeoutMs: 10_000 }
  )
  const counts = parseCountMap(
    sealedRead.value,
    sealedRead.publication.proofs.map((proof) => proof.source)
  )
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
