jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body?: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockCheckRateLimit = jest.fn()
const mockFrom = jest.fn()
const mockResolveTrader = jest.fn()
const mockGetOrSetWithLock = jest.fn()
const mockCalculateBadges = jest.fn()

jest.mock('@/lib/api', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { public: 'public' },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))

jest.mock('@/lib/badges', () => ({
  calculateBadges: (...args: unknown[]) => mockCalculateBadges(...args),
}))

jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn() } }))

function makeQuery(result: { data: unknown; error: unknown }) {
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
    source_trader_id: 'trader-1',
    roi: 20,
    pnl: 200,
    win_rate: 55,
    max_drawdown: 12,
    followers: 100,
    arena_score: 99,
    rank: 1,
    computed_at: new Date().toISOString(),
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    season_id: '90D',
    ...overrides,
  }
}

import { GET } from '../route'

describe('GET /api/traders/[handle]/badges', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockResolveTrader.mockResolvedValue({
      platform: 'binance_futures',
      traderKey: 'trader-1',
      handle: 'Trader One',
      avatarUrl: null,
    })
    mockCalculateBadges.mockReturnValue([{ id: 'rank-1', label: 'Top 1' }])
    mockGetOrSetWithLock.mockImplementation(async (_key: string, loader: () => Promise<unknown>) =>
      loader()
    )
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard') {
        return makeQuery({ data: rankedRow(), error: null })
      }
      if (relation === 'user_profiles') return makeQuery({ data: null, error: null })
      throw new Error(`unexpected relation ${relation}`)
    })
  })

  it('derives rank badges only from the sealed public cohort', async () => {
    const response = await GET(
      new Request('https://arena.test/api/traders/trader-one/badges') as never,
      {
        params: Promise.resolve({ handle: 'trader-one' }),
      }
    )

    await expect(response.json()).resolves.toEqual({
      badges: [{ id: 'rank-1', label: 'Top 1' }],
    })
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(mockCalculateBadges).toHaveBeenCalledWith({ handle: 'trader-1', rank: 1 })
    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      'public-rank-policy-v7:badges:verified:v2:binance_futures:trader-1',
      expect.any(Function),
      expect.objectContaining({ ttl: 300 })
    )
  })

  it('fails closed when a cache row no longer satisfies public ranking proof', async () => {
    mockGetOrSetWithLock.mockResolvedValue({
      scope: { source: 'binance_futures', sourceTraderId: 'trader-1', period: '90D' },
      row: rankedRow({ metrics_estimated: true }),
    })

    const response = await GET(
      new Request('https://arena.test/api/traders/trader-one/badges') as never,
      {
        params: Promise.resolve({ handle: 'trader-one' }),
      }
    )

    await expect(response.json()).resolves.toEqual({
      badges: [],
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'public_cohort_unverified',
      ranking_visibility_reasons: ['public_cohort_unverified'],
    })
    expect(mockCalculateBadges).not.toHaveBeenCalled()
  })

  it('does not use an unrankable source as a badge rank fallback', async () => {
    mockResolveTrader.mockResolvedValue({
      platform: 'bingx',
      traderKey: 'trader-1',
      handle: 'Trader One',
      avatarUrl: null,
    })

    const response = await GET(
      new Request('https://arena.test/api/traders/trader-one/badges') as never,
      {
        params: Promise.resolve({ handle: 'trader-one' }),
      }
    )

    await expect(response.json()).resolves.toEqual({
      badges: [],
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'source_not_publicly_rankable',
      ranking_visibility_reasons: ['source_not_publicly_rankable'],
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
