/**
 * /api/stripe/create-checkout route tests
 *
 * Tests authentication, input validation, Stripe integration,
 * and error handling for the checkout session creation API.
 */

// --- Mocks ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
    }
    async json() { return this._body }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    _headers: Map<string, string>
    _body: unknown

    constructor(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) {
      this.url = url
      this.nextUrl = new URL(url)
      this._headers = new Map(Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(opts?.headers || {}) }))
      this._body = opts?.body
    }

    get headers() {
      const headers = this._headers
      return { get: (key: string) => headers.get(key) || null }
    }

    async json() { return JSON.parse(this._body as string) }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

// Mock env as a static object. The route reads env.STRIPE_SECRET_KEY at request time.
// We use a mutable object so tests can modify it.
const mockEnv: Record<string, string | undefined> = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  NEXT_PUBLIC_APP_URL: 'https://app.test.com',
  NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
}
jest.mock('@/lib/env', () => ({
  env: new Proxy({}, {
    get(_t, key) {
      return mockEnv[String(key)]
    },
  }),
}))

const mockCheckRateLimit = jest.fn().mockResolvedValue(null)
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { sensitive: { limit: 10, window: 60 } },
}))

jest.mock('@/lib/utils/logger', () => {
  const inst = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() }
  return { createLogger: jest.fn(() => inst), logger: inst, fireAndForget: jest.fn(), captureError: jest.fn(), captureMessage: jest.fn() }
})

const mockGetOrCreateStripeCustomer = jest.fn().mockResolvedValue('cus_test123')
const mockCreateCheckoutSession = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/session', id: 'cs_test123' })
const mockGetStripe = jest.fn(() => ({
  checkout: {
    sessions: {
      create: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/lifetime', id: 'cs_lifetime123' }),
    },
  },
}))

jest.mock('@/lib/stripe', () => ({
  STRIPE_PRICE_IDS: {
    monthly: 'price_monthly123',
    yearly: 'price_yearly123',
    lifetime: 'price_lifetime123',
  },
  getOrCreateStripeCustomer: (...args: unknown[]) => mockGetOrCreateStripeCustomer(...args),
  createCheckoutSession: (...args: unknown[]) => mockCreateCheckoutSession(...args),
  getStripe: () => mockGetStripe(),
}))

// Mock supabase: auth.getUser and from().upsert()
const mockGetUser = jest.fn()

// The route uses getSupabaseAdmin() from '@/lib/supabase/server', not createClient directly
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: jest.fn(() => ({
      upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ count: 0, error: null }),
      }),
    })),
  })),
}))

// Mock extractUserFromRequest — the route uses this instead of direct supabase.auth.getUser
const mockExtractUser = jest.fn()
jest.mock('@/lib/auth/extract-user', () => ({
  extractUserFromRequest: (...args: unknown[]) => mockExtractUser(...args),
}))

// Also mock createClient for the cookie-auth fallback path in the route
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: jest.fn(() => ({
      upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ count: 0, error: null }),
      }),
    })),
  })),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

describe('POST /api/stripe/create-checkout', () => {
  const validUser = { id: 'user-123', email: 'user@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null })
    mockExtractUser.mockResolvedValue({ user: validUser, error: null })
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_test123')
    mockCreateCheckoutSession.mockResolvedValue({ url: 'https://checkout.stripe.com/session', id: 'cs_test123' })
    // Reset env mock
    mockEnv.STRIPE_SECRET_KEY = 'sk_test_123'
    mockEnv.NEXT_PUBLIC_APP_URL = 'https://app.test.com'
    mockEnv.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    mockEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test.com'
  })

  // --- Rate Limiting ---

  it('returns rate limit response when rate limited', async () => {
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    mockCheckRateLimit.mockResolvedValue(NextResponse.json({ error: 'Rate limited' }, { status: 429 }))

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(429)
  })

  // --- Stripe Not Configured ---

  it('returns 503 when STRIPE_SECRET_KEY is not set', async () => {
    mockEnv.STRIPE_SECRET_KEY = undefined

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.error).toMatch(/not configured/)
  })

  // --- Authentication ---

  it('returns 401 when auth token is invalid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid token' } })
    mockExtractUser.mockResolvedValue({ user: null, error: 'Invalid token' })

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer invalid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toMatch(/Unauthorized/)
  })

  it('returns 401 when no auth header and cookie auth fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No session' } })
    mockExtractUser.mockResolvedValue({ user: null, error: 'No session' })

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      body: JSON.stringify({ plan: 'monthly' }),
    })
    const res = await POST(req)
    await res.json()

    expect(res.status).toBe(401)
  })

  // --- Input Validation ---

  it('returns 400 for invalid plan type', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'invalid-plan' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/Invalid plan/)
  })

  // --- Success Cases ---

  it('creates monthly subscription checkout session', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.url).toBeDefined()
    expect(body.sessionId).toBeDefined()
    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledWith(
      'user-123',
      'user@test.com',
      expect.objectContaining({ plan: 'monthly' })
    )
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_test123',
        priceId: 'price_monthly123',
      })
    )
  })

  it('creates yearly subscription checkout session', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'yearly' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.url).toBeDefined()
    expect(body.sessionId).toBeDefined()
  })

  it('creates lifetime one-time payment checkout session', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.url).toBeDefined()
    expect(body.sessionId).toBeDefined()
  })

  it('passes promotion code to checkout session', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', promotionCode: 'promo_abc' }),
    })
    const res = await POST(req)
    await res.json()

    expect(res.status).toBe(200)
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ promotionCode: 'promo_abc' })
    )
  })

  // --- Error Handling ---

  it('returns 500 when Stripe customer creation fails', async () => {
    mockGetOrCreateStripeCustomer.mockRejectedValue(new Error('Stripe API error'))

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toMatch(/Failed to create checkout/)
  })

  it('returns 502 on network error', async () => {
    const networkError = Object.assign(new Error('Network failed'), { code: 'ENOTFOUND' })
    mockGetOrCreateStripeCustomer.mockRejectedValue(networkError)

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.error).toMatch(/Network error/)
  })
})
