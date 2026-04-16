/**
 * Tests for checkRateLimitFull fail-close behavior.
 *
 * Verifies:
 *   - failClose: true returns 503 when Redis is unavailable/errors
 *   - failClose: false (default) allows request when Redis fails
 *   - failClose: true with healthy Redis enforces limits normally
 *   - Built-in presets for `auth` and `sensitive` have failClose: true
 */

// The global jest.setup.js mocks @/lib/utils/rate-limit — we need the REAL
// module here. Use requireActual + explicit re-mock with the real exports.
jest.mock('@/lib/utils/rate-limit', () => jest.requireActual('@/lib/utils/rate-limit'))

// We'll override @upstash/redis and @upstash/ratelimit per-test via jest.doMock,
// so we isolate modules between tests.
import type { NextRequest } from 'next/server'

function makeRequest(
  headers: Record<string, string> = { 'x-forwarded-for': '42.0.0.1', 'user-agent': 'Test' }
): NextRequest {
  return {
    url: 'https://example.com/api/x',
    headers: new Headers(headers),
    method: 'POST',
    nextUrl: { pathname: '/api/x' },
  } as unknown as NextRequest
}

// Each test uses isolateModulesAsync to get a fresh copy of rate-limit.ts
// with the desired Upstash mock shape (throws / works / blocks).
async function loadRateLimitWithUpstash(opts: {
  redisThrows?: boolean
  limitResult?: { success: boolean; limit: number; remaining: number; reset: number }
}) {
  let rlMod!: typeof import('../rate-limit')
  await jest.isolateModulesAsync(async () => {
    jest.doMock('@upstash/redis', () => ({
      Redis: opts.redisThrows
        ? jest.fn(() => {
            throw new Error('Redis unavailable')
          })
        : jest.fn(() => ({})),
    }))

    jest.doMock('@upstash/ratelimit', () => {
      const Ratelimit = jest.fn(() => ({
        limit: jest.fn(async () =>
          opts.limitResult ?? {
            success: true,
            limit: 10,
            remaining: 9,
            reset: Date.now() + 60_000,
          }
        ),
      })) as unknown as jest.Mock & { slidingWindow: jest.Mock }
      Ratelimit.slidingWindow = jest.fn(() => 'sliding-window-marker')
      return { Ratelimit }
    })

    rlMod = await import('../rate-limit')
  })
  return rlMod
}

describe('RateLimitPresets failClose flags', () => {
  it('auth preset has failClose: true', async () => {
    const { RateLimitPresets } = await loadRateLimitWithUpstash({})
    expect(RateLimitPresets.auth.failClose).toBe(true)
  })

  it('sensitive preset has failClose: true', async () => {
    const { RateLimitPresets } = await loadRateLimitWithUpstash({})
    expect(RateLimitPresets.sensitive.failClose).toBe(true)
  })

  it('public preset does NOT have failClose', async () => {
    const { RateLimitPresets } = await loadRateLimitWithUpstash({})
    expect(RateLimitPresets.public.failClose).toBeUndefined()
  })

  it('authenticated preset does NOT have failClose', async () => {
    const { RateLimitPresets } = await loadRateLimitWithUpstash({})
    expect(RateLimitPresets.authenticated.failClose).toBeUndefined()
  })

  it('write preset does NOT have failClose', async () => {
    const { RateLimitPresets } = await loadRateLimitWithUpstash({})
    expect(RateLimitPresets.write.failClose).toBeUndefined()
  })
})

describe('checkRateLimitFull with Redis env unset', () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN

  beforeAll(() => {
    // Force Redis to be unavailable by clearing env vars
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  })

  afterAll(() => {
    if (originalUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = originalUrl
    if (originalToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = originalToken
  })

  // When env is unset, `getUpstashRedis` returns null and the code uses the
  // in-memory fallback — it does NOT hit the try/catch failClose branch.
  // failClose only triggers when Redis is *configured* but the call throws.
  // So we test that path separately below using a throwing Redis constructor.

  it('allows request via in-memory fallback when env unset (failClose: true)', async () => {
    const { checkRateLimitFull } = await loadRateLimitWithUpstash({})
    const req = makeRequest()

    const result = await checkRateLimitFull(req, {
      requests: 100,
      window: 60,
      prefix: 'env-unset-failclose',
      failClose: true,
    })

    // In-memory fallback is used; first request should be allowed (response=null)
    // regardless of failClose, because the branch that returns 503 is the
    // catch() around the Redis call itself, not the env-missing path.
    expect(result.response).toBeNull()
    expect(result.meta).not.toBeNull()
  })
})

describe('checkRateLimitFull with Redis errors at runtime', () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN

  beforeAll(() => {
    // Provide env vars so Redis client creation is attempted — the mocked
    // Redis constructor decides whether it throws.
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token'
  })

  afterAll(() => {
    if (originalUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = originalUrl
    else delete process.env.UPSTASH_REDIS_REST_URL
    if (originalToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = originalToken
    else delete process.env.UPSTASH_REDIS_REST_TOKEN
  })

  it('failClose: true → returns 503 when ratelimiter.limit throws', async () => {
    // Redis construction succeeds, but .limit() throws — hits the catch block
    let rlMod!: typeof import('../rate-limit')
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@upstash/redis', () => ({
        Redis: jest.fn(() => ({})),
      }))
      jest.doMock('@upstash/ratelimit', () => {
        const Ratelimit = jest.fn(() => ({
          limit: jest.fn(async () => {
            throw new Error('ECONNREFUSED')
          }),
        })) as unknown as jest.Mock & { slidingWindow: jest.Mock }
        Ratelimit.slidingWindow = jest.fn(() => 'sliding-window-marker')
        return { Ratelimit }
      })
      rlMod = await import('../rate-limit')
    })

    const req = makeRequest()
    const result = await rlMod.checkRateLimitFull(req, {
      requests: 5,
      window: 60,
      prefix: 'failclose-503-test',
      failClose: true,
    })

    expect(result.response).not.toBeNull()
    expect(result.response!.status).toBe(503)
    expect(result.meta).toBeNull()

    const body = await result.response!.json()
    expect(body).toMatchObject({
      success: false,
      code: 'SERVICE_UNAVAILABLE',
    })
    expect(result.response!.headers.get('Retry-After')).toBe('30')
  })

  it('failClose: false (default) → allows request when ratelimiter.limit throws', async () => {
    let rlMod!: typeof import('../rate-limit')
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@upstash/redis', () => ({
        Redis: jest.fn(() => ({})),
      }))
      jest.doMock('@upstash/ratelimit', () => {
        const Ratelimit = jest.fn(() => ({
          limit: jest.fn(async () => {
            throw new Error('network blip')
          }),
        })) as unknown as jest.Mock & { slidingWindow: jest.Mock }
        Ratelimit.slidingWindow = jest.fn(() => 'sliding-window-marker')
        return { Ratelimit }
      })
      rlMod = await import('../rate-limit')
    })

    const req = makeRequest()
    const result = await rlMod.checkRateLimitFull(req, {
      requests: 5,
      window: 60,
      prefix: 'failopen-allow-test',
      // failClose not specified → defaults to false
    })

    expect(result.response).toBeNull()
    expect(result.meta).toBeNull()
  })

  it('failClose: true with healthy Redis → still enforces 429 when over limit', async () => {
    let rlMod!: typeof import('../rate-limit')
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@upstash/redis', () => ({
        Redis: jest.fn(() => ({})),
      }))
      jest.doMock('@upstash/ratelimit', () => {
        const Ratelimit = jest.fn(() => ({
          limit: jest.fn(async () => ({
            success: false,
            limit: 10,
            remaining: 0,
            reset: Date.now() + 60_000,
          })),
        })) as unknown as jest.Mock & { slidingWindow: jest.Mock }
        Ratelimit.slidingWindow = jest.fn(() => 'sliding-window-marker')
        return { Ratelimit }
      })
      rlMod = await import('../rate-limit')
    })

    const req = makeRequest()
    const result = await rlMod.checkRateLimitFull(req, {
      requests: 10,
      window: 60,
      prefix: 'failclose-healthy-test',
      failClose: true,
    })

    expect(result.response).not.toBeNull()
    expect(result.response!.status).toBe(429)
    const body = await result.response!.json()
    expect(body).toMatchObject({
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
    })
  })

  it('failClose: true with healthy Redis → allows request when under limit', async () => {
    let rlMod!: typeof import('../rate-limit')
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@upstash/redis', () => ({
        Redis: jest.fn(() => ({})),
      }))
      jest.doMock('@upstash/ratelimit', () => {
        const Ratelimit = jest.fn(() => ({
          limit: jest.fn(async () => ({
            success: true,
            limit: 10,
            remaining: 9,
            reset: Date.now() + 60_000,
          })),
        })) as unknown as jest.Mock & { slidingWindow: jest.Mock }
        Ratelimit.slidingWindow = jest.fn(() => 'sliding-window-marker')
        return { Ratelimit }
      })
      rlMod = await import('../rate-limit')
    })

    const req = makeRequest()
    const result = await rlMod.checkRateLimitFull(req, {
      requests: 10,
      window: 60,
      prefix: 'failclose-allowed-test',
      failClose: true,
    })

    expect(result.response).toBeNull()
    expect(result.meta).toEqual({
      limit: 10,
      remaining: 9,
      reset: expect.any(Number),
    })
  })
})
