const mockCheckRateLimit = jest.fn()
const mockVerifyEdgeCronSecret = jest.fn()
const mockFrom = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers = new Headers()

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { public: {} },
}))

jest.mock('@/lib/auth/edge-cron-auth', () => ({
  verifyEdgeCronSecret: (...args: unknown[]) => mockVerifyEdgeCronSecret(...args),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

type QueryResult = { data: unknown[] | null; error: { message: string } | null }

function query(result: QueryResult) {
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
  return chain
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    rank: 1,
    source_trader_id: 'trader-1',
    handle: 'Top, Trader',
    source: 'binance_futures',
    arena_score: 91.5,
    roi: 24.5,
    pnl: 12_000,
    win_rate: 62,
    max_drawdown: 16,
    followers: 123,
    trades_count: 42,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    season_id: '90D',
    ...overrides,
  }
}

import type { NextRequest } from 'next/server'
import { GET } from '../route'

function request(url = 'http://localhost/api/export/rankings?format=json&timeRange=90D&limit=2') {
  return { url } as NextRequest
}

async function responseText(response: unknown): Promise<string> {
  if (
    typeof response === 'object' &&
    response !== null &&
    typeof (response as { text?: unknown }).text === 'function'
  ) {
    return (response as { text(): Promise<string> }).text()
  }

  // The repository's Node/Jest fallback Response exposes its body this way.
  // Production uses the standard Web Response and takes the branch above.
  return String((response as { _body?: unknown })._body ?? '')
}

describe('GET /api/export/rankings verified public cohort', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockVerifyEdgeCronSecret.mockResolvedValue(true)
  })

  it('requires the export secret before any public cohort query', async () => {
    mockVerifyEdgeCronSecret.mockResolvedValue(false)

    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('exports only the public cohort with period/source filters before limit', async () => {
    const rankingQuery = query({ data: [row({ season_id: '30D' })], error: null })
    mockFrom.mockReturnValue(rankingQuery)

    const response = await GET(
      request(
        'http://localhost/api/export/rankings?format=json&timeRange=30d&exchange=binance_futures&limit=2'
      )
    )

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(rankingQuery.eq).toHaveBeenCalledWith('season_id', '30D')
    expect(rankingQuery.eq).toHaveBeenCalledWith('source', 'binance_futures')
    expect(rankingQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(rankingQuery.order).toHaveBeenCalledWith('rank', { ascending: true, nullsFirst: false })
    expect(rankingQuery.limit).toHaveBeenCalledWith(2)
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ rank: 1, trader_id: 'trader-1', source: 'binance_futures' }),
    ])
    expect(response.headers.get('Content-Disposition')).toContain(
      'rankings-30D-binance_futures.json'
    )
  })

  it('returns a CSV with correctly escaped verified values', async () => {
    mockFrom.mockReturnValue(query({ data: [row()], error: null }))

    const response = await GET(
      request('http://localhost/api/export/rankings?format=csv&exchange=all')
    )

    expect(response.status).toBe(200)
    await expect(responseText(response)).resolves.toContain('"Top, Trader"')
    expect(response.headers.get('Content-Disposition')).toContain('rankings-90D-all.csv')
  })

  it('fails the complete export closed when any view/proxy row lacks public proof', async () => {
    mockFrom.mockReturnValue(
      query({ data: [row(), row({ rank: 2, metrics_estimated: true })], error: null })
    )

    const response = await GET(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'Public ranking evidence unavailable',
      code: 'PUBLIC_COHORT_UNVERIFIED',
    })
  })

  it('rejects malformed, repeated, unknown, and oversized scopes before querying', async () => {
    const urls = [
      'http://localhost/api/export/rankings?format=xml',
      'http://localhost/api/export/rankings?timeRange=year',
      'http://localhost/api/export/rankings?limit=2001',
      'http://localhost/api/export/rankings?exchange=bad/source',
      'http://localhost/api/export/rankings?timeRange=90D&timeRange=7D',
      'http://localhost/api/export/rankings?unexpected=value',
    ]
    for (const url of urls) {
      const response = await GET(request(url))
      expect(response.status).toBe(400)
    }
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
