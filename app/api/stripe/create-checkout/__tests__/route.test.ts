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
    async json() {
      return this._body
    }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    _headers: Map<string, string>
    _body: unknown

    constructor(
      url: string,
      opts?: { method?: string; headers?: Record<string, string>; body?: string }
    ) {
      this.url = url
      this.nextUrl = new URL(url)
      this._headers = new Map(
        Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(opts?.headers || {}) })
      )
      this._body = opts?.body
    }

    get headers() {
      const headers = this._headers
      return { get: (key: string) => headers.get(key) || null }
    }

    async json() {
      return JSON.parse(this._body as string)
    }
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
  env: new Proxy(
    {},
    {
      get(_t, key) {
        return mockEnv[String(key)]
      },
    }
  ),
}))

const mockCheckRateLimit = jest.fn().mockResolvedValue(null)
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { sensitive: { limit: 10, window: 60 } },
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

const mockGetOrCreateStripeCustomer = jest.fn().mockResolvedValue('cus_test123')
const mockAssertProPriceReady = jest.fn().mockResolvedValue(undefined)
const mockAssertStripePaymentRuntimeReady = jest.fn()
const mockCreateCheckoutSession = jest
  .fn()
  .mockResolvedValue({ url: 'https://checkout.stripe.com/session', id: 'cs_test123' })
const mockListSubscriptions = jest.fn()
const mockCreateOneTimeCheckoutSession = jest
  .fn()
  .mockResolvedValue({ url: 'https://checkout.stripe.com/lifetime', id: 'cs_lifetime123' })
const mockGetStripe = jest.fn(() => ({
  checkout: {
    sessions: {
      create: (...args: unknown[]) => mockCreateOneTimeCheckoutSession(...args),
    },
  },
  subscriptions: {
    list: (...args: unknown[]) => mockListSubscriptions(...args),
  },
}))

jest.mock('@/lib/stripe', () => ({
  STRIPE_PRICE_IDS: {
    monthly: 'price_monthly123',
    yearly: 'price_yearly123',
    lifetime: 'price_lifetime123',
  },
  getOrCreateStripeCustomer: (...args: unknown[]) => mockGetOrCreateStripeCustomer(...args),
  assertProPriceReady: (...args: unknown[]) => mockAssertProPriceReady(...args),
  assertStripePaymentRuntimeReady: () => mockAssertStripePaymentRuntimeReady(),
  createCheckoutSession: (...args: unknown[]) => mockCreateCheckoutSession(...args),
  getStripe: () => mockGetStripe(),
}))

// Mock supabase: auth.getUser and profile lookup/update
const mockGetUser = jest.fn()
const mockBillingProfileSingle = jest.fn().mockResolvedValue({
  data: { stripe_customer_id: null },
  error: null,
})
const mockProfileUpdate = jest.fn()
const mockProfileUpdateEq = jest.fn()
const mockProfileUpdateSelect = jest.fn()
const mockProfileUpdateMaybeSingle = jest.fn().mockResolvedValue({
  data: { id: 'user-123' },
  error: null,
})

// The route uses getSupabaseAdmin() from '@/lib/supabase/server', not createClient directly
const mockSubscriptionQuery = {
  eq: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
}
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: jest.fn(() => ({
      update: (...args: unknown[]) => {
        mockProfileUpdate(...args)
        return {
          eq: (...eqArgs: unknown[]) => {
            mockProfileUpdateEq(...eqArgs)
            return {
              select: (...selectArgs: unknown[]) => {
                mockProfileUpdateSelect(...selectArgs)
                return {
                  maybeSingle: (...singleArgs: unknown[]) =>
                    mockProfileUpdateMaybeSingle(...singleArgs),
                }
              },
            }
          },
        }
      },
      select: jest.fn().mockReturnValue({
        ...mockSubscriptionQuery,
        eq: jest.fn().mockReturnValue({
          ...mockSubscriptionQuery,
          single: (...args: unknown[]) => mockBillingProfileSingle(...args),
          mockResolvedValue: undefined,
        }),
      }),
    })),
    rpc: jest.fn().mockResolvedValue({ data: true, error: null }),
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
    mockBillingProfileSingle.mockResolvedValue({
      data: { stripe_customer_id: null },
      error: null,
    })
    mockProfileUpdateMaybeSingle.mockResolvedValue({
      data: { id: 'user-123' },
      error: null,
    })
    mockAssertProPriceReady.mockResolvedValue(undefined)
    mockAssertStripePaymentRuntimeReady.mockReturnValue(undefined)
    mockCreateCheckoutSession.mockResolvedValue({
      url: 'https://checkout.stripe.com/session',
      id: 'cs_test123',
    })
    mockCreateOneTimeCheckoutSession.mockResolvedValue({
      url: 'https://checkout.stripe.com/lifetime',
      id: 'cs_lifetime123',
    })
    mockListSubscriptions.mockResolvedValue({ data: [], has_more: false })
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
    mockCheckRateLimit.mockResolvedValue(
      NextResponse.json({ error: 'Rate limited' }, { status: 429 })
    )

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

  it('fails closed before creating a customer when Stripe pricing drifts from the UI', async () => {
    mockAssertProPriceReady.mockRejectedValue(new Error('amount mismatch'))
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('fails closed before creating a customer when Production payment runtime is unsafe', async () => {
    mockAssertStripePaymentRuntimeReady.mockImplementation(() => {
      throw new Error('Stripe live mode is required for Production payment actions')
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockAssertProPriceReady).not.toHaveBeenCalled()
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('blocks checkout when the customer-to-user webhook link cannot persist', async () => {
    mockProfileUpdateMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('blocks checkout when the profile disappears before the customer link update', async () => {
    mockProfileUpdateMaybeSingle.mockResolvedValue({
      data: null,
      error: null,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('fails closed before creating a Stripe customer when the billing profile is missing', async () => {
    mockBillingProfileSingle.mockResolvedValue({ data: null, error: null })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockProfileUpdate).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('fails closed before creating a Stripe customer when the billing profile lookup errors', async () => {
    mockBillingProfileSingle.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockProfileUpdate).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
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
      expect.objectContaining({ plan: 'monthly' }),
      null
    )
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_test123',
        priceId: 'price_monthly123',
        allowPromotionCodes: false,
      })
    )
    expect(mockProfileUpdate).toHaveBeenCalledWith({
      stripe_customer_id: 'cus_test123',
      updated_at: expect.any(String),
    })
    expect(mockProfileUpdateEq).toHaveBeenCalledWith('id', 'user-123')
    expect(mockProfileUpdateSelect).toHaveBeenCalledWith('id')
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
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ allowPromotionCodes: false })
    )
  })

  it('grants a trial only after the complete Stripe subscription history has no prior trial', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: true }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockListSubscriptions).toHaveBeenCalledWith({
      customer: 'cus_test123',
      status: 'all',
      limit: 100,
    })
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ trialDays: 7 })
    )
  })

  it('finds a prior trial on the 101st Stripe subscription and denies another trial', async () => {
    const firstHundred = Array.from({ length: 100 }, (_, index) => ({
      id: `sub_history_${index + 1}`,
      trial_start: null,
      trial_end: null,
    }))
    mockListSubscriptions
      .mockResolvedValueOnce({ data: firstHundred, has_more: true })
      .mockResolvedValueOnce({
        data: [{ id: 'sub_trial_101', trial_start: 1_700_000_000, trial_end: 1_700_604_800 }],
        has_more: false,
      })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: true }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockListSubscriptions).toHaveBeenNthCalledWith(2, {
      customer: 'cus_test123',
      status: 'all',
      limit: 100,
      starting_after: 'sub_history_100',
    })
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ trialDays: 7 })
    )
  })

  it('fails closed on a non-advancing Stripe trial-history page', async () => {
    mockListSubscriptions.mockResolvedValue({ data: [], has_more: true })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'yearly', trial: true }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ trialDays: 7 })
    )
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
    expect(mockCreateOneTimeCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        allow_promotion_codes: false,
      }),
      expect.anything()
    )
  })

  it.each(['monthly', 'yearly', 'lifetime'])(
    'rejects an explicit 100%% promotion code before creating a %s Checkout Session',
    async (plan) => {
      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan, promotionCode: 'promo_free_100_percent' }),
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.code).toBe('PROMOTION_CODES_DISABLED')
      expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
      expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
    }
  )

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
