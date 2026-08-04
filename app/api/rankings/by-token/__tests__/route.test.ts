const mockGetSupabaseAdmin = jest.fn()
const mockTieredGetOrSet = jest.fn()
const mockCheckRateLimit = jest.fn()

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

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: {} },
}))

import type { NextRequest } from 'next/server'
import { GET } from '../route'

const originalFetch = global.fetch

function poisonedRequest(): NextRequest {
  return Object.defineProperties(
    {},
    {
      nextUrl: {
        get: () => {
          throw new Error('request parameters must not be read while containment is active')
        },
      },
      url: {
        get: () => {
          throw new Error('request URL must not be read while containment is active')
        },
      },
    }
  ) as NextRequest
}

describe('GET /api/rankings/by-token containment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('returns the fixed unpublished response before reading request parameters', async () => {
    const response = GET(poisonedRequest())

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Token rankings are withheld while verified authority snapshots are rebuilt',
      code: 'TOKEN_RANKING_NOT_PUBLISHED',
    })
    expect(response.headers.get('Retry-After')).toBe('3600')
    expect(response.headers.get('Cache-Control')).toBe(
      'private, no-store, max-age=0, must-revalidate'
    )
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('does not call Supabase, Redis, rate limiting, or fetch', () => {
    GET(poisonedRequest())

    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockTieredGetOrSet).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
