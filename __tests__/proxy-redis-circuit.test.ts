/**
 * Production 2026-11-27: Upstash was unavailable and each limiter round trip
 * took about a second to fail, so the proxy added that second to every API
 * request. After one failure the proxy must stop calling Redis and keep
 * failing open.
 */

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Headers

    constructor(_body?: unknown, init: ResponseInit = {}) {
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    static json(_data: unknown, init?: ResponseInit) {
      return new MockNextResponse(undefined, init)
    }

    static next() {
      return new MockNextResponse()
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@supabase/ssr', () => ({ createServerClient: jest.fn() }))

const mockLimit = jest.fn()
jest.mock('@upstash/ratelimit', () => ({
  Ratelimit: class MockRatelimit {
    static slidingWindow() {
      return {}
    }
    limit(...args: unknown[]) {
      return mockLimit(...args)
    }
  },
}))
jest.mock('@upstash/redis', () => ({ Redis: class MockRedis {} }))
jest.mock('@/lib/utils/logger', () => ({ generateRequestId: () => 'request-id' }))
jest.mock('@/lib/security/proxy-rate-limit', () => ({
  PROXY_STRICT_RATE_LIMITS: { read: { requests: 60, window: '60 s', prefix: 'mw:read' } },
  classifyProxyStrictRateLimit: () => 'read',
}))

import { proxy } from '@/proxy'
import { REDIS_CIRCUIT_COOLDOWN_MS, resetRedisCircuitForTests } from '@/lib/cache/redis-circuit'

function tradersRequest() {
  return {
    nextUrl: { pathname: '/api/traders' },
    method: 'GET',
    headers: new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'jest' }),
    cookies: { get: () => undefined, getAll: () => [] },
  } as never
}

describe('proxy rate limiting behind the Redis circuit breaker', () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN
  let now = 3_000_000

  beforeEach(() => {
    now = 3_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    resetRedisCircuitForTests()
    mockLimit.mockReset()
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken
  })

  it('calls Redis once, then lets requests through without it until the cooldown ends', async () => {
    mockLimit.mockRejectedValue(new Error('fetch failed'))

    // First request: the IP-floor limiter fails; the tiered limiter is skipped.
    expect((await proxy(tradersRequest())).status).toBe(200)
    expect(mockLimit).toHaveBeenCalledTimes(1)

    expect((await proxy(tradersRequest())).status).toBe(200)
    expect((await proxy(tradersRequest())).status).toBe(200)
    expect(mockLimit).toHaveBeenCalledTimes(1)

    // After the cooldown one probe goes out; Redis answers and limiting resumes.
    now += REDIS_CIRCUIT_COOLDOWN_MS
    mockLimit.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: now + 60_000 })
    expect((await proxy(tradersRequest())).status).toBe(200)
    expect((await proxy(tradersRequest())).status).toBe(200)
    // probe (IP floor) + tiered on the probing request, then two per request.
    expect(mockLimit).toHaveBeenCalledTimes(1 + 2 + 2)
  })

  it('still returns 429 from a healthy limiter', async () => {
    mockLimit.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset: now + 30_000 })

    expect((await proxy(tradersRequest())).status).toBe(429)
  })
})
