import type {
  LeaderboardPublicationSeason,
  SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'
import {
  createSealedCompositeCacheEntry,
  parseSealedCompositeCacheEntry,
  SEALED_COMPOSITE_CACHE_CONTRACT,
  sealedCompositePublicationIdentity,
  type SealedCompositePublications,
} from '@/lib/rankings/sealed-composite-cache'

function publication(
  season: LeaderboardPublicationSeason,
  source = 'binance_futures'
): SealedLeaderboardPublicationProofSet {
  const cohortPrefix = season === '7D' ? '1' : season === '30D' ? '2' : '3'
  const cohort = `${cohortPrefix.repeat(8)}-${cohortPrefix.repeat(4)}-4${cohortPrefix.repeat(
    3
  )}-8${cohortPrefix.repeat(3)}-${cohortPrefix.repeat(12)}`
  return {
    state: 'sealed',
    season,
    scoreCohortId: cohort,
    proofs: [
      {
        season_id: season,
        source,
        source_as_of: '2026-07-29T10:00:00.000000Z',
        recorded_at: '2026-07-29T10:01:00.000000Z',
        score_cohort_id: cohort,
        rank_mutation_seq: 9,
        current_mutation_seq: 9,
        published_rank_count: 2,
        published_identity_sha256: cohortPrefix.repeat(64),
        is_sealed: true,
      },
    ],
  }
}

function publications(): SealedCompositePublications {
  return {
    '7D': publication('7D'),
    '30D': publication('30D'),
    '90D': publication('90D'),
  }
}

describe('sealed composite cache', () => {
  it('round-trips only a complete three-publication envelope', () => {
    const proofSets = publications()
    const entry = createSealedCompositeCacheEntry(
      { traders: [{ platform: 'binance_futures' }] },
      proofSets,
      new Date('2026-07-29T10:02:00.000Z')
    )

    expect(entry).toEqual({
      contract: SEALED_COMPOSITE_CACHE_CONTRACT,
      publicationIdentity: sealedCompositePublicationIdentity(proofSets),
      publications: proofSets,
      cachedAt: '2026-07-29T10:02:00.000Z',
      value: { traders: [{ platform: 'binance_futures' }] },
    })
    expect(parseSealedCompositeCacheEntry(entry)).toEqual(entry)
  })

  it.each([
    ['legacy payload', { traders: [] }],
    [
      'missing season',
      (() => {
        const entry = createSealedCompositeCacheEntry({}, publications())
        const { '7D': _removed, ...incomplete } = entry.publications
        return { ...entry, publications: incomplete }
      })(),
    ],
    [
      'changed proof',
      (() => {
        const entry = createSealedCompositeCacheEntry({}, publications())
        return {
          ...entry,
          publications: {
            ...entry.publications,
            '30D': {
              ...entry.publications['30D'],
              proofs: [
                {
                  ...entry.publications['30D'].proofs[0],
                  published_rank_count: 1,
                },
              ],
            },
          },
        }
      })(),
    ],
    [
      'quarantined source',
      (() => {
        const proofSets = publications()
        return {
          contract: SEALED_COMPOSITE_CACHE_CONTRACT,
          publicationIdentity: '',
          publications: {
            ...proofSets,
            '7D': publication('7D', 'okx_web3_solana'),
          },
          cachedAt: '2026-07-29T10:02:00.000Z',
          value: {},
        }
      })(),
    ],
  ])('rejects %s', (_label, input) => {
    expect(parseSealedCompositeCacheEntry(input)).toBeNull()
  })

  it('rejects invalid publications and timestamps at creation', () => {
    expect(() => createSealedCompositeCacheEntry({}, publications(), new Date('invalid'))).toThrow()
    expect(() =>
      createSealedCompositeCacheEntry(
        {},
        {
          ...publications(),
          '90D': publication('90D', 'okx_web3_solana'),
        }
      )
    ).toThrow()
  })
})
