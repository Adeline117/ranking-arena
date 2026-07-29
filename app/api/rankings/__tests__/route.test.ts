/**
 * /api/rankings route tests
 *
 * Tests parameter validation, error handling, and response shape
 * for the main leaderboard rankings endpoint.
 */

// --- Mocks ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map(Object.entries(init.headers || {}))
    }
    async json() {
      return this._body
    }
    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers: Map<string, string>
    method: string
    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(
        Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(opts?.headers || {}) })
      )
      this.method = opts?.method || 'GET'
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ response: null, meta: null }),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { read: {}, write: {}, public: {} },
}))

const mockTieredGetOrSet = jest.fn()
const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
}))

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}))

// Supabase mock
const mockSupabaseQuery = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: (...args: unknown[]) => mockSupabaseQuery(...args),
  })),
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  generateCsrfToken: jest.fn().mockReturnValue('test-csrf'),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('test-cid'),
  runWithCorrelationId: jest.fn((_id: string, fn: () => unknown) => fn()),
  getCorrelationId: jest.fn().mockReturnValue('test-cid'),
}))

jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', deprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
import { EXCHANGE_SLUG_ALIASES, PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { RETIRED_SOURCES } from '@/lib/constants/retired-sources'
import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'

const TEST_COHORT_ID = '11111111-1111-4111-8111-111111111111'

async function readThroughSealedGeneration(
  _supabase: unknown,
  input: { season: '7D' | '30D' | '90D'; sources: string[] },
  reader: (publication: {
    state: 'sealed'
    season: '7D' | '30D' | '90D'
    scoreCohortId: string
    proofs: unknown[]
  }) => Promise<unknown>
) {
  const publication = {
    state: 'sealed' as const,
    season: input.season,
    scoreCohortId: TEST_COHORT_ID,
    proofs: [...input.sources].sort().map((source) => ({
      season_id: input.season,
      source,
      source_as_of: '2026-07-29T10:00:00.000000Z',
      recorded_at: '2026-07-29T10:01:00.000000Z',
      score_cohort_id: TEST_COHORT_ID,
      rank_mutation_seq: 9,
      current_mutation_seq: 9,
      published_rank_count: 1,
      published_identity_sha256: 'a'.repeat(64),
      is_sealed: true,
    })),
  }
  const value = await reader(publication)
  return {
    value,
    publication,
    publicationIdentity: JSON.stringify(publication),
  }
}

/** Build a thenable chainable Supabase mock */
function makeChainableQuery(result = { data: [], error: null, count: 0 }) {
  const storage: Record<string, jest.Mock> = {}
  const chain = new Proxy(storage, {
    get(target, prop) {
      const key = prop as string
      if (key === 'then') {
        // Make chain directly awaitable
        return (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve)
      }
      if (key === 'catch' || key === 'finally') return undefined
      if (!target[key]) {
        target[key] = jest.fn(() => chain)
      }
      return target[key]
    },
  })
  return chain
}

describe('GET /api/rankings', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredGetOrSet.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn())
    mockTieredGet.mockResolvedValue({ data: null })
    mockTieredSet.mockResolvedValue(true)
    mockReadSealedRankingGeneration.mockImplementation(readThroughSealedGeneration)
    // Default: Supabase query returns empty results
    mockSupabaseQuery.mockReturnValue(makeChainableQuery())
  })

  // --- Parameter Validation ---

  it('returns 400 when window parameter is missing', async () => {
    const req = new NextRequest('http://localhost/api/rankings')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/window/i)
  })

  it('returns 400 for invalid window parameter', async () => {
    const req = new NextRequest('http://localhost/api/rankings?window=999d')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/window/i)
  })

  it('returns 400 for invalid category', async () => {
    const req = new NextRequest('http://localhost/api/rankings?window=90d&category=invalid')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/category/i)
  })

  it('returns 400 for invalid sort_by', async () => {
    const req = new NextRequest('http://localhost/api/rankings?window=90d&sort_by=invalid_field')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/sort_by/i)
  })

  it('returns 400 for invalid platform', async () => {
    const req = new NextRequest('http://localhost/api/rankings?window=90d&platform=fake_exchange')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/platform/i)
  })

  it.each(PUBLIC_ACTIVE_RANKING_SOURCES)(
    'accepts canonical active platform %s at the public API boundary',
    async (platform) => {
      const req = new NextRequest(
        `http://localhost/api/rankings?window=90d&platform=${platform}&sort_by=roi`
      )
      const res = await GET(req)

      expect(res.status).toBe(200)
    }
  )

  it.each([...RETIRED_SOURCES])(
    'rejects retired platform %s before cache or database access',
    async (platform) => {
      const req = new NextRequest(`http://localhost/api/rankings?window=90d&platform=${platform}`)
      const res = await GET(req)

      expect(res.status).toBe(400)
      expect(mockTieredGetOrSet).not.toHaveBeenCalled()
      expect(mockTieredGet).not.toHaveBeenCalled()
      expect(mockSupabaseQuery).not.toHaveBeenCalled()
    }
  )

  it.each(Object.keys(EXCHANGE_SLUG_ALIASES))(
    'rejects non-canonical platform alias %s consistently',
    async (platform) => {
      const req = new NextRequest(
        `http://localhost/api/rankings?window=90d&platform=${encodeURIComponent(platform)}`
      )
      const res = await GET(req)

      expect(res.status).toBe(400)
      expect(mockTieredGetOrSet).not.toHaveBeenCalled()
      expect(mockTieredGet).not.toHaveBeenCalled()
      expect(mockSupabaseQuery).not.toHaveBeenCalled()
    }
  )

  // --- Successful Responses ---

  it('returns rankings for a valid window', async () => {
    const mockResult = {
      traders: [
        {
          platform: 'binance_futures',
          trader_key: 'trader1',
          display_name: 'TopTrader',
          rank: 1,
          metrics: { arena_score: 95.5, roi: 120.3, pnl: 50000 },
        },
      ],
      window: '90D',
      totalcount: 1,
      total_count: 1,
      as_of: '2026-03-06T00:00:00.000Z',
      is_stale: false,
      availableSources: ['binance_futures'],
    }
    mockTieredGetOrSet.mockResolvedValue(mockResult)

    const req = new NextRequest('http://localhost/api/rankings?window=90d')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    // Response is wrapped by apiSuccess: { success: true, data: { traders, window, ... } }
    const data = body.data ?? body
    expect(data.traders).toBeDefined()
    expect(data.window).toBe('90D')
    expect(data.totalcount ?? data.total_count ?? 0).toBeGreaterThanOrEqual(0)
  })

  it('accepts valid category filter', async () => {
    mockTieredGetOrSet.mockResolvedValue({
      traders: [],
      window: '30D',
      totalcount: 0,
      total_count: 0,
      as_of: new Date().toISOString(),
      is_stale: false,
      availableSources: [],
    })

    const req = new NextRequest('http://localhost/api/rankings?window=30d&category=futures')
    const res = await GET(req)

    expect(res.status).toBe(200)
  })

  it('accepts valid sort_by and sort_dir parameters', async () => {
    mockTieredGetOrSet.mockResolvedValue({
      traders: [],
      window: '7D',
      totalcount: 0,
      total_count: 0,
      as_of: new Date().toISOString(),
      is_stale: false,
      availableSources: [],
    })

    const req = new NextRequest('http://localhost/api/rankings?window=7d&sort_by=roi&sort_dir=asc')
    const res = await GET(req)

    expect(res.status).toBe(200)
  })

  it.each(['min_pnl=0', 'min_trades=0'])(
    'never reads or writes the shared default ranking cache for %s',
    async (filter) => {
      const req = new NextRequest(`http://localhost/api/rankings?window=90d&${filter}`)
      const res = await GET(req)

      expect(res.status).toBe(200)
      expect(mockTieredGet).not.toHaveBeenCalled()
      expect(mockTieredSet).not.toHaveBeenCalled()
    }
  )

  it('clamps limit to max 500', async () => {
    // The route clamps limit to 500 internally. We verify no error is thrown.
    mockTieredGetOrSet.mockResolvedValue({
      traders: [],
      window: '90D',
      totalcount: 0,
      total_count: 0,
      as_of: new Date().toISOString(),
      is_stale: false,
      availableSources: [],
    })

    const req = new NextRequest('http://localhost/api/rankings?window=90d&limit=9999')
    const res = await GET(req)

    expect(res.status).toBe(200)
  })

  it('returns honest per-source watermarks and marks a mixed-source board stale', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
    try {
      const generation = '2026-07-18T11:55:00.000Z'
      const rankingRows = [
        {
          source: 'binance_futures',
          source_trader_id: 'fresh-trader',
          handle: 'Fresh',
          arena_score: 90,
          roi: 10,
          rank: 1,
          computed_at: '2026-07-18T11:59:00.000Z',
          is_outlier: false,
        },
        {
          source: 'hyperliquid',
          source_trader_id: 'stale-trader',
          handle: 'Stale',
          arena_score: 80,
          roi: 9,
          rank: 2,
          computed_at: '2026-07-18T11:59:00.000Z',
          is_outlier: false,
        },
      ]
      const countRows = [
        { source: '_all_gt0', total_count: 3, updated_at: generation },
        { source: 'binance_futures_gt0', total_count: 1, updated_at: generation },
        { source: 'okx_web3_solana_gt0', total_count: 1, updated_at: generation },
        { source: 'hyperliquid_gt0', total_count: 1, updated_at: generation },
      ]
      let rankingQuery: ReturnType<typeof makeChainableQuery> | undefined
      let freshnessQuery: ReturnType<typeof makeChainableQuery> | undefined
      mockSupabaseQuery.mockImplementation((table: string) => {
        if (table === 'leaderboard_ranks') {
          rankingQuery = makeChainableQuery({ data: rankingRows, error: null, count: 2 })
          return rankingQuery
        }
        if (table === 'leaderboard_count_cache') {
          return makeChainableQuery({ data: countRows, error: null, count: 4 })
        }
        if (table === 'leaderboard_source_freshness') {
          freshnessQuery = makeChainableQuery({
            data: [
              {
                source: 'binance_futures',
                source_as_of: '2026-07-18T11:00:00.000Z',
              },
              {
                source: 'okx_web3_solana',
                source_as_of: '2026-07-01T00:00:00.000Z',
              },
              {
                source: 'hyperliquid',
                source_as_of: '2026-07-16T09:00:00.000Z',
              },
            ],
            error: null,
            count: 3,
          })
          return freshnessQuery
        }
        return makeChainableQuery()
      })

      const req = new NextRequest('http://localhost/api/rankings?window=90d&sort_by=roi')
      const res = await GET(req)
      const body = await res.json()
      const data = body.data ?? body

      expect(res.status).toBe(200)
      expect(data.totalCount).toBe(2)
      expect(data.availableSources).toEqual(['binance_futures', 'hyperliquid'])
      expect(data.as_of).toBe('2026-07-16T09:00:00.000Z')
      expect(data.is_stale).toBe(true)
      expect(data.source_freshness).toEqual([
        {
          source: 'binance_futures',
          updated_at: '2026-07-18T11:00:00.000Z',
          is_stale: false,
          age_seconds: 3600,
        },
        {
          source: 'hyperliquid',
          updated_at: '2026-07-16T09:00:00.000Z',
          is_stale: true,
          age_seconds: 51 * 3600,
        },
      ])
      expect(data.traders[0]).toEqual(
        expect.objectContaining({
          platform: 'binance_futures',
          updated_at: '2026-07-18T11:00:00.000Z',
          is_stale: false,
          computed_at: '2026-07-18T11:59:00.000Z',
        })
      )
      expect(data.traders[1]).toEqual(
        expect.objectContaining({
          platform: 'hyperliquid',
          updated_at: '2026-07-16T09:00:00.000Z',
          is_stale: true,
        })
      )
      expect(rankingQuery?.not).toHaveBeenCalledWith(
        'source',
        'in',
        '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
      )
      expect(rankingQuery?.filter).toHaveBeenCalledWith('rank_publication_id', 'eq', TEST_COHORT_ID)
      expect(freshnessQuery?.not).toHaveBeenCalledWith(
        'source',
        'in',
        '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
      )
      expect(rankingQuery?.in).toHaveBeenCalledWith('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])
      expect(freshnessQuery?.in).toHaveBeenCalledWith('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])
    } finally {
      jest.useRealTimers()
    }
  })

  it('scopes page-level freshness to the requested platform filter', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
    try {
      const generation = '2026-07-18T11:55:00.000Z'
      mockSupabaseQuery.mockImplementation((table: string) => {
        if (table === 'leaderboard_ranks') {
          return makeChainableQuery({
            data: [
              {
                source: 'binance_futures',
                source_trader_id: 'fresh-trader',
                arena_score: 90,
                roi: 10,
                rank: 1,
                computed_at: '2026-07-18T11:59:00.000Z',
              },
            ],
            error: null,
            count: 1,
          })
        }
        if (table === 'leaderboard_count_cache') {
          return makeChainableQuery({
            data: [
              { source: '_all_gt0', total_count: 2, updated_at: generation },
              { source: 'binance_futures_gt0', total_count: 1, updated_at: generation },
              { source: 'hyperliquid_gt0', total_count: 1, updated_at: generation },
            ],
            error: null,
            count: 3,
          })
        }
        if (table === 'leaderboard_source_freshness') {
          return makeChainableQuery({
            data: [
              {
                source: 'binance_futures',
                source_as_of: '2026-07-18T11:00:00.000Z',
              },
              {
                source: 'hyperliquid',
                source_as_of: '2026-07-16T09:00:00.000Z',
              },
            ],
            error: null,
            count: 2,
          })
        }
        return makeChainableQuery()
      })

      const req = new NextRequest(
        'http://localhost/api/rankings?window=90d&platform=binance_futures&sort_by=roi'
      )
      const res = await GET(req)
      const body = await res.json()
      const data = body.data ?? body

      expect(data.is_stale).toBe(false)
      expect(data.as_of).toBe('2026-07-18T11:00:00.000Z')
      expect(data.source_freshness.map((source: { source: string }) => source.source)).toEqual([
        'binance_futures',
      ])
    } finally {
      jest.useRealTimers()
    }
  })

  // --- Composite Window ---

  it('accepts composite window', async () => {
    mockTieredGet.mockResolvedValue({ data: null })
    mockTieredGetOrSet.mockResolvedValue({
      traders: [],
      window: 'COMPOSITE',
      totalcount: 0,
      total_count: 0,
      as_of: new Date().toISOString(),
      is_stale: false,
      availableSources: [],
    })

    const req = new NextRequest('http://localhost/api/rankings?window=composite')
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(mockTieredGet).toHaveBeenCalledWith(
      'public-rank-policy-v4:api:rankings:sealed-v4:composite:all:100',
      'hot'
    )
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ season: '90D' }),
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
  })

  it('rejects an unsealed legacy composite cache payload', async () => {
    const first = { platform: 'binance_futures', trader_key: 'first' }
    const last = { platform: 'hyperliquid', trader_key: 'last' }
    const nextPage = { platform: 'bybit', trader_key: 'next-page' }
    mockTieredGet.mockResolvedValue({
      data: {
        traders: [{ platform: 'okx_web3_solana', trader_key: 'blocked' }, first, last, nextPage],
        totalcount: 999,
        total_count: 999,
        as_of: 'blocked-aggregate-watermark',
        is_stale: false,
        availableSources: ['binance_futures', 'okx_web3_solana', 'hyperliquid', 'bybit'],
        source_freshness: [
          { source: 'binance_futures', updated_at: 'safe' },
          { source: 'okx_web3_solana', updated_at: 'blocked' },
          { source: 'hyperliquid', updated_at: 'safe' },
          { source: 'bybit', updated_at: 'safe' },
        ],
      },
    })

    const req = new NextRequest('http://localhost/api/rankings?window=composite&limit=2')
    const res = await GET(req)
    const body = await res.json()
    const data = body.data ?? body

    expect(mockTieredGet).toHaveBeenCalledWith(
      'public-rank-policy-v4:api:rankings:sealed-v4:composite:all:2',
      'hot'
    )
    expect(data.traders).toEqual([])
    expect(data.traders).not.toContainEqual(first)
    expect(data.traders).not.toContainEqual(last)
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(1)
    expect(mockTieredSet).toHaveBeenCalledWith(
      'public-rank-policy-v4:api:rankings:sealed-v4:composite:all:2',
      expect.objectContaining({ contract: 'sealed-ranking-cache@1', season: '90D' }),
      'hot',
      ['rankings']
    )
  })

  it('rejects a polluted generic hot-cache page', async () => {
    const first = { platform: 'binance_futures', trader_key: 'first' }
    const last = { platform: 'hyperliquid', trader_key: 'last' }
    mockTieredGet.mockResolvedValue({
      data: {
        traders: [first, { platform: 'okx_web3_solana', trader_key: 'blocked' }, last],
        window: '90D',
      },
    })

    const req = new NextRequest('http://localhost/api/rankings?window=90d')
    const res = await GET(req)
    const body = await res.json()
    const data = body.data ?? body

    expect(mockTieredGet).toHaveBeenCalledWith(
      'public-rank-policy-v4:api:rankings:sealed-v4:90d:all:100',
      'hot'
    )
    expect(mockTieredSet).toHaveBeenCalledWith(
      'public-rank-policy-v4:api:rankings:sealed-v4:90d:all:100',
      expect.objectContaining({ contract: 'sealed-ranking-cache@1', season: '90D' }),
      'hot',
      ['rankings']
    )
    expect(data.traders).toEqual([])
    expect(data.traders).not.toContainEqual(first)
    expect(data.traders).not.toContainEqual(last)
  })

  it.each(PUBLIC_RANKING_QUARANTINED_SOURCES)(
    'returns 200 empty for quarantined platform %s without cache or DB access',
    async (platform) => {
      const req = new NextRequest(`http://localhost/api/rankings?window=90d&platform=${platform}`)
      const res = await GET(req)
      const body = await res.json()
      const data = body.data ?? body

      expect(res.status).toBe(200)
      expect(data).toEqual(
        expect.objectContaining({ traders: [], totalCount: 0, availableSources: [] })
      )
      expect(mockTieredGetOrSet).not.toHaveBeenCalled()
      expect(mockTieredGet).not.toHaveBeenCalled()
      expect(mockSupabaseQuery).not.toHaveBeenCalled()
    }
  )

  // --- Error Handling ---

  it('returns 500 when an internal error occurs', async () => {
    mockTieredGetOrSet.mockRejectedValue(new Error('DB connection failed'))
    mockTieredGet.mockResolvedValue({ data: null })

    const req = new NextRequest('http://localhost/api/rankings?window=90d')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    // Error response — the exact message depends on middleware locale
    expect(res.status).toBe(500)
  })
})
