jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Headers()

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockGetOrSetWithLock = jest.fn()

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))

const mockFrom = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: unknown) => unknown) => () =>
    handler({ supabase: { from: mockFrom } }),
}))

function makeQuery(result: { data: unknown[] | null; error: unknown }) {
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        return jest.fn(() => proxy)
      },
    }
  )
  return proxy
}

function rankedRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'binance-one',
    handle: 'Binance One',
    avatar_url: null,
    roi: 20,
    pnl: 200,
    arena_score: 99,
    rank: 1,
    win_rate: 55,
    max_drawdown: 12,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    season_id: '90D',
    ...overrides,
  }
}

import { GET } from '../route'

describe('GET /api/sidebar/top-traders', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetOrSetWithLock.mockImplementation(async (_key: string, loader: () => Promise<unknown>) =>
      loader()
    )
  })

  it('keeps a real empty leaderboard as a successful empty result', async () => {
    mockFrom.mockReturnValue(makeQuery({ data: [], error: null }))

    const response = await GET()

    await expect(response.json()).resolves.toEqual({ traders: [] })
  })

  it('propagates a leaderboard read failure instead of caching it as empty', async () => {
    const databaseError = new Error('leaderboard unavailable')
    mockFrom.mockReturnValue(makeQuery({ data: null, error: databaseError }))

    await expect(GET()).rejects.toBe(databaseError)
    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      'public-rank-policy-v7:sidebar:top-traders:v3',
      expect.any(Function),
      expect.objectContaining({ ttl: 300 })
    )
  })

  it('reads the sealed public view and preserves persisted ranks after exchange diversification', async () => {
    mockFrom.mockReturnValue(
      makeQuery({
        data: [
          rankedRow(),
          rankedRow({
            source: 'okx_futures',
            source_trader_id: 'okx-twelve',
            handle: 'OKX Twelve',
            roi: 18,
            pnl: 180,
            arena_score: 95,
            rank: 12,
          }),
          rankedRow({
            source_trader_id: 'binance-two',
            handle: 'Binance Two',
            roi: 17,
            pnl: 170,
            arena_score: 90,
            rank: 2,
          }),
        ],
        error: null,
      })
    )

    const response = await GET()
    const payload = (await response.json()) as {
      traders: Array<{ source_trader_id: string; rank: number }>
    }

    expect(payload.traders.map(({ source_trader_id, rank }) => [source_trader_id, rank])).toEqual([
      ['binance-one', 1],
      ['okx-twelve', 12],
      ['binance-two', 2],
    ])
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('fails closed rather than shifting a finite sidebar selection after a proof mismatch', async () => {
    mockFrom.mockReturnValue(
      makeQuery({
        data: [rankedRow(), rankedRow({ source_trader_id: 'estimated', metrics_estimated: true })],
        error: null,
      })
    )

    const response = await GET()

    await expect(response.json()).resolves.toEqual({
      traders: [],
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'public_cohort_unverified',
      ranking_visibility_reasons: ['public_cohort_unverified'],
    })
  })
})
