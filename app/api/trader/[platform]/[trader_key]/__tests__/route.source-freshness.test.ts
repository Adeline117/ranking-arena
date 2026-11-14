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

function freshnessQuery(rows: unknown[]) {
  const query = emptyQuery()
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve, reject)
  return query
}

import { GET } from '../route'
import { sourceWatermarkForWindows } from '@/lib/rankings/source-watermark'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')

async function fetchDetail(watermarks: unknown[]) {
  mockSupabase = {
    from: jest.fn((relation: string) =>
      relation === 'leaderboard_source_freshness' ? freshnessQuery(watermarks) : emptyQuery()
    ),
  }
  mockFetchPublicProfileRankingRows.mockResolvedValueOnce({
    rows: [publishedRow()],
    rankingVisibility: 'verified',
    rankingVisibilityReason: null,
  })
  const response = await GET({} as never, {
    params: Promise.resolve({ platform: 'binance_futures', trader_key: 'trader-1' }),
  })
  return (await response.json()) as {
    updated_at: string | null
    is_stale: boolean
    staleness_seconds: number | null
  }
}

describe('GET /api/trader/[platform]/[trader_key] data freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] })
  })
  afterEach(() => jest.useRealTimers())

  it('reports the source watermark, not the score recompute time', async () => {
    // publishedRow().computed_at is 2026-08-16; the source data is from 2026-08-01.
    const body = await fetchDetail([
      { season_id: '90D', source: 'binance_futures', source_as_of: '2026-08-01T00:00:00.000Z' },
    ])
    expect(mockSupabase.from).toHaveBeenCalledWith('leaderboard_source_freshness')
    expect(body.updated_at).toBe('2026-08-01T00:00:00.000Z')
    expect(body.is_stale).toBe(true)
    expect(body.staleness_seconds).toBe((NOW - Date.parse('2026-08-01T00:00:00.000Z')) / 1000)
  })

  it('leaves freshness unknown when no watermark exists instead of using computed_at', async () => {
    const body = await fetchDetail([])
    expect(body.updated_at).toBeNull()
    expect(body.is_stale).toBe(true)
    expect(body.staleness_seconds).toBeNull()
  })

  it('treats a recent watermark as fresh', async () => {
    const body = await fetchDetail([
      { season_id: '90D', source: 'binance_futures', source_as_of: '2026-11-11T11:00:00.000Z' },
    ])
    expect(body.updated_at).toBe('2026-11-11T11:00:00.000Z')
    expect(body.is_stale).toBe(false)
    expect(body.staleness_seconds).toBe(3600)
  })
})

describe('sourceWatermarkForWindows', () => {
  const rows = [
    { season_id: '7D', source: 'okx', source_as_of: '2026-11-11T10:00:00.000Z' },
    { season_id: '90D', source: 'okx', source_as_of: '2026-11-08T00:00:00.000Z' },
    { season_id: '90D', source: 'bybit', source_as_of: '2026-11-11T11:00:00.000Z' },
  ]

  it('uses the oldest watermark across the published windows', () => {
    expect(sourceWatermarkForWindows('okx', ['7D', '90D'], rows, NOW)).toEqual({
      asOf: '2026-11-08T00:00:00.000Z',
      isStale: true,
      ageSeconds: (NOW - Date.parse('2026-11-08T00:00:00.000Z')) / 1000,
    })
  })

  it('is unknown when any published window lacks a watermark', () => {
    expect(sourceWatermarkForWindows('okx', ['7D', '30D'], rows, NOW).asOf).toBeNull()
  })

  it('is unknown when nothing is published', () => {
    expect(sourceWatermarkForWindows('okx', [], rows, NOW)).toEqual({
      asOf: null,
      isStale: true,
      ageSeconds: null,
    })
  })

  it('ignores a future watermark', () => {
    const future = [{ season_id: '7D', source: 'okx', source_as_of: '2027-01-01T00:00:00.000Z' }]
    expect(sourceWatermarkForWindows('okx', ['7D'], future, NOW).asOf).toBeNull()
  })
})
