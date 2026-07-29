const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
const mockTieredDel = jest.fn()
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
  tieredDel: (...args: unknown[]) => mockTieredDel(...args),
}))

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
  sealedRankingPublicationIdentity: (publication: unknown) => JSON.stringify(publication),
}))

import { createSealedRankingCacheEntry } from '@/lib/rankings/sealed-ranking-cache'
import {
  readV3PlatformCounts,
  V3_PLATFORM_COUNT_SOURCES,
} from '@/lib/rankings/read-v3-platform-counts'

const COHORT_ID = '11111111-1111-4111-8111-111111111111'

function publication() {
  return {
    state: 'sealed' as const,
    season: '90D' as const,
    scoreCohortId: COHORT_ID,
    proofs: V3_PLATFORM_COUNT_SOURCES.map((source, index) => ({
      season_id: '90D' as const,
      source,
      source_as_of: '2026-07-29T09:00:00.000000Z',
      recorded_at: '2026-07-29T09:05:00.000000Z',
      score_cohort_id: COHORT_ID,
      rank_mutation_seq: 9,
      current_mutation_seq: 9,
      published_rank_count: index,
      published_identity_sha256: 'a'.repeat(64),
      is_sealed: true as const,
    })),
  }
}

function countMap() {
  return Object.fromEntries(V3_PLATFORM_COUNT_SOURCES.map((source, index) => [source, index]))
}

describe('readV3PlatformCounts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredGet.mockResolvedValue({ data: null, layer: null })
    mockTieredSet.mockResolvedValue(true)
    mockTieredDel.mockResolvedValue(undefined)
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _client: unknown,
        _input: unknown,
        reader: (proof: ReturnType<typeof publication>) => Promise<unknown>
      ) => {
        const proof = publication()
        return {
          value: await reader(proof),
          publication: proof,
          publicationIdentity: JSON.stringify(proof),
        }
      }
    )
  })

  it('derives and caches every platform count from one sealed 90D proof set', async () => {
    const counts = await readV3PlatformCounts({} as never)

    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      {},
      { season: '90D', sources: V3_PLATFORM_COUNT_SOURCES },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(counts[V3_PLATFORM_COUNT_SOURCES[0]]).toBe(0)
    expect(counts[V3_PLATFORM_COUNT_SOURCES.at(-1)!]).toBe(V3_PLATFORM_COUNT_SOURCES.length - 1)
    expect(mockTieredSet).toHaveBeenCalledWith(
      expect.stringMatching(/^public-rank-policy-v4:api-v3-platform-counts-sealed-v2:/),
      expect.objectContaining({ contract: 'sealed-ranking-cache@1' }),
      'cold',
      ['rankings']
    )
  })

  it('accepts only an exact source-scoped sealed cache value', async () => {
    const proof = publication()
    const entry = createSealedRankingCacheEntry({
      value: countMap(),
      publication: proof,
      publicationIdentity: JSON.stringify(proof),
    })
    mockTieredGet.mockResolvedValue({ data: entry, layer: 'redis' })

    const counts = await readV3PlatformCounts({} as never)

    expect(counts).toEqual(countMap())
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
    expect(mockTieredDel).not.toHaveBeenCalled()
    expect(mockTieredSet).not.toHaveBeenCalled()
  })

  it('evicts a generic legacy value before rebuilding the sealed cache', async () => {
    mockTieredGet.mockResolvedValue({
      data: { binance_futures: 999_999 },
      layer: 'redis',
    })

    const counts = await readV3PlatformCounts({} as never)

    expect(mockTieredDel).toHaveBeenCalledWith(
      expect.stringMatching(/^public-rank-policy-v4:api-v3-platform-counts-sealed-v2:/)
    )
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(1)
    expect(counts[V3_PLATFORM_COUNT_SOURCES[0]]).toBe(0)
  })
})
