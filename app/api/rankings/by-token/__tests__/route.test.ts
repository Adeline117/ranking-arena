/** @jest-environment node */

jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockCheckRateLimit = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
jest.mock('@/lib/api', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: {} },
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

const mockTieredGetOrSet = jest.fn()
const mockTieredDel = jest.fn()
const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
  tieredDel: (...args: unknown[]) => mockTieredDel(...args),
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
}))

const mockReadSealedTokenTraderRankings = jest.fn()
jest.mock('@/lib/rankings/token-traders', () => ({
  getTokenTraderRankingCacheKey: (token: string, period: string, limit: number, offset: number) =>
    `rankings:by-token:v5:${token}:${period}:${limit}:${offset}`,
  readSealedTokenTraderRankings: (...args: unknown[]) => mockReadSealedTokenTraderRankings(...args),
}))

const mockReadSealedRankingAuthorityGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

const CURRENT_COHORT_ID = '11111111-1111-4111-8111-111111111111'

function publicationFor(scoreCohortId = CURRENT_COHORT_ID) {
  return {
    state: 'sealed' as const,
    season: '90D' as const,
    scoreCohortId,
    proofs: [
      {
        season_id: '90D' as const,
        source: 'hyperliquid',
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

function tokenTrader(id: string) {
  return {
    source: 'hyperliquid',
    source_trader_id: id,
    handle: id,
    avatar_url: null,
    arena_score: 80,
    roi: 20,
    total_pnl: 100,
    token_pnl: 10,
    token_trade_count: 2,
    token_win_rate: 50,
    token_avg_pnl_pct: 5,
  }
}

function cacheEntry(id: string, scoreCohortId = CURRENT_COHORT_ID) {
  const publication = publicationFor(scoreCohortId)
  return {
    contract: 'sealed-ranking-cache@1',
    season: '90D',
    publicationIdentity: JSON.stringify(publication),
    publication,
    cachedAt: '2026-07-29T09:02:00.000Z',
    value: {
      traders: [tokenTrader(id)],
      token: 'BTC',
      period: '90D',
      limit: 25,
      offset: 0,
      total: 1,
    },
  }
}

import { GET } from '../route'

function request() {
  return {
    nextUrl: new URL(
      'http://localhost/api/rankings/by-token?token=BTC&period=90D&limit=25&offset=0'
    ),
  } as never
}

function popularRequest() {
  return {
    nextUrl: new URL('http://localhost/api/rankings/by-token?action=popular-tokens'),
  } as never
}

const popularTokens = [{ token: 'BTC', trade_count: 10, trader_count: 3, total_pnl: 100 }]

describe('GET /api/rankings/by-token publication cache', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetSupabaseAdmin.mockReturnValue({})
    mockTieredDel.mockResolvedValue(undefined)
    mockTieredGet.mockResolvedValue({ data: null, layer: null })
    mockTieredSet.mockResolvedValue(true)
    mockTieredGetOrSet.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) =>
      fetcher()
    )
    mockReadSealedTokenTraderRankings.mockImplementation(async () => {
      const publication = publicationFor()
      return {
        value: { traders: [tokenTrader('current-row')], total: 1 },
        publication,
        publicationIdentity: JSON.stringify(publication),
      }
    })
    mockReadSealedRankingAuthorityGeneration.mockImplementation(
      async (_client: unknown, _season: unknown, reader: () => Promise<unknown>) => {
        const publication = publicationFor()
        return {
          value: await reader(),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
  })

  it('persists a validated popular-token result as last known good', async () => {
    mockTieredGetOrSet.mockResolvedValueOnce(popularTokens)

    const response = await GET(popularRequest())

    await expect(response.json()).resolves.toEqual({ tokens: popularTokens })
    expect(mockTieredSet).toHaveBeenCalledWith(
      'rankings:popular-tokens:last-good:v1',
      popularTokens,
      'cold',
      ['rankings', 'popular-tokens-last-good'],
      { redisTtlSeconds: 2_592_000, staleWhileRevalidateSeconds: 0 }
    )
  })

  it('serves labelled last-known-good data when the live read fails', async () => {
    mockTieredGetOrSet.mockRejectedValueOnce(new Error('database unavailable'))
    mockTieredGet.mockResolvedValueOnce({ data: popularTokens, layer: 'redis' })

    const response = await GET(popularRequest())

    await expect(response.json()).resolves.toEqual({ tokens: popularTokens, degraded: true })
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Data-Mode')).toBe('last-known-good')
  })

  it('returns a retryable 503 instead of a false empty result without fallback data', async () => {
    mockTieredGetOrSet.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await GET(popularRequest())

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('30')
    await expect(response.json()).resolves.toEqual({
      error: 'Popular token rankings are temporarily unavailable',
    })
  })

  it('bounds a primary read even when the cache transport ignores cancellation', async () => {
    jest.useFakeTimers()
    try {
      mockTieredGetOrSet.mockReturnValueOnce(new Promise(() => undefined))
      const responsePromise = GET(popularRequest())

      await jest.advanceTimersByTimeAsync(12_000)

      const response = await responsePromise
      expect(response.status).toBe(503)
      expect(response.headers.get('Retry-After')).toBe('30')
    } finally {
      jest.useRealTimers()
    }
  })

  it('bounds a hung last-known-good read after the primary fails', async () => {
    jest.useFakeTimers()
    try {
      mockTieredGetOrSet.mockRejectedValueOnce(new Error('database unavailable'))
      mockTieredGet.mockReturnValueOnce(new Promise(() => undefined))
      const responsePromise = GET(popularRequest())

      await jest.advanceTimersByTimeAsync(2_000)

      const response = await responsePromise
      expect(response.status).toBe(503)
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects malformed last-known-good cache data', async () => {
    mockTieredGetOrSet.mockRejectedValueOnce(new Error('database unavailable'))
    mockTieredGet.mockResolvedValueOnce({
      data: [{ token: 'BTC', trade_count: -1, trader_count: 3, total_pnl: 100 }],
      layer: 'redis',
    })

    const response = await GET(popularRequest())

    expect(response.status).toBe(503)
  })

  it('serves a sealed token page only while its publication remains current', async () => {
    mockTieredGetOrSet.mockResolvedValueOnce(cacheEntry('current-cache-row'))

    const response = await GET(request())
    const body = await response.json()

    expect(body.traders).toEqual([
      expect.objectContaining({ source_trader_id: 'current-cache-row' }),
    ])
    expect(body).toMatchObject({ token: 'BTC', period: '90D', limit: 25, offset: 0, total: 1 })
    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledTimes(1)
    expect(mockReadSealedTokenTraderRankings).not.toHaveBeenCalled()
    expect(mockTieredDel).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it('evicts a sealed token page after the authority advances to another cohort', async () => {
    mockTieredGetOrSet
      .mockResolvedValueOnce(cacheEntry('old-cache-row', '22222222-2222-4222-8222-222222222222'))
      .mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) => fetcher())

    const response = await GET(request())
    const body = await response.json()

    expect(body.traders).toEqual([expect.objectContaining({ source_trader_id: 'current-row' })])
    expect(JSON.stringify(body)).not.toContain('old-cache-row')
    expect(mockTieredDel).toHaveBeenCalledWith('rankings:by-token:v5:BTC:90D:25:0')
    expect(mockTieredGetOrSet).toHaveBeenCalledTimes(2)
    expect(mockReadSealedTokenTraderRankings).toHaveBeenCalledTimes(1)
    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledTimes(2)
  })

  it('evicts a cached page whose pagination receipt does not match the request', async () => {
    const wrongPage = cacheEntry('wrong-page-row')
    wrongPage.value.offset = 50
    wrongPage.value.total = 51
    mockTieredGetOrSet
      .mockResolvedValueOnce(wrongPage)
      .mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) => fetcher())

    const response = await GET(request())
    const body = await response.json()

    expect(body).toMatchObject({ token: 'BTC', period: '90D', limit: 25, offset: 0 })
    expect(JSON.stringify(body)).not.toContain('wrong-page-row')
    expect(mockTieredDel).toHaveBeenCalledWith('rankings:by-token:v5:BTC:90D:25:0')
    expect(mockReadSealedTokenTraderRankings).toHaveBeenCalledTimes(1)
  })
})
