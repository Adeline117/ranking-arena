const mockCreateClient = jest.fn()
const mockFrom = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}))

import sitemap from '../sitemap'

type QueryResult = {
  data: unknown[] | null
  error: { message: string; code?: string } | null
}

type QueryMock = Record<string, jest.Mock> & PromiseLike<QueryResult>

function query(result: QueryResult): QueryMock {
  const methods: Record<string, jest.Mock> = {}
  const chain = new Proxy(methods, {
    get(target, property) {
      if (property === 'then') {
        return (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve)
      }
      const key = String(property)
      target[key] ??= jest.fn(() => chain)
      return target[key]
    },
  })
  return chain as unknown as QueryMock
}

function publicRankedRow(overrides: Record<string, unknown> = {}) {
  return {
    handle: 'Top Trader',
    source_trader_id: 'trader-1',
    source: 'binance_futures',
    rank: 1,
    computed_at: '2026-08-16T12:00:00.000Z',
    ...overrides,
  }
}

describe('Next trader sitemap public ranking cohort', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateClient.mockReturnValue({ from: mockFrom })
  })

  it('reads one ordered public cohort shard before its finite range', async () => {
    const rankingQuery = query({
      data: [
        publicRankedRow(),
        publicRankedRow({ source: 'okx_futures', source_trader_id: 'trader-2' }),
      ],
      error: null,
    })
    mockFrom.mockReturnValue(rankingQuery)

    const entries = await sitemap({ id: 2 })

    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(rankingQuery.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(rankingQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(rankingQuery.order.mock.calls).toEqual([
      ['rank', { ascending: true, nullsFirst: false }],
      ['source', { ascending: true, nullsFirst: false }],
      ['source_trader_id', { ascending: true, nullsFirst: false }],
    ])
    expect(rankingQuery.range).toHaveBeenCalledWith(5000, 9999)
    expect(entries).toEqual([
      expect.objectContaining({
        url: 'https://www.arenafi.org/trader/Top%20Trader?platform=binance_futures',
        lastModified: '2026-08-16T12:00:00.000Z',
      }),
      expect.objectContaining({
        url: 'https://www.arenafi.org/trader/Top%20Trader?platform=okx_futures',
      }),
    ])
  })

  it('fails a finite shard closed when a view response is malformed', async () => {
    mockFrom.mockReturnValue(query({ data: [publicRankedRow({ rank: null })], error: null }))

    await expect(sitemap({ id: 1 })).resolves.toEqual([])
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
  })
})
