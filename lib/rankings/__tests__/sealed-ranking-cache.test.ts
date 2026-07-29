import type { SealedLeaderboardPublicationProofSet } from '@/lib/rankings/read-publication-proofs'
import type { SealedRankingGenerationRead } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
  SEALED_RANKING_CACHE_CONTRACT,
} from '@/lib/rankings/sealed-ranking-cache'

const publication: SealedLeaderboardPublicationProofSet = {
  state: 'sealed',
  season: '90D',
  scoreCohortId: '11111111-1111-4111-8111-111111111111',
  proofs: [
    {
      season_id: '90D',
      source: 'binance_futures',
      source_as_of: '2026-07-29T10:00:00.000000Z',
      recorded_at: '2026-07-29T10:01:00.000000Z',
      score_cohort_id: '11111111-1111-4111-8111-111111111111',
      rank_mutation_seq: 9,
      current_mutation_seq: 9,
      published_rank_count: 2,
      published_identity_sha256: 'a'.repeat(64),
      is_sealed: true,
    },
  ],
}

const read: SealedRankingGenerationRead<{ traders: number[] }> = {
  value: { traders: [1, 2] },
  publication,
  publicationIdentity: JSON.stringify(publication),
}

describe('sealed ranking cache', () => {
  test('round-trips only the dedicated double-proof envelope', () => {
    const entry = createSealedRankingCacheEntry(read, new Date('2026-07-29T10:02:00.000Z'))

    expect(entry).toEqual({
      contract: SEALED_RANKING_CACHE_CONTRACT,
      season: '90D',
      publicationIdentity: JSON.stringify(publication),
      publication,
      cachedAt: '2026-07-29T10:02:00.000Z',
      value: { traders: [1, 2] },
    })
    expect(parseSealedRankingCacheEntry(entry, '90D')).toEqual(entry)
  })

  test.each([
    ['legacy generic value', { traders: [1, 2] }],
    [
      'wrong season',
      {
        ...createSealedRankingCacheEntry(read),
        season: '7D',
      },
    ],
    [
      'changed proof after write',
      {
        ...createSealedRankingCacheEntry(read),
        publication: {
          ...publication,
          proofs: [{ ...publication.proofs[0], published_rank_count: 1 }],
        },
      },
    ],
    [
      'extra fields',
      {
        ...createSealedRankingCacheEntry(read),
        legacy: true,
      },
    ],
  ])('rejects %s', (_label, input) => {
    expect(parseSealedRankingCacheEntry(input, '90D')).toBeNull()
  })

  test('rejects an invalid cache timestamp at creation', () => {
    expect(() => createSealedRankingCacheEntry(read, new Date('invalid'))).toThrow()
  })
})
