const mockReadLeaderboardPublicationAuthority = jest.fn()
const mockReadLeaderboardPublicationProofs = jest.fn()

jest.mock('@/lib/rankings/read-publication-authority', () => ({
  readLeaderboardPublicationAuthority: (...args: unknown[]) =>
    mockReadLeaderboardPublicationAuthority(...args),
}))

jest.mock('@/lib/rankings/read-publication-proofs', () => ({
  ...jest.requireActual('@/lib/rankings/read-publication-proofs'),
  readLeaderboardPublicationProofs: (...args: unknown[]) =>
    mockReadLeaderboardPublicationProofs(...args),
}))

import {
  readSealedCompositePublicationFence,
  SealedCompositeGenerationChangedError,
} from '@/lib/rankings/read-sealed-composite-publications'
import type { LeaderboardPublicationSeason } from '@/lib/rankings/read-publication-proofs'

function publication(
  season: LeaderboardPublicationSeason,
  sources: readonly string[],
  generation = 'one'
) {
  const scoreCohortId =
    generation === 'one'
      ? '11111111-1111-4111-8111-111111111111'
      : '22222222-2222-4222-8222-222222222222'
  return {
    state: 'sealed',
    season,
    scoreCohortId,
    proofs: sources.map((source) => ({
      season_id: season,
      source,
      source_as_of: '2026-07-29T00:00:00.000000Z',
      recorded_at: '2026-07-29T00:01:00.000000Z',
      score_cohort_id: scoreCohortId,
      rank_mutation_seq: generation === 'one' ? 1 : 2,
      current_mutation_seq: generation === 'one' ? 1 : 2,
      published_rank_count: 10,
      published_identity_sha256: generation === 'one' ? '1'.repeat(64) : '2'.repeat(64),
      is_sealed: true,
    })),
  }
}

const authorityBySeason: Record<LeaderboardPublicationSeason, readonly string[]> = {
  '7D': ['binance_futures', 'hyperliquid'],
  '30D': ['binance_futures'],
  '90D': ['binance_futures', 'bybit'],
}

describe('readSealedCompositePublicationFence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadLeaderboardPublicationAuthority.mockImplementation(
      async (_client, season: LeaderboardPublicationSeason) => authorityBySeason[season]
    )
    mockReadLeaderboardPublicationProofs.mockImplementation(
      async (
        _client,
        input: { season: LeaderboardPublicationSeason; sources: readonly string[] }
      ) => publication(input.season, input.sources)
    )
  })

  it('freezes each dynamic season authority and revalidates with one clock', async () => {
    const client = { rpc: jest.fn() }
    const fence = await readSealedCompositePublicationFence(client as never, {
      timeoutMs: 10_000,
    })

    expect(fence.sourcesFor('7D')).toEqual(['binance_futures', 'hyperliquid'])
    expect(fence.sourcesFor('30D')).toEqual(['binance_futures'])
    expect(fence.sourcesFor('90D')).toEqual(['binance_futures', 'bybit'])
    expect(fence.publicationFor('30D').season).toBe('30D')
    expect(Object.keys(fence.publications).sort()).toEqual(['30D', '7D', '90D'])
    expect(mockReadLeaderboardPublicationAuthority).toHaveBeenCalledTimes(3)
    expect(mockReadLeaderboardPublicationProofs).toHaveBeenCalledTimes(3)

    await fence.verifyStillCurrent()

    expect(mockReadLeaderboardPublicationAuthority).toHaveBeenCalledTimes(6)
    expect(mockReadLeaderboardPublicationProofs).toHaveBeenCalledTimes(6)
    expect(
      mockReadLeaderboardPublicationProofs.mock.calls.map(([, input]) => input.season)
    ).toEqual(['7D', '30D', '90D', '7D', '30D', '90D'])
    const authorityClocks = mockReadLeaderboardPublicationAuthority.mock.calls.map(
      ([, , options]) => options.now
    )
    const proofClocks = mockReadLeaderboardPublicationProofs.mock.calls.map(
      ([, , options]) => options.now
    )
    expect([...authorityClocks, ...proofClocks].every((clock) => clock === proofClocks[0])).toBe(
      true
    )
  })

  it('fails closed when any season changes before publication', async () => {
    let reads = 0
    mockReadLeaderboardPublicationProofs.mockImplementation(
      async (
        _client,
        input: { season: LeaderboardPublicationSeason; sources: readonly string[] }
      ) => {
        reads += 1
        return publication(
          input.season,
          input.sources,
          reads > 3 && input.season === '30D' ? 'two' : 'one'
        )
      }
    )

    const fence = await readSealedCompositePublicationFence({ rpc: jest.fn() } as never)

    await expect(fence.verifyStillCurrent()).rejects.toBeInstanceOf(
      SealedCompositeGenerationChangedError
    )
  })

  it('fails closed if any dynamic season authority contains a non-public source', async () => {
    mockReadLeaderboardPublicationAuthority.mockResolvedValue([
      'binance_futures',
      'okx_web3_solana',
    ])

    await expect(readSealedCompositePublicationFence({ rpc: jest.fn() } as never)).rejects.toThrow(
      'non-public source'
    )
    expect(mockReadLeaderboardPublicationProofs).not.toHaveBeenCalled()
  })
})
