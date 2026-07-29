import { readLeaderboardPublicationAuthority } from '@/lib/rankings/read-publication-authority'
import {
  readLeaderboardPublicationProofs,
  type LeaderboardPublicationSeason,
  type SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'
import {
  COMPOSITE_RANKING_SEASONS,
  readSealedCompositeRankingGeneration,
} from '@/lib/rankings/read-sealed-composite-ranking-generation'
import { SealedRankingGenerationChangedError } from '@/lib/rankings/read-sealed-ranking-generation'

jest.mock('@/lib/rankings/read-publication-authority', () => ({
  readLeaderboardPublicationAuthority: jest.fn(),
}))
jest.mock('@/lib/rankings/read-publication-proofs', () => ({
  ...jest.requireActual('@/lib/rankings/read-publication-proofs'),
  readLeaderboardPublicationProofs: jest.fn(),
}))

const mockReadAuthority = jest.mocked(readLeaderboardPublicationAuthority)
const mockReadProofs = jest.mocked(readLeaderboardPublicationProofs)
const SOURCES = Object.freeze(['binance_futures', 'hyperliquid'])

function publication(
  season: LeaderboardPublicationSeason,
  mutationSeq = 9
): SealedLeaderboardPublicationProofSet {
  const cohortSuffix = season === '7D' ? '1' : season === '30D' ? '2' : '3'
  const cohort = `${cohortSuffix.repeat(8)}-${cohortSuffix.repeat(4)}-4${cohortSuffix.repeat(
    3
  )}-8${cohortSuffix.repeat(3)}-${cohortSuffix.repeat(12)}`
  return Object.freeze({
    state: 'sealed',
    season,
    scoreCohortId: cohort,
    proofs: Object.freeze(
      SOURCES.map((source, index) =>
        Object.freeze({
          season_id: season,
          source,
          source_as_of: '2026-07-29T10:00:00.000000Z',
          recorded_at: '2026-07-29T10:01:00.000000Z',
          score_cohort_id: cohort,
          rank_mutation_seq: mutationSeq,
          current_mutation_seq: mutationSeq,
          published_rank_count: 2,
          published_identity_sha256: (index === 0 ? 'a' : 'b').repeat(64),
          is_sealed: true as const,
        })
      )
    ),
  })
}

describe('readSealedCompositeRankingGeneration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadAuthority.mockResolvedValue(SOURCES)
    mockReadProofs.mockImplementation(async (_client, input) => publication(input.season))
  })

  it('opens and closes the complete dynamic authority for 7D, 30D, and 90D', async () => {
    const reader = jest.fn().mockResolvedValue([{ trader: 'alice' }])

    const result = await readSealedCompositeRankingGeneration({ rpc: jest.fn() } as never, reader, {
      now: new Date('2026-07-29T10:02:00.000Z'),
    })

    expect(result.value).toEqual([{ trader: 'alice' }])
    expect(result.publication.publications.map(({ season }) => season)).toEqual([
      '7D',
      '30D',
      '90D',
    ])
    expect(reader).toHaveBeenCalledTimes(1)
    expect(mockReadAuthority).toHaveBeenCalledTimes(6)
    expect(mockReadProofs).toHaveBeenCalledTimes(6)
    expect(mockReadProofs.mock.calls.map(([, input]) => input.season)).toEqual([
      ...COMPOSITE_RANKING_SEASONS,
      ...COMPOSITE_RANKING_SEASONS,
    ])
    expect(new Set(mockReadProofs.mock.calls.map(([, , options]) => options?.now)).size).toBe(1)
  })

  it('rejects the combined value when any season changes after the reader', async () => {
    let readCount = 0
    mockReadProofs.mockImplementation(async (_client, input) => {
      readCount += 1
      return publication(input.season, readCount > 3 && input.season === '30D' ? 10 : 9)
    })

    await expect(
      readSealedCompositeRankingGeneration({ rpc: jest.fn() } as never, async () => 'value')
    ).rejects.toBeInstanceOf(SealedRankingGenerationChangedError)
  })

  it('does not call the data reader if one opening proof fails', async () => {
    const reader = jest.fn()
    mockReadProofs.mockImplementation(async (_client, input) => {
      if (input.season === '30D') throw new Error('30D proof unavailable')
      return publication(input.season)
    })

    await expect(
      readSealedCompositeRankingGeneration({ rpc: jest.fn() } as never, reader)
    ).rejects.toThrow('30D proof unavailable')
    expect(reader).not.toHaveBeenCalled()
  })

  it('does not authorize the value if one closing proof fails', async () => {
    let readCount = 0
    mockReadProofs.mockImplementation(async (_client, input) => {
      readCount += 1
      if (readCount > 3 && input.season === '7D') throw new Error('closing proof unavailable')
      return publication(input.season)
    })

    await expect(
      readSealedCompositeRankingGeneration({ rpc: jest.fn() } as never, async () => 'value')
    ).rejects.toThrow('closing proof unavailable')
  })
})
