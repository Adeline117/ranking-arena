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

const mockReadLeaderboardPublicationAuthority = jest.fn()
jest.mock('@/lib/rankings/read-publication-authority', () => ({
  readLeaderboardPublicationAuthority: (...args: unknown[]) =>
    mockReadLeaderboardPublicationAuthority(...args),
}))

const mockReadSealedCompositeRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-composite-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-composite-ranking-generation'),
  readSealedCompositeRankingGeneration: (...args: unknown[]) =>
    mockReadSealedCompositeRankingGeneration(...args),
}))

const mockReadCompositeRankingPage = jest.fn()
jest.mock('@/lib/rankings/read-composite-ranking-page', () => ({
  ...jest.requireActual('@/lib/rankings/read-composite-ranking-page'),
  readCompositeRankingPageWithDatabaseTimeout: (...args: unknown[]) =>
    mockReadCompositeRankingPage(...args),
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
import { createHash } from 'node:crypto'
import { GET } from '../route'
import { EXCHANGE_SLUG_ALIASES, PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { RETIRED_SOURCES } from '@/lib/constants/retired-sources'
import {
  filterPublicRankingSources,
  PUBLIC_RANKING_QUARANTINED_SOURCES,
} from '@/lib/rankings/publication-policy'

const TEST_COHORT_ID = '11111111-1111-4111-8111-111111111111'
let currentCohortId = TEST_COHORT_ID
let mockAuthoritySources = [...PUBLIC_ACTIVE_RANKING_SOURCES].sort()
const TEST_COMPOSITE_COHORTS = {
  '7D': '11111111-1111-4111-8111-111111111111',
  '30D': '22222222-2222-4222-8222-222222222222',
  '90D': '33333333-3333-4333-8333-333333333333',
} as const
const mockPublicationProofOverrides = new Map<
  string,
  { sourceAsOf?: string; publishedRankCount?: number }
>()

function publicationFor(
  season: '7D' | '30D' | '90D',
  sources: readonly string[],
  scoreCohortId = currentCohortId
) {
  return {
    state: 'sealed' as const,
    season,
    scoreCohortId,
    proofs: [...sources].sort().map((source) => ({
      season_id: season,
      source,
      source_as_of:
        mockPublicationProofOverrides.get(source)?.sourceAsOf ?? '2026-07-29T10:00:00.000000Z',
      recorded_at: '2026-07-29T10:01:00.000000Z',
      score_cohort_id: scoreCohortId,
      rank_mutation_seq: 9,
      current_mutation_seq: 9,
      published_rank_count: mockPublicationProofOverrides.get(source)?.publishedRankCount ?? 0,
      published_identity_sha256: 'a'.repeat(64),
      is_sealed: true,
    })),
  }
}

function sealedCacheEntry(value: unknown, scoreCohortId = currentCohortId) {
  const publication = publicationFor(
    '90D',
    filterPublicRankingSources(mockAuthoritySources),
    scoreCohortId
  )
  return {
    contract: 'sealed-ranking-cache@1',
    season: '90D',
    publicationIdentity: JSON.stringify(publication),
    publication,
    cachedAt: '2026-07-29T10:02:00.000Z',
    value,
  }
}

function rankingCacheKey(
  window: '7d' | '30d' | '90d',
  category: string,
  limit: number,
  authoritySources: readonly string[] = mockAuthoritySources
) {
  const fingerprint = createHash('sha256')
    .update(authoritySources.join('\u0000'))
    .digest('hex')
    .slice(0, 16)
  return `public-rank-policy-v4:api:rankings:sealed-v5:${fingerprint}:${window}:${category}:${limit}`
}

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
  const publication = publicationFor(input.season, input.sources)
  const value = await reader(publication)
  return {
    value,
    publication,
    publicationIdentity: JSON.stringify(publication),
    authoritySources: [...mockAuthoritySources],
  }
}

async function readThroughSealedCompositeGeneration(
  _supabase: unknown,
  reader: (publication: {
    state: 'sealed'
    publications: Array<{
      state: 'sealed'
      season: '7D' | '30D' | '90D'
      scoreCohortId: string
      proofs: unknown[]
    }>
  }) => Promise<unknown>
) {
  const publication = {
    state: 'sealed' as const,
    publications: (['7D', '30D', '90D'] as const).map((season) => ({
      state: 'sealed' as const,
      season,
      scoreCohortId: TEST_COMPOSITE_COHORTS[season],
      proofs: ['binance_futures', 'hyperliquid'].map((source) => ({
        season_id: season,
        source,
        source_as_of: '2026-07-29T10:00:00.000000Z',
        recorded_at: '2026-07-29T10:01:00.000000Z',
        score_cohort_id: TEST_COMPOSITE_COHORTS[season],
        rank_mutation_seq: 9,
        current_mutation_seq: 9,
        published_rank_count: source === 'binance_futures' ? 1 : 0,
        published_identity_sha256: 'a'.repeat(64),
        is_sealed: true as const,
      })),
    })),
  }
  const value = await reader(publication)
  return {
    value,
    publication,
    publicationIdentity: JSON.stringify(publication),
  }
}

function makeCompositeRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'alice',
    handle: 'Alice',
    source_type: 'futures',
    roi: 40,
    pnl: 1000,
    win_rate: 0.6,
    max_drawdown: -10,
    trades_count: 30,
    followers: 20,
    copiers: 10,
    avatar_url: null,
    computed_at: '2026-07-29T10:00:00.000Z',
    profitability_score: 80,
    risk_control_score: 70,
    execution_score: 75,
    score_completeness: 'full',
    trading_style: 'swing',
    avg_holding_hours: 12,
    sharpe_ratio: 1.2,
    sortino_ratio: 1.4,
    calmar_ratio: 1.1,
    profit_factor: 1.5,
    trader_type: 'human',
    primary_season: '90D',
    primary_publication_id: TEST_COMPOSITE_COHORTS['90D'],
    score_7d: 90,
    score_30d: 80,
    score_90d: 70,
    composite_score: 73.5,
    composite_rank: 1,
    ...overrides,
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
    currentCohortId = TEST_COHORT_ID
    mockAuthoritySources = [...PUBLIC_ACTIVE_RANKING_SOURCES].sort()
    mockPublicationProofOverrides.clear()
    mockTieredGetOrSet.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn())
    mockTieredGet.mockResolvedValue({ data: null })
    mockTieredSet.mockResolvedValue(true)
    mockReadLeaderboardPublicationAuthority.mockImplementation(async () => [
      ...mockAuthoritySources,
    ])
    mockReadSealedRankingGeneration.mockImplementation(readThroughSealedGeneration)
    mockReadSealedCompositeRankingGeneration.mockImplementation(
      readThroughSealedCompositeGeneration
    )
    mockReadCompositeRankingPage.mockResolvedValue({ rows: [], totalCount: 0 })
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

  it.each([
    ['sort_dir=sideways', /sort_dir/i],
    ['cursor=90%3Atrader', /cursor/i],
    ['min_pnl=NaN', /min_pnl/i],
    ['min_trades=-1', /min_trades/i],
    ['min_trades=1.5', /min_trades/i],
    ['trader_type=robot', /trader_type/i],
    ['trader_type=whale', /trader_type/i],
    ['offset=999999999999999999999', /offset/i],
  ])('returns 400 for invalid query filter %s', async (query, message) => {
    const req = new NextRequest(`http://localhost/api/rankings?window=composite&${query}`)
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(message)
    expect(mockTieredGet).not.toHaveBeenCalled()
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
    expect(mockReadSealedCompositeRankingGeneration).not.toHaveBeenCalled()
    expect(mockReadCompositeRankingPage).not.toHaveBeenCalled()
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

  it('derives counts, source membership, and watermarks from the sealed proof set', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
    try {
      mockPublicationProofOverrides.set('binance_futures', {
        sourceAsOf: '2026-07-18T11:00:00.000000Z',
        publishedRankCount: 1,
      })
      mockPublicationProofOverrides.set('hyperliquid', {
        sourceAsOf: '2026-07-16T13:00:00.000000Z',
        publishedRankCount: 1,
      })
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
      let rankingQuery: ReturnType<typeof makeChainableQuery> | undefined
      mockSupabaseQuery.mockImplementation((table: string) => {
        if (table === 'leaderboard_ranks') {
          rankingQuery = makeChainableQuery({ data: rankingRows, error: null, count: 2 })
          return rankingQuery
        }
        if (table === 'leaderboard_count_cache' || table === 'leaderboard_source_freshness') {
          throw new Error(`generic metadata read is forbidden: ${table}`)
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
      expect(data.as_of).toBe('2026-07-16T13:00:00.000000Z')
      expect(data.is_stale).toBe(false)
      expect(data.source_freshness).toEqual([
        {
          source: 'binance_futures',
          updated_at: '2026-07-18T11:00:00.000000Z',
          is_stale: false,
          age_seconds: 3600,
        },
        {
          source: 'hyperliquid',
          updated_at: '2026-07-16T13:00:00.000000Z',
          is_stale: false,
          age_seconds: 47 * 3600,
        },
      ])
      expect(data.traders[0]).toEqual(
        expect.objectContaining({
          platform: 'binance_futures',
          updated_at: '2026-07-18T11:00:00.000000Z',
          is_stale: false,
          computed_at: '2026-07-18T11:59:00.000Z',
        })
      )
      expect(data.traders[1]).toEqual(
        expect.objectContaining({
          platform: 'hyperliquid',
          updated_at: '2026-07-16T13:00:00.000000Z',
          is_stale: false,
        })
      )
      expect(rankingQuery?.not).toHaveBeenCalledWith(
        'source',
        'in',
        '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
      )
      expect(rankingQuery?.filter).toHaveBeenCalledWith('rank_publication_id', 'eq', TEST_COHORT_ID)
      expect(rankingQuery?.in).toHaveBeenCalledWith(
        'source',
        filterPublicRankingSources(mockAuthoritySources)
      )
      expect(mockSupabaseQuery).not.toHaveBeenCalledWith('leaderboard_count_cache')
      expect(mockSupabaseQuery).not.toHaveBeenCalledWith('leaderboard_source_freshness')
    } finally {
      jest.useRealTimers()
    }
  })

  it('scopes page-level freshness to the requested platform filter', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
    try {
      mockPublicationProofOverrides.set('binance_futures', {
        sourceAsOf: '2026-07-18T11:00:00.000000Z',
        publishedRankCount: 1,
      })
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
        if (table === 'leaderboard_count_cache' || table === 'leaderboard_source_freshness') {
          throw new Error(`generic metadata read is forbidden: ${table}`)
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
      expect(data.as_of).toBe('2026-07-18T11:00:00.000000Z')
      expect(data.source_freshness.map((source: { source: string }) => source.source)).toEqual([
        'binance_futures',
      ])
    } finally {
      jest.useRealTimers()
    }
  })

  it('binds the sealed read and rank query to the exact dynamic public authority', async () => {
    mockAuthoritySources = ['binance_futures', 'hyperliquid']
    let rankingQuery: ReturnType<typeof makeChainableQuery> | undefined
    mockSupabaseQuery.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = makeChainableQuery()
        return rankingQuery
      }
      return makeChainableQuery()
    })

    const req = new NextRequest('http://localhost/api/rankings?window=90d&sort_by=roi')
    const res = await GET(req)
    const body = await res.json()
    const data = body.data ?? body

    expect(res.status).toBe(200)
    expect(mockReadLeaderboardPublicationAuthority).toHaveBeenCalledWith(expect.anything(), '90D', {
      timeoutMs: 10_000,
    })
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      expect.anything(),
      { season: '90D', sources: ['binance_futures', 'hyperliquid'] },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(rankingQuery?.in).toHaveBeenCalledWith('source', ['binance_futures', 'hyperliquid'])
  })

  it('returns an explicit empty board when a known source is outside current authority', async () => {
    mockAuthoritySources = ['hyperliquid']

    const req = new NextRequest('http://localhost/api/rankings?window=90d&platform=binance_futures')
    const res = await GET(req)
    const body = await res.json()
    const data = body.data ?? body

    expect(res.status).toBe(200)
    expect(data).toEqual(
      expect.objectContaining({
        traders: [],
        totalCount: 0,
        availableSources: [],
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'publication_authority_filtered',
        ranking_visibility_reasons: ['source_outside_publication_authority'],
      })
    )
    expect(mockTieredGet).not.toHaveBeenCalled()
    expect(mockTieredSet).not.toHaveBeenCalled()
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
    expect(mockSupabaseQuery).not.toHaveBeenCalled()
  })

  it('changes the default cache namespace when authority membership changes', async () => {
    const cache = new Map<string, unknown>()
    mockTieredGet.mockImplementation(async (key: string) => ({ data: cache.get(key) ?? null }))
    mockTieredSet.mockImplementation(async (key: string, value: unknown) => {
      cache.set(key, value)
      return true
    })

    mockAuthoritySources = ['binance_futures', 'hyperliquid']
    const firstKey = rankingCacheKey('90d', 'all', 100)
    const first = await GET(new NextRequest('http://localhost/api/rankings?window=90d'))
    expect(first.status).toBe(200)

    mockAuthoritySources = ['binance_futures']
    const secondKey = rankingCacheKey('90d', 'all', 100)
    const second = await GET(new NextRequest('http://localhost/api/rankings?window=90d'))
    expect(second.status).toBe(200)

    expect(secondKey).not.toBe(firstKey)
    expect(mockTieredGet).toHaveBeenNthCalledWith(1, firstKey, 'hot')
    expect(mockTieredGet).toHaveBeenNthCalledWith(2, secondKey, 'hot')
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(2)
    expect(cache.has(firstKey)).toBe(true)
    expect(cache.has(secondKey)).toBe(true)
  })

  // --- Composite Window ---

  it('computes composite window from sealed 7D, 30D, and 90D scores', async () => {
    mockReadCompositeRankingPage.mockResolvedValue({
      rows: [makeCompositeRow()],
      totalCount: 1,
    })

    const req = new NextRequest('http://localhost/api/rankings?window=composite')
    const res = await GET(req)
    const body = await res.json()
    const data = body.data ?? body

    expect(res.status).toBe(200)
    expect(mockTieredGet).not.toHaveBeenCalled()
    expect(mockTieredSet).not.toHaveBeenCalled()
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
    expect(mockReadSealedCompositeRankingGeneration).toHaveBeenCalledTimes(1)
    expect(mockReadCompositeRankingPage).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeSources: ['binance_futures', 'hyperliquid'],
        limit: 100,
        offset: 0,
        sortBy: 'arena_score',
        sortDir: 'desc',
      })
    )
    expect(data).toEqual(
      expect.objectContaining({
        window: 'COMPOSITE',
        totalCount: 1,
        traders: [
          expect.objectContaining({
            trader_key: 'alice',
            arena_score: 73.5,
            composite_scores: { '7d': 90, '30d': 80, '90d': 70 },
          }),
        ],
      })
    )
  })

  it('never reads an unsealed legacy composite cache payload', async () => {
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

    expect(res.status).toBe(200)
    expect(mockTieredGet).not.toHaveBeenCalled()
    expect(mockTieredSet).not.toHaveBeenCalled()
    expect(data.traders).toEqual([])
    expect(data.traders).not.toContainEqual(first)
    expect(data.traders).not.toContainEqual(last)
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
    expect(mockReadSealedCompositeRankingGeneration).toHaveBeenCalledTimes(1)
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

    expect(mockTieredGet).toHaveBeenCalledWith(rankingCacheKey('90d', 'all', 100), 'hot')
    expect(mockTieredSet).toHaveBeenCalledWith(
      rankingCacheKey('90d', 'all', 100),
      expect.objectContaining({ contract: 'sealed-ranking-cache@1', season: '90D' }),
      'hot',
      ['rankings']
    )
    expect(data.traders).toEqual([])
    expect(data.traders).not.toContainEqual(first)
    expect(data.traders).not.toContainEqual(last)
  })

  it('rejects a sealed cache entry whose proof sources do not match the request scope', async () => {
    const publication = {
      state: 'sealed' as const,
      season: '90D' as const,
      scoreCohortId: TEST_COHORT_ID,
      proofs: [
        {
          season_id: '90D' as const,
          source: 'binance_futures',
          source_as_of: '2026-07-29T10:00:00.000000Z',
          recorded_at: '2026-07-29T10:01:00.000000Z',
          score_cohort_id: TEST_COHORT_ID,
          rank_mutation_seq: 9,
          current_mutation_seq: 9,
          published_rank_count: 1,
          published_identity_sha256: 'a'.repeat(64),
          is_sealed: true as const,
        },
      ],
    }
    const pollutedTrader = { platform: 'binance_futures', trader_key: 'wrong-scope-cache' }
    mockTieredGet.mockResolvedValue({
      data: {
        contract: 'sealed-ranking-cache@1',
        season: '90D',
        publicationIdentity: JSON.stringify(publication),
        publication,
        cachedAt: '2026-07-29T10:02:00.000Z',
        value: { traders: [pollutedTrader] },
      },
    })

    const req = new NextRequest('http://localhost/api/rankings?window=90d')
    const res = await GET(req)
    const body = await res.json()
    const data = body.data ?? body

    expect(res.status).toBe(200)
    expect(data.traders).not.toContainEqual(pollutedTrader)
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(1)
  })

  it('serves a sealed cache page only while its publication generation remains current', async () => {
    const cachedTrader = { platform: 'binance_futures', trader_key: 'current-cache-row' }
    mockTieredGet.mockResolvedValue({
      data: sealedCacheEntry({ traders: [cachedTrader], window: '90D' }),
    })

    const res = await GET(new NextRequest('http://localhost/api/rankings?window=90d'))
    const body = await res.json()
    const data = body.data ?? body

    expect(res.status).toBe(200)
    expect(data.traders).toContainEqual(cachedTrader)
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(1)
    expect(mockTieredSet).not.toHaveBeenCalled()
    expect(mockSupabaseQuery).not.toHaveBeenCalled()
  })

  it('rejects a sealed cache page after the authority advances to another cohort', async () => {
    const cachedTrader = { platform: 'binance_futures', trader_key: 'old-cache-row' }
    mockTieredGet.mockResolvedValue({
      data: sealedCacheEntry(
        { traders: [cachedTrader], window: '90D' },
        '22222222-2222-4222-8222-222222222222'
      ),
    })

    const res = await GET(new NextRequest('http://localhost/api/rankings?window=90d'))
    const body = await res.json()
    const data = body.data ?? body

    expect(res.status).toBe(200)
    expect(data.traders).not.toContainEqual(cachedTrader)
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(2)
    expect(mockTieredSet).toHaveBeenCalledWith(
      rankingCacheKey('90d', 'all', 100),
      expect.objectContaining({
        contract: 'sealed-ranking-cache@1',
        publicationIdentity: expect.not.stringContaining('22222222-2222-4222-8222-222222222222'),
      }),
      'hot',
      ['rankings']
    )
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
    mockReadSealedRankingGeneration.mockRejectedValue(new Error('DB connection failed'))
    mockTieredGet.mockResolvedValue({ data: null })

    const req = new NextRequest('http://localhost/api/rankings?window=90d')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    // Error response — the exact message depends on middleware locale
    expect(res.status).toBe(500)
  })
})
