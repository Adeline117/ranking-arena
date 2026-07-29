import {
  readLeaderboardPublicationProofs,
  type SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'
import {
  readSealedRankingGeneration,
  sealedRankingPublicationIdentity,
  SealedRankingGenerationChangedError,
} from '@/lib/rankings/read-sealed-ranking-generation'

jest.mock('@/lib/rankings/read-publication-proofs', () => ({
  ...jest.requireActual('@/lib/rankings/read-publication-proofs'),
  readLeaderboardPublicationProofs: jest.fn(),
}))

const mockReadProofs = jest.mocked(readLeaderboardPublicationProofs)
const COHORT = '11111111-1111-4111-8111-111111111111'

function publication(
  overrides: Partial<SealedLeaderboardPublicationProofSet['proofs'][number]> = {}
): SealedLeaderboardPublicationProofSet {
  const proof = {
    season_id: '90D' as const,
    source: 'binance_futures',
    source_as_of: '2026-07-29T10:00:00.000000Z',
    recorded_at: '2026-07-29T10:01:00.000000Z',
    score_cohort_id: COHORT,
    rank_mutation_seq: 9,
    current_mutation_seq: 9,
    published_rank_count: 2,
    published_identity_sha256: 'a'.repeat(64),
    is_sealed: true as const,
    ...overrides,
  }
  return Object.freeze({
    state: 'sealed' as const,
    season: '90D' as const,
    scoreCohortId: proof.score_cohort_id,
    proofs: Object.freeze([Object.freeze(proof)]),
  })
}

describe('readSealedRankingGeneration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('returns data only after the complete proof identity is stable', async () => {
    const sealed = publication()
    mockReadProofs.mockResolvedValue(sealed)
    const reader = jest.fn().mockResolvedValue([{ rank: 1 }])

    await expect(
      readSealedRankingGeneration(
        { rpc: jest.fn() } as never,
        { season: '90D', sources: ['binance_futures'] },
        reader,
        { now: new Date('2026-07-29T10:02:00.000Z') }
      )
    ).resolves.toEqual({
      value: [{ rank: 1 }],
      publication: sealed,
      publicationIdentity: sealedRankingPublicationIdentity(sealed),
    })

    expect(reader).toHaveBeenCalledWith(sealed)
    expect(mockReadProofs).toHaveBeenCalledTimes(2)
    expect(mockReadProofs.mock.calls[0][2]?.now).toBe(mockReadProofs.mock.calls[1][2]?.now)
  })

  test.each([
    ['cohort', { score_cohort_id: '22222222-2222-4222-8222-222222222222' }],
    ['mutation fence', { rank_mutation_seq: 10, current_mutation_seq: 10 }],
    ['rank count', { published_rank_count: 3 }],
    ['identity digest', { published_identity_sha256: 'b'.repeat(64) }],
    ['source watermark', { source_as_of: '2026-07-29T10:00:01.000000Z' }],
  ])('rejects a %s change across the data read', async (_label, changedProof) => {
    mockReadProofs
      .mockResolvedValueOnce(publication())
      .mockResolvedValueOnce(publication(changedProof))

    await expect(
      readSealedRankingGeneration(
        { rpc: jest.fn() } as never,
        { season: '90D', sources: ['binance_futures'] },
        async () => [{ rank: 1 }]
      )
    ).rejects.toBeInstanceOf(SealedRankingGenerationChangedError)
  })

  test('does not run the data reader when initial proof authorization fails', async () => {
    const proofFailure = new Error('proof unavailable')
    mockReadProofs.mockRejectedValue(proofFailure)
    const reader = jest.fn()

    await expect(
      readSealedRankingGeneration(
        { rpc: jest.fn() } as never,
        { season: '90D', sources: ['binance_futures'] },
        reader
      )
    ).rejects.toBe(proofFailure)
    expect(reader).not.toHaveBeenCalled()
  })

  test('does not authorize data when the closing proof read fails', async () => {
    const proofFailure = new Error('closing proof unavailable')
    mockReadProofs.mockResolvedValueOnce(publication()).mockRejectedValueOnce(proofFailure)

    await expect(
      readSealedRankingGeneration(
        { rpc: jest.fn() } as never,
        { season: '90D', sources: ['binance_futures'] },
        async () => [{ rank: 1 }]
      )
    ).rejects.toBe(proofFailure)
  })
})
