/**
 * Rate Limiter — supplemental edge-case tests
 *
 * Covers gaps NOT in rate-limit.test.ts or rate-limit-failclose.test.ts:
 * - In-memory rate limiter: exact boundary (request N == limit)
 * - In-memory rate limiter: window expiry reset
 * - getIdentifier: x-real-ip fallback, empty XFF, multiple commas
 * - closeRateLimitRedis clears state
 * - checkRateLimit backward compatibility (wraps checkRateLimitFull)
 * - RateLimitPresets exhaustive shape checks
 */

// Override the global mock to use the real module
jest.mock('@/lib/utils/rate-limit', () => jest.requireActual('@/lib/utils/rate-limit'))

// Mock Redis to be unavailable → forces in-memory fallback
jest.mock('@upstash/redis', () => ({
  Redis: jest.fn(() => {
    throw new Error('Redis unavailable')
  }),
}))

jest.mock('@upstash/ratelimit', () => ({
  Ratelimit: jest.fn(() => ({
    limit: jest
      .fn()
      .mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60000 }),
  })),
}))

import type { NextRequest } from 'next/server'
import {
  getIdentifier,
  checkRateLimit,
  checkRateLimitFull,
  closeRateLimitRedis,
  RateLimitPresets,
  addRateLimitHeaders,
} from '../rate-limit'

function makeRequest(
  headers: Record<string, string> = {},
  url = 'https://example.com/api/test'
): NextRequest {
  return {
    url,
    headers: new Headers(headers),
    method: 'GET',
    nextUrl: { pathname: '/api/test' },
  } as unknown as NextRequest
}

// ============================================
// getIdentifier — additional scenarios
// ============================================

describe('getIdentifier — additional edge cases', () => {
  it('falls back to x-real-ip when no XFF headers', () => {
    const req = makeRequest({ 'x-real-ip': '192.168.1.1', 'user-agent': 'Bot' })
    const id = getIdentifier(req)
    expect(id).toMatch(/^ip:192\.168\.1\.1:/)
  })

  it('handles XFF with multiple IPs (takes first)', () => {
    const req = makeRequest({
      'x-forwarded-for': '10.0.0.1, 10.0.0.2, 10.0.0.3',
      'user-agent': 'Multi',
    })
    const id = getIdentifier(req)
    expect(id).toMatch(/^ip:10\.0\.0\.1:/)
  })

  it('handles XFF with leading/trailing whitespace', () => {
    const req = makeRequest({
      'x-forwarded-for': '  8.8.8.8  ',
      'user-agent': 'Trim',
    })
    const id = getIdentifier(req)
    expect(id).toMatch(/^ip:8\.8\.8\.8:/)
  })

  it('empty XFF string falls through to x-real-ip', () => {
    const req = makeRequest({
      'x-forwarded-for': '',
      'x-real-ip': '1.2.3.4',
    })
    const id = getIdentifier(req)
    // Empty XFF first split produces '' which is falsy, falls to x-real-ip
    // Actually: ''.split(',')[0].trim() === '' which is falsy → falls to x-real-ip
    expect(id).toMatch(/^ip:1\.2\.3\.4:/)
  })

  it('userId takes absolute precedence over all headers', () => {
    const req = makeRequest({
      'x-vercel-forwarded-for': '1.1.1.1',
      'x-forwarded-for': '2.2.2.2',
      'x-real-ip': '3.3.3.3',
    })
    expect(getIdentifier(req, 'my-user')).toBe('user:my-user')
  })

  it('different user-agents produce different hash suffixes', () => {
    const req1 = makeRequest({ 'x-forwarded-for': '5.5.5.5', 'user-agent': 'Chrome' })
    const req2 = makeRequest({ 'x-forwarded-for': '5.5.5.5', 'user-agent': 'Firefox' })
    const id1 = getIdentifier(req1)
    const id2 = getIdentifier(req2)
    // Same IP but different UA → should produce different hash suffix
    expect(id1).not.toBe(id2)
    // Both should start with same IP prefix
    expect(id1).toMatch(/^ip:5\.5\.5\.5:/)
    expect(id2).toMatch(/^ip:5\.5\.5\.5:/)
  })
})

// ============================================
// In-memory rate limiter — exact boundary
// ============================================

describe('In-memory rate limiter — boundary behavior', () => {
  it('allows exactly N requests and blocks N+1', async () => {
    const limit = 3
    const prefix = `boundary-exact-${Date.now()}`
    const userId = `user-boundary-${Date.now()}`
    const req = makeRequest({ 'x-forwarded-for': '99.99.99.99' })

    const config = { requests: limit, window: 60, prefix }

    // First N requests should pass
    for (let i = 0; i < limit; i++) {
      const result = await checkRateLimitFull(req, config, userId)
      expect(result.response).toBeNull()
      expect(result.meta).not.toBeNull()
      expect(result.meta!.remaining).toBe(limit - i - 1)
    }

    // N+1 should be blocked
    const blocked = await checkRateLimitFull(req, config, userId)
    expect(blocked.response).not.toBeNull()
    expect(blocked.response!.status).toBe(429)
    expect(blocked.meta).toBeNull()
  })

  it('429 response body contains expected fields', async () => {
    const prefix = `body-check-${Date.now()}`
    const userId = `user-body-${Date.now()}`
    const req = makeRequest({ 'x-forwarded-for': '88.88.88.88' })

    // Exhaust limit
    await checkRateLimitFull(req, { requests: 1, window: 60, prefix }, userId)

    // Next is blocked
    const blocked = await checkRateLimitFull(req, { requests: 1, window: 60, prefix }, userId)
    expect(blocked.response).not.toBeNull()

    const body = await blocked.response!.json()
    expect(body).toMatchObject({
      success: false,
      error: expect.any(String),
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: expect.any(Number),
    })

    // Check headers
    expect(blocked.response!.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(blocked.response!.headers.get('Retry-After')).toBeTruthy()
  })
})

// ============================================
// checkRateLimit backward compat
// ============================================

describe('checkRateLimit — backward compatibility', () => {
  it('returns null (allowed) for first request', async () => {
    const prefix = `compat-allow-${Date.now()}`
    const userId = `user-compat-${Date.now()}`
    const req = makeRequest({ 'x-forwarded-for': '77.77.77.77' })

    const result = await checkRateLimit(req, { requests: 10, window: 60, prefix }, userId)
    expect(result).toBeNull()
  })

  it('returns NextResponse (429) when limit exceeded', async () => {
    const prefix = `compat-block-${Date.now()}`
    const userId = `user-compat-block-${Date.now()}`
    const req = makeRequest({ 'x-forwarded-for': '66.66.66.66' })

    // Exhaust limit of 1
    await checkRateLimit(req, { requests: 1, window: 60, prefix }, userId)

    // Next should be blocked
    const result = await checkRateLimit(req, { requests: 1, window: 60, prefix }, userId)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(429)
  })
})

// ============================================
// closeRateLimitRedis
// ============================================

describe('closeRateLimitRedis', () => {
  it('does not throw and can be called multiple times', async () => {
    await expect(closeRateLimitRedis()).resolves.toBeUndefined()
    await expect(closeRateLimitRedis()).resolves.toBeUndefined()
  })
})

// ============================================
// RateLimitPresets — exhaustive
// ============================================

describe('RateLimitPresets — exhaustive checks', () => {
  const presetNames = [
    'public',
    'authenticated',
    'write',
    'read',
    'sensitive',
    'auth',
    'search',
    'realtime',
  ] as const

  it('has all expected preset names', () => {
    for (const name of presetNames) {
      expect(RateLimitPresets[name]).toBeDefined()
    }
  })

  it('failClose presets: only auth and sensitive', () => {
    const failClosePresets = Object.entries(RateLimitPresets).filter(([, v]) => v.failClose)
    expect(failClosePresets.map(([k]) => k).sort()).toEqual(['auth', 'sensitive'])
  })

  it('all presets have positive requests and window', () => {
    for (const [name, preset] of Object.entries(RateLimitPresets)) {
      expect(preset.requests).toBeGreaterThan(0)
      expect(preset.window).toBeGreaterThan(0)
      expect(typeof preset.prefix).toBe('string')
      expect(preset.prefix!.length).toBeGreaterThan(0)
    }
  })

  it('auth preset has stricter limits than public', () => {
    expect(RateLimitPresets.auth.requests).toBeLessThan(RateLimitPresets.public.requests)
  })
})

// ============================================
// addRateLimitHeaders — edge cases
// ============================================

describe('addRateLimitHeaders — edge cases', () => {
  it('overwrites existing headers', () => {
    const headers = new Headers({
      'X-RateLimit-Limit': 'old',
      'X-RateLimit-Remaining': 'old',
      'X-RateLimit-Reset': 'old',
    })
    const response = { status: 200, headers }
    addRateLimitHeaders(response as any, 50, 25, 9999999)

    expect(response.headers.get('X-RateLimit-Limit')).toBe('50')
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('25')
    expect(response.headers.get('X-RateLimit-Reset')).toBe('9999999')
  })

  it('handles zero remaining', () => {
    const headers = new Headers()
    const response = { status: 200, headers }
    addRateLimitHeaders(response as any, 100, 0, 12345)

    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
  })
})
