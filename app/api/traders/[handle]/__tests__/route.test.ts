/**
 * /api/traders/[handle] route tests
 *
 * Tests the trader detail API: input validation, 404 handling,
 * cache behavior, and error handling.
 */

// --- Mocks (must be before imports) ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    _headers: Map<string, string>

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
      this._headers = new Map(Object.entries(init.headers || {}))
    }

    get headers() {
      return {
        get: (key: string) => this._headers.get(key) || null,
        set: (key: string, value: string) => this._headers.set(key, value),
      }
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
    _headers: Map<string, string>
    method: string
    cookies: { get: () => undefined }

    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
      this._headers = new Map([['user-agent', 'Mozilla/5.0 (Test)']])
      this.method = 'GET'
      this.cookies = { get: () => undefined }
    }
    get headers() {
      const h = this._headers
      return { get: (key: string) => h.get(key) || null }
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({})),
  })),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => ({})),
  })),
}))

jest.mock('@/lib/api', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { public: {}, authenticated: {} },
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { public: {}, authenticated: {} },
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

const mockResolveTrader = jest.fn().mockResolvedValue(null)
const mockGetTraderDetail = jest.fn().mockResolvedValue(null)
const mockToTraderPageData = jest
  .fn()
  .mockReturnValue({ performance: null, profile: null, equityCurve: null })

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
  getTraderDetail: (...args: unknown[]) => mockGetTraderDetail(...args),
  toTraderPageData: (...args: unknown[]) => mockToTraderPageData(...args),
}))

const mockGetServerCache = jest.fn().mockReturnValue(null)
const mockSetServerCache = jest.fn()

jest.mock('@/lib/utils/server-cache', () => ({
  getServerCache: (...args: unknown[]) => mockGetServerCache(...args),
  setServerCache: (...args: unknown[]) => mockSetServerCache(...args),
  CacheTTL: { SHORT: 60, MEDIUM: 300, LONG: 3600 },
}))

jest.mock('@/lib/utils/arena-score', () => ({
  calculateArenaScore: jest.fn().mockReturnValue(75),
  calculateOverallScore: jest.fn().mockReturnValue(80),
}))

jest.mock('@/lib/utils/logger', () => {
  const inst = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  }
  return {
    createLogger: jest.fn(() => inst),
    logger: inst,
    fireAndForget: jest.fn(),
    captureError: jest.fn(),
    captureMessage: jest.fn(),
  }
})

jest.mock('@/lib/constants/exchanges', () => ({
  ALL_SOURCES: ['binance_futures', 'bybit', 'okx_futures', 'hyperliquid'],
}))

jest.mock('@/lib/data/linked-traders', () => ({
  getAggregatedStats: jest.fn().mockResolvedValue(null),
  findUserByTrader: jest.fn().mockResolvedValue(null),
}))

const mockVerifyCronSecret = jest.fn().mockReturnValue(false)
jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: (...args: unknown[]) => mockVerifyCronSecret(...args),
}))

const mockTieredGetOrSet = jest.fn(async (_key: string, fetcher: () => unknown) => fetcher())
const mockTieredDel = jest.fn()
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
  tieredDel: (...args: unknown[]) => mockTieredDel(...args),
}))

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
  sealedRankingPublicationIdentity: (publication: unknown) => JSON.stringify(publication),
}))

import { GET } from '../route'
import { createHash } from 'node:crypto'

const TRADER_PAGE_SEASONS = ['7D', '30D', '90D'] as const
const CURRENT_COHORTS = {
  '7D': '11111111-1111-4111-8111-111111111111',
  '30D': '22222222-2222-4222-8222-222222222222',
  '90D': '33333333-3333-4333-8333-333333333333',
} as const

function publicationFor(
  season: (typeof TRADER_PAGE_SEASONS)[number],
  scoreCohortId = CURRENT_COHORTS[season]
) {
  return {
    state: 'sealed' as const,
    season,
    scoreCohortId,
    proofs: [
      {
        season_id: season,
        source: 'binance_futures',
        source_as_of: '2026-07-29T09:00:00.000000Z',
        recorded_at: '2026-07-29T09:01:00.000000Z',
        score_cohort_id: scoreCohortId,
        rank_mutation_seq: 9,
        current_mutation_seq: 9,
        published_rank_count: 1,
        published_identity_sha256: 'a'.repeat(64),
        is_sealed: true as const,
      },
    ],
  }
}

function rankingPublicationReads() {
  return TRADER_PAGE_SEASONS.map((season) => {
    const publication = publicationFor(season)
    return { publication, publicationIdentity: JSON.stringify(publication) }
  })
}

function sealedTraderPageCache(
  value: { pageData: unknown; resolved: { platform: string; traderKey: string } },
  cohortOverrides: Partial<Record<(typeof TRADER_PAGE_SEASONS)[number], string>> = {}
) {
  const valueSha256 = createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const binding = {
    contract: 'sealed-trader-page-binding@1',
    platform: value.resolved.platform,
    traderKey: value.resolved.traderKey,
    valueSha256,
  }
  return {
    contract: 'sealed-trader-page-cache@1',
    value,
    windows: Object.fromEntries(
      TRADER_PAGE_SEASONS.map((season) => {
        const publication = publicationFor(season, cohortOverrides[season])
        return [
          season,
          {
            contract: 'sealed-ranking-cache@1',
            season,
            publicationIdentity: JSON.stringify(publication),
            publication,
            cachedAt: '2026-07-29T09:02:00.000Z',
            value: binding,
          },
        ]
      })
    ),
  }
}

/** Build a minimal mock request with headers needed by withApiMiddleware. */
function mockReq(url: string, authorization?: string) {
  return {
    nextUrl: new URL(url),
    method: 'GET',
    headers: {
      get: (key: string) => {
        if (key === 'user-agent') return 'Mozilla/5.0 (Jest Test Runner)'
        if (key === 'authorization') return authorization || null
        return null
      },
    },
    cookies: { get: () => undefined },
  }
}

describe('GET /api/traders/[handle]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredDel.mockResolvedValue(undefined)
    mockTieredGetOrSet.mockImplementation(async (_key: string, fetcher: () => unknown) => fetcher())
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _supabase: unknown,
        input: { season: (typeof TRADER_PAGE_SEASONS)[number] },
        reader: (publication: ReturnType<typeof publicationFor>) => Promise<unknown>
      ) => {
        const publication = publicationFor(input.season)
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
    mockGetServerCache.mockReturnValue(null)
    mockResolveTrader.mockResolvedValue(null)
    mockGetTraderDetail.mockResolvedValue(null)
    mockVerifyCronSecret.mockReturnValue(false)
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  // --- Input Validation ---

  it('returns 400 for empty handle', async () => {
    const request = mockReq('http://localhost/api/traders/')
    const params = Promise.resolve({ handle: '' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(400)
    // handleError wraps ApiError.validation into { success: false, error: { code, message, ... } }
    const errMsg = body.error?.message ?? body.error
    expect(errMsg).toMatch(/Invalid handle parameter/)
  })

  it('returns 400 for handle exceeding max length', async () => {
    const longHandle = 'a'.repeat(256)
    const request = mockReq(`http://localhost/api/traders/${longHandle}`)
    const params = Promise.resolve({ handle: longHandle })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(400)
    const errMsg = body.error?.message ?? body.error
    expect(errMsg).toMatch(/Invalid handle parameter/)
  })

  it('accepts single character handle (valid)', async () => {
    const request = mockReq('http://localhost/api/traders/x')
    const params = Promise.resolve({ handle: 'x' })

    const res = await GET(request as any, { params })
    // Should not be 400 (it'll be 404 since resolveTrader returns null)
    expect(res.status).not.toBe(400)
  })

  it('accepts 0x-prefixed address handle', async () => {
    const request = mockReq('http://localhost/api/traders/0x1234abcd')
    const params = Promise.resolve({ handle: '0x1234abcd' })

    const res = await GET(request as any, { params })
    expect(res.status).not.toBe(400)
  })

  // --- 404 Not Found ---

  it('returns 404 when trader is not found', async () => {
    mockResolveTrader.mockResolvedValue(null)

    const request = mockReq('http://localhost/api/traders/nonexistent')
    const params = Promise.resolve({ handle: 'nonexistent' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(404)
    const errMsg = body.error?.message ?? body.error
    expect(errMsg).toMatch(/not found/i)
  })

  it('returns 404 with proper error structure', async () => {
    mockResolveTrader.mockResolvedValue(null)

    const request = mockReq('http://localhost/api/traders/ghost')
    const params = Promise.resolve({ handle: 'ghost' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(404)
    // withApiMiddleware's createErrorResponse returns { success: false, error: <string> }
    expect(body.success).toBe(false)
    expect(body.error).toBeDefined()
    expect(typeof body.error === 'string' || body.error?.code === 'NOT_FOUND').toBe(true)
  })

  // --- Cache Hit ---

  it('returns 200 when data is found via tieredGetOrSet', async () => {
    const pageData = {
      performance: { roi: 42.5 },
      profile: { handle: 'CachedTrader' },
    }
    mockResolveTrader.mockResolvedValueOnce({
      platform: 'binance_futures',
      traderKey: 'trader123',
    })
    mockTieredGetOrSet.mockResolvedValueOnce(
      sealedTraderPageCache({
        pageData,
        resolved: { platform: 'binance_futures', traderKey: 'trader123' },
      })
    )

    const request = mockReq('http://localhost/api/traders/CachedTrader')
    const params = Promise.resolve({ handle: 'CachedTrader' })

    const res = await GET(request as any, { params })

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(res.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(res.headers.get('X-Arena-Consistency-Proof')).toBeNull()
    expect(mockResolveTrader).toHaveBeenCalledTimes(1)
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(3)
    expect(mockGetTraderDetail).not.toHaveBeenCalled()
  })

  it('evicts a cached trader page after any ranking window advances cohort', async () => {
    const oldValue = {
      pageData: { performance: { roi: -999 }, profile: { handle: 'Old Cache' } },
      resolved: { platform: 'binance_futures', traderKey: 'trader123' },
    }
    mockResolveTrader.mockResolvedValueOnce(oldValue.resolved)
    mockTieredGetOrSet
      .mockResolvedValueOnce(
        sealedTraderPageCache(oldValue, {
          '90D': '44444444-4444-4444-8444-444444444444',
        })
      )
      .mockImplementation(async (_key: string, fetcher: () => unknown) => fetcher())
    mockGetTraderDetail.mockImplementationOnce(async (_supabase: unknown, params: any) => {
      params.onRankingPublications(rankingPublicationReads())
      return { trader: {} }
    })
    mockToTraderPageData.mockReturnValueOnce({
      performance: { roi: 42.5 },
      profile: { handle: 'Current Trader' },
    })

    const request = mockReq('http://localhost/api/traders/CurrentTrader')
    const res = await GET(request as any, {
      params: Promise.resolve({ handle: 'CurrentTrader' }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.profile.handle).toBe('Current Trader')
    expect(JSON.stringify(body)).not.toContain('Old Cache')
    expect(mockTieredDel).toHaveBeenCalledWith(
      expect.stringContaining('trader:sealed-v2:binance_futures:trader123')
    )
    expect(mockTieredGetOrSet).toHaveBeenCalledTimes(2)
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(6)
  })

  it('rejects a cache value when the requested handle now resolves to another trader', async () => {
    const currentIdentity = { platform: 'binance_futures', traderKey: 'trader-new' }
    mockResolveTrader.mockResolvedValueOnce(currentIdentity)
    mockTieredGetOrSet
      .mockResolvedValueOnce(
        sealedTraderPageCache({
          pageData: { profile: { handle: 'Former Owner' } },
          resolved: { platform: 'binance_futures', traderKey: 'trader-old' },
        })
      )
      .mockImplementation(async (_key: string, fetcher: () => unknown) => fetcher())
    mockGetTraderDetail.mockImplementationOnce(async (_supabase: unknown, params: any) => {
      params.onRankingPublications(rankingPublicationReads())
      return { trader: {} }
    })
    mockToTraderPageData.mockReturnValueOnce({ profile: { handle: 'Current Owner' } })

    const res = await GET(mockReq('http://localhost/api/traders/shared-handle') as any, {
      params: Promise.resolve({ handle: 'shared-handle' }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.profile.handle).toBe('Current Owner')
    expect(JSON.stringify(body)).not.toContain('Former Owner')
    expect(mockTieredDel).toHaveBeenCalledWith(
      expect.stringContaining('trader:sealed-v2:binance_futures:trader-new')
    )
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(3)
  })

  it('bypasses both cache tiers only for an authenticated consistency probe', async () => {
    mockVerifyCronSecret.mockReturnValue(true)
    mockResolveTrader.mockResolvedValueOnce({
      platform: 'binance_futures',
      traderKey: 'trader123',
    })
    mockGetTraderDetail.mockResolvedValueOnce({ trader: {} })
    mockToTraderPageData.mockReturnValueOnce({
      performance: { roi_90d: 42.5, pnl: 100, arena_score_90d: 88 },
      profile: { handle: 'FreshTrader' },
    })

    const request = mockReq(
      'http://localhost/api/traders/FreshTrader?source=binance_futures&consistency_probe=1',
      'Bearer valid-cron-secret'
    )
    const params = Promise.resolve({ handle: 'FreshTrader' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockVerifyCronSecret).toHaveBeenCalledWith(request)
    expect(mockTieredGetOrSet).not.toHaveBeenCalled()
    expect(mockResolveTrader).toHaveBeenCalledTimes(1)
    expect(body.data.consistency_probe).toEqual({
      cache_bypassed: true,
      loader: 'unified-live',
    })
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('Pragma')).toBe('no-cache')
    expect(res.headers.get('X-Arena-Consistency-Proof')).toBe('live-loader-v1')
  })

  it('rejects an invalid consistency probe without touching shared caches', async () => {
    mockVerifyCronSecret.mockReturnValue(false)

    const request = mockReq(
      'http://localhost/api/traders/CachedTrader?source=binance_futures&consistency_probe=1',
      'Bearer invalid-cron-secret'
    )
    const params = Promise.resolve({ handle: 'CachedTrader' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(mockVerifyCronSecret).toHaveBeenCalledWith(request)
    expect(mockTieredGetOrSet).not.toHaveBeenCalled()
    expect(mockResolveTrader).not.toHaveBeenCalled()
    expect(body.error).toMatchObject({ code: 'UNAUTHORIZED' })
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('Pragma')).toBe('no-cache')
    expect(res.headers.get('Vary')).toBe('Authorization')
    expect(res.headers.get('X-Arena-Consistency-Proof')).toBeNull()
  })

  // --- Error Handling ---

  it('returns 500 on unexpected database error', async () => {
    mockResolveTrader.mockRejectedValueOnce(new Error('DB connection lost'))

    const request = mockReq('http://localhost/api/traders/crasher')
    const params = Promise.resolve({ handle: 'crasher' })

    const res = await GET(request as any, { params })

    expect(res.status).toBe(500)
  })

  it('throws when params promise rejects (unhandled before middleware)', async () => {
    const request = mockReq('http://localhost/api/traders/test')
    const params = Promise.reject(new Error('params error'))

    await expect(GET(request as any, { params })).rejects.toThrow('params error')
  })
})
