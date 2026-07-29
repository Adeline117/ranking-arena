const mockResolveTrader = jest.fn()
const mockFrom = jest.fn()
const mockPublicationFilter = jest.fn()
const mockReadSealedRankingGeneration = jest.fn()

jest.mock('@/lib/constants/urls', () => ({
  BASE_URL: 'https://arena.test',
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn() },
}))

import { generateMetadata } from '../layout'

describe('compare metadata composite identity', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveTrader.mockImplementation(
      async (_supabase: unknown, account: { handle: string; platform: string }) => ({
        platform: account.platform,
        traderKey: account.handle,
        handle: account.handle,
      })
    )
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _supabase: unknown,
        input: { season: '90D'; sources: string[] },
        reader: (publication: { scoreCohortId: string }) => Promise<unknown>
      ) => {
        const publication = {
          state: 'sealed' as const,
          season: input.season,
          scoreCohortId: '11111111-1111-4111-8111-111111111111',
          proofs: [],
        }
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
    mockFrom.mockImplementation(() => {
      let source = ''
      let traderId = ''
      const query = {
        select: jest.fn(() => query),
        eq: jest.fn((field: string, value: string) => {
          if (field === 'source') source = value
          if (field === 'source_trader_id') traderId = value
          return query
        }),
        filter: mockPublicationFilter.mockImplementation(() => query),
        maybeSingle: jest.fn(async () => ({
          data: {
            handle: `${source}-${traderId}`,
            source,
            roi: 10,
            arena_score: 80,
            pnl: 100,
          },
        })),
      }
      return query
    })
  })

  it('resolves equal raw IDs against their paired platforms', async () => {
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({
        ids: 'shared,shared',
        platforms: 'bybit,binance_futures',
      }),
    })

    expect(mockResolveTrader).toHaveBeenNthCalledWith(1, expect.anything(), {
      handle: 'shared',
      platform: 'bybit',
    })
    expect(mockResolveTrader).toHaveBeenNthCalledWith(2, expect.anything(), {
      handle: 'shared',
      platform: 'binance_futures',
    })
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      expect.anything(),
      { season: '90D', sources: ['binance_futures', 'bybit'] },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(mockPublicationFilter).toHaveBeenCalledTimes(2)
    expect(mockPublicationFilter).toHaveBeenCalledWith(
      'rank_publication_id',
      'eq',
      '11111111-1111-4111-8111-111111111111'
    )

    const openGraph = metadata.openGraph as {
      url: string
      images: Array<{ url: string }>
    }
    expect(openGraph.url).toBe(
      'https://arena.test/compare?ids=shared%2Cshared&platforms=bybit%2Cbinance_futures'
    )
    expect(openGraph.images[0].url).toContain('platforms=bybit%2Cbinance_futures')
  })

  it('does not source-blind resolve a legacy ids-only URL', async () => {
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({ ids: 'shared' }),
    })

    expect(mockResolveTrader).not.toHaveBeenCalled()
    const openGraph = metadata.openGraph as {
      url: string
      images: Array<{ url: string }>
    }
    expect(openGraph.url).toBe('https://arena.test/compare')
    expect(openGraph.images[0].url).toBe('https://arena.test/og-image.png')
  })
})
