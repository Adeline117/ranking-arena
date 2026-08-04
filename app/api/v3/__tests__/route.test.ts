const mockCheckRateLimitFull = jest.fn()
const mockTieredGetOrSet = jest.fn()
const mockGetLeaderboard = jest.fn()
const mockGetTraderDetail = jest.fn()
const mockSearchTraders = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    async text() {
      return String(this.body ?? '')
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    readonly url: string
    readonly nextUrl: URL
    readonly headers: Headers

    constructor(url: string, init: { headers?: HeadersInit } = {}) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Headers(init.headers)
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitFull: (...args: unknown[]) => mockCheckRateLimitFull(...args),
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))

jest.mock('@/lib/data/unified', () => ({
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
  getTraderDetail: (...args: unknown[]) => mockGetTraderDetail(...args),
  searchTraders: (...args: unknown[]) => mockSearchTraders(...args),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
import {
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'

const PRIVATE_NO_STORE = 'private, no-store, max-age=0, must-revalidate'

function request(path: string, headers?: HeadersInit) {
  return new NextRequest(`http://localhost${path}`, { headers })
}

describe('GET /api/v3 cache and publication boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimitFull.mockResolvedValue({
      response: null,
      meta: { remaining: 73 },
    })
    mockGetLeaderboard.mockResolvedValue({
      traders: [
        {
          platform: 'binance_futures',
          traderKey: 'alice',
          handle: 'Alice',
          rank: 1,
          roi: 12,
        },
      ],
      total: 1,
    })
    mockGetTraderDetail.mockResolvedValue(null)
    mockSearchTraders.mockResolvedValue([])
    mockTieredGetOrSet.mockResolvedValue({ binance_futures: 12 })
  })

  it('keeps successful JSON private when its metadata contains a caller quota', async () => {
    const response = await GET(request('/api/v3?endpoint=rankings'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
    expect(response.headers.get('cache-control')).not.toMatch(/\bpublic\b|s-maxage/i)
    expect(body.meta).toEqual(
      expect.objectContaining({
        credits_remaining: 73,
        rate_limit: { daily_limit: 100, remaining: 73 },
      })
    )
  })

  it('keeps CSV exports private after performing caller-specific rate limiting', async () => {
    const response = await GET(request('/api/v3?endpoint=rankings&format=csv'))
    const csv = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
    expect(response.headers.get('cache-control')).not.toMatch(/\bpublic\b|s-maxage/i)
    expect(mockCheckRateLimitFull).toHaveBeenCalledTimes(1)
    expect(csv).toContain('platform,traderKey,handle,rank,roi')
  })

  it('keeps free-tier 429 quota metadata private', async () => {
    mockCheckRateLimitFull.mockResolvedValue({
      response: { status: 429 },
      meta: { remaining: 0 },
    })

    const response = await GET(request('/api/v3?endpoint=rankings'))
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
    expect(response.headers.get('cache-control')).not.toMatch(/\bpublic\b|s-maxage/i)
    expect(response.headers.get('retry-after')).toBe('86400')
    expect(body.meta).toEqual(
      expect.objectContaining({
        credits_remaining: 0,
        rate_limit: { daily_limit: 100, remaining: 0 },
      })
    )
    expect(mockGetLeaderboard).not.toHaveBeenCalled()
  })

  it('uses the versioned public ranking key and publication fence/tag for platform counts', async () => {
    const response = await GET(request('/api/v3?endpoint=platforms'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
    expect(body.data).toContainEqual(
      expect.objectContaining({ key: 'binance_futures', traderCount: 12 })
    )
    expect(mockTieredGetOrSet).toHaveBeenCalledTimes(1)
    expect(mockTieredGetOrSet).toHaveBeenCalledWith(
      publicRankingCacheKey('v3:platform-counts'),
      expect.any(Function),
      'warm',
      [PUBLIC_RANKING_REDIS_TAG, 'platform-counts'],
      {
        skipMemory: true,
        writeFenceKey: PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
      }
    )
  })

  it('quarantines legacy position history in trader responses', async () => {
    const cachedDetail = {
      trader: { platform: 'bybit', traderKey: 'cached-trader' },
      positionHistory: [{ symbol: 'BTCUSDT', pnlUsd: 42 }],
      historyCompleteness: { state: 'complete' },
    }
    mockGetTraderDetail.mockResolvedValueOnce(cachedDetail)

    const response = await GET(
      request('/api/v3?endpoint=trader&platform=bybit&trader_key=cached-trader')
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.positionHistory).toEqual([])
    expect(body.data.historyCompleteness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    })
    expect(cachedDetail.positionHistory).toHaveLength(1)
  })
})
