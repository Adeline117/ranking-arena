const mockResolveTrader = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/constants/urls', () => ({
  BASE_URL: 'https://arena.test',
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

import { generateMetadata } from '../layout'

function publicRankedRow(
  source: string,
  traderId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    handle: `${source}-${traderId}`,
    source,
    source_trader_id: traderId,
    season_id: '90D',
    rank: 7,
    roi: 10,
    arena_score: 80,
    pnl: 100,
    win_rate: 61,
    max_drawdown: 14,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

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
    mockFrom.mockImplementation((relation: string) => {
      if (relation !== 'public_ranked_leaderboard') {
        throw new Error(`unexpected relation: ${relation}`)
      }
      let source = ''
      let traderId = ''
      const query = {
        select: jest.fn(() => query),
        eq: jest.fn((field: string, value: string) => {
          if (field === 'source') source = value
          if (field === 'source_trader_id') traderId = value
          return query
        }),
        maybeSingle: jest.fn(async () => ({
          data: publicRankedRow(source, traderId),
          error: null,
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

    const openGraph = metadata.openGraph as {
      url: string
      images: Array<{ url: string }>
    }
    expect(openGraph.url).toBe(
      'https://arena.test/compare?ids=shared%2Cshared&platforms=bybit%2Cbinance_futures'
    )
    expect(openGraph.images[0].url).toContain('platforms=bybit%2Cbinance_futures')
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
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

  it('fails closed to the static card when a public-view row lacks ranking proof', async () => {
    mockFrom.mockImplementation((relation: string) => {
      if (relation !== 'public_ranked_leaderboard') {
        throw new Error(`unexpected relation: ${relation}`)
      }
      let source = ''
      let traderId = ''
      const query = {
        select: jest.fn(() => query),
        eq: jest.fn((field: string, value: string) => {
          if (field === 'source') source = value
          if (field === 'source_trader_id') traderId = value
          return query
        }),
        maybeSingle: jest.fn(async () => ({
          data: publicRankedRow(source, traderId, { metrics_estimated: true }),
          error: null,
        })),
      }
      return query
    })

    const metadata = await generateMetadata({
      searchParams: Promise.resolve({ ids: 'partial', platforms: 'bybit' }),
    })

    const openGraph = metadata.openGraph as { images: Array<{ url: string }> }
    expect(openGraph.images[0].url).toBe('https://arena.test/og-image.png')
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
  })
})
