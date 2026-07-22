jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body?: unknown, init: ResponseInit = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: ResponseInit) {
      return new MockNextResponse(data, init)
    }

    static next() {
      return new MockNextResponse()
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@supabase/ssr', () => ({ createServerClient: jest.fn() }))
jest.mock('@upstash/ratelimit', () => ({
  Ratelimit: class MockRatelimit {
    static slidingWindow() {
      return {}
    }
  },
}))
jest.mock('@upstash/redis', () => ({ Redis: class MockRedis {} }))

const mockGenerateRequestId = jest.fn(() => 'request-id')
jest.mock('@/lib/utils/logger', () => ({ generateRequestId: () => mockGenerateRequestId() }))

const mockClassifyProxyStrictRateLimit = jest.fn()
jest.mock('@/lib/security/proxy-rate-limit', () => ({
  PROXY_STRICT_RATE_LIMITS: {},
  classifyProxyStrictRateLimit: (...args: unknown[]) => mockClassifyProxyStrictRateLimit(...args),
}))

import { proxy } from '@/proxy'

describe('Tip checkout cutover at the Next.js proxy boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.STRIPE_TIP_CHECKOUT_ENABLED
  })

  afterAll(() => {
    delete process.env.STRIPE_TIP_CHECKOUT_ENABLED
  })

  it.each([undefined, 'false', 'TRUE'])(
    'returns 503 before proxy rate limit, auth, and CSRF work for flag %p',
    async (value) => {
      if (value === undefined) delete process.env.STRIPE_TIP_CHECKOUT_ENABLED
      else process.env.STRIPE_TIP_CHECKOUT_ENABLED = value

      const response = await proxy({
        nextUrl: { pathname: '/api/tip/checkout' },
        method: 'POST',
      } as never)

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: 'Tip checkout is temporarily unavailable.',
        code: 'TIP_CHECKOUT_UNAVAILABLE',
      })
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('retry-after')).toBe('300')
      expect(mockClassifyProxyStrictRateLimit).not.toHaveBeenCalled()
      expect(mockGenerateRequestId).not.toHaveBeenCalled()
    }
  )
})
