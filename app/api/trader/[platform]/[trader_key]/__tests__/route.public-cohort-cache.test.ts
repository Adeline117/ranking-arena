jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private readonly body: unknown
    private readonly values = new Map<string, string>()

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body
      this.status = init.status ?? 200
      for (const [name, value] of Object.entries(init.headers ?? {})) this.values.set(name, value)
    }

    get headers() {
      return {
        get: (name: string) => this.values.get(name) ?? null,
        set: (name: string, value: string) => this.values.set(name, value),
      }
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: class MockNextRequest {} }
})

let mockSupabase: { from: jest.Mock }

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: { supabase: typeof mockSupabase }) => unknown) => async () =>
    handler({ supabase: mockSupabase }),
}))

jest.mock('@/lib/constants/exchanges', () => ({
  ALL_SOURCES: ['binance_futures'],
}))

const mockFetchPublicProfileRankingRows = jest.fn()
jest.mock('@/lib/data/trader/public-profile-ranking', () => ({
  fetchPublicProfileRankingRows: (...args: unknown[]) => mockFetchPublicProfileRankingRows(...args),
  PUBLIC_PROFILE_RANKING_PERIODS: ['7D', '30D', '90D'],
}))

function emptyQuery() {
  const query: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
    query[method] = jest.fn(() => query)
  }
  query.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null })
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve, reject)
  return query
}

function publishedRow() {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    season_id: '90D',
    rank: 1,
    roi: 12.5,
    pnl: 5000,
    win_rate: 62,
    max_drawdown: 9,
    trades_count: 42,
    followers: 12,
    arena_score: 88,
    computed_at: '2026-08-16T00:00:00.000Z',
  }
}

import { GET } from '../route'

describe('GET /api/trader/[platform]/[trader_key] current public-cohort proof', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSupabase = { from: jest.fn(() => emptyQuery()) }
  })

  it('does not replay an earlier ranked payload after the current cohort becomes unavailable', async () => {
    mockFetchPublicProfileRankingRows
      .mockResolvedValueOnce({
        rows: [publishedRow()],
        rankingVisibility: 'verified',
        rankingVisibilityReason: null,
      })
      .mockResolvedValueOnce({
        rows: [],
        rankingVisibility: 'unknown',
        rankingVisibilityReason: 'public_cohort_unavailable',
      })

    const first = await GET({} as never, {
      params: Promise.resolve({ platform: 'binance_futures', trader_key: 'trader-1' }),
    })
    const firstBody = (await first.json()) as {
      snapshots: { '90D': { rank: number; roi: number } | null }
    }
    expect(firstBody.snapshots['90D']).toMatchObject({ rank: 1, roi: 12.5 })

    const second = await GET({} as never, {
      params: Promise.resolve({ platform: 'binance_futures', trader_key: 'trader-1' }),
    })
    const secondBody = (await second.json()) as {
      snapshots: Record<'7D' | '30D' | '90D', unknown>
      ranking_visibility: string
      ranking_visibility_reason: string | null
    }

    expect(mockFetchPublicProfileRankingRows).toHaveBeenCalledTimes(2)
    expect(secondBody.snapshots).toEqual({ '7D': null, '30D': null, '90D': null })
    expect(secondBody.ranking_visibility).toBe('unknown')
    expect(secondBody.ranking_visibility_reason).toBe('public_cohort_unavailable')
    expect(second.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(second.headers.get('CDN-Cache-Control')).toBe('no-store')
  })
})
