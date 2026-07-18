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
const mockListSubscriptionItems = jest.fn()
const mockListCheckoutLineItems = jest.fn()
const mockExpireOneTimeCheckoutSession = jest.fn()
const mockRetrieveOneTimeCheckoutSession = jest.fn()
const lifetimeCheckoutExpiresAt = Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000)
const lifetimeCheckoutLine = {
  id: 'li_lifetime123',
  object: 'item',
  price: { id: 'price_lifetime123' },
  quantity: 1,
  currency: 'usd',
  amount_subtotal: 4999,
  amount_total: 4999,
  amount_discount: 0,
  amount_tax: 0,
  discounts: [],
  taxes: [],
}
const recoveredLifetimeCheckoutSession = {
  id: 'cs_lifetime123',
  customer: 'cus_test123',
  metadata: {
    supabase_user_id: 'user-123',
    userId: 'user-123',
    plan: 'lifetime',
    lifetime_reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
    lifetime_reservation_nonce: 'lifetime:user-123:original',
  },
  expires_at: lifetimeCheckoutExpiresAt,
  mode: 'payment',
  status: 'open',
  payment_status: 'unpaid',
  subscription: null,
  after_expiration: null,
  url: 'https://checkout.stripe.com/c/pay/cs_lifetime123',
  currency: 'usd',
  amount_subtotal: 4999,
  amount_total: 4999,
  total_details: { amount_discount: 0, amount_tax: 0 },
  discounts: [],
  allow_promotion_codes: false,
  automatic_tax: { enabled: false },
  adaptive_pricing: { enabled: false },
}

function createdLifetimeCheckoutSession(
  params: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 'cs_lifetime123',
    customer: params.customer,
    metadata: params.metadata,
    expires_at: params.expires_at,
    mode: params.mode,
    status: 'open',
    payment_status: 'unpaid',
    subscription: null,
    after_expiration: null,
    url: 'https://checkout.stripe.com/lifetime',
    currency: 'usd',
    amount_subtotal: 4999,
    amount_total: 4999,
    total_details: { amount_discount: 0, amount_tax: 0 },
    discounts: [],
    allow_promotion_codes: params.allow_promotion_codes,
    automatic_tax: params.automatic_tax,
    adaptive_pricing: params.adaptive_pricing,
    ...overrides,
  }
}

function customerSubscription(params: {
  id: string
  status?: string
  priceId?: string
  trialStart?: number | null
  trialEnd?: number | null
  customerId?: string
}) {
  return {
    id: params.id,
    customer: params.customerId || 'cus_test123',
    status: params.status || 'canceled',
    trial_start: params.trialStart ?? null,
    trial_end: params.trialEnd ?? null,
    items: {
      data: [
        {
          id: `si_${params.id.slice(4)}`,
          subscription: params.id,
          price: { id: params.priceId || 'price_monthly123' },
        },
      ],
      has_more: false,
    },
  }
}

const mockCreateOneTimeCheckoutSession = jest.fn()
let lastCreatedLifetimeCheckoutSession: Record<string, unknown> | null = null
const mockGetStripe = jest.fn(() => ({
  checkout: {
    sessions: {
      create: (...args: unknown[]) => mockCreateOneTimeCheckoutSession(...args),
      expire: (...args: unknown[]) => mockExpireOneTimeCheckoutSession(...args),
      retrieve: (...args: unknown[]) => mockRetrieveOneTimeCheckoutSession(...args),
      listLineItems: (...args: unknown[]) => mockListCheckoutLineItems(...args),
    },
  },
  subscriptions: {
    list: (...args: unknown[]) => mockListSubscriptions(...args),
  },
  subscriptionItems: {
    list: (...args: unknown[]) => mockListSubscriptionItems(...args),
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
const mockRecordStripeCheckoutManualReview = jest.fn()
jest.mock('@/lib/stripe/lifetime-entitlement', () => ({
  LIFETIME_RESERVATION_ID_METADATA_KEY: 'lifetime_reservation_id',
  LIFETIME_RESERVATION_NONCE_METADATA_KEY: 'lifetime_reservation_nonce',
  recordStripeCheckoutManualReview: (...args: unknown[]) =>
    mockRecordStripeCheckoutManualReview(...args),
}))

// Mock supabase: auth.getUser and profile lookup/update
const mockGetUser = jest.fn()
const mockBillingProfileSingle = jest.fn().mockResolvedValue({
  data: { stripe_customer_id: null },
  error: null,
})
const mockRpc = jest.fn()

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
      select: jest.fn().mockReturnValue({
        ...mockSubscriptionQuery,
        eq: jest.fn().mockReturnValue({
          ...mockSubscriptionQuery,
          single: (...args: unknown[]) => mockBillingProfileSingle(...args),
          mockResolvedValue: undefined,
        }),
      }),
    })),
    rpc: (...args: unknown[]) => mockRpc(...args),
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

const originalVercelEnv = process.env.VERCEL_ENV
const originalLifetimeCheckoutEnabled = process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED

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
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_lifetime_membership_spot_atomic') {
        return Promise.resolve({
          data: {
            status: 'reserved',
            reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
            checkout_expires_at: '2099-01-01T00:00:00.000Z',
          },
          error: null,
        })
      }
      if (name === 'bind_lifetime_membership_reservation_session_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'release_lifetime_membership_reservation_atomic') {
        return Promise.resolve({ data: { status: 'released' }, error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    mockAssertProPriceReady.mockResolvedValue(undefined)
    mockAssertStripePaymentRuntimeReady.mockReturnValue(undefined)
    mockCreateCheckoutSession.mockResolvedValue({
      url: 'https://checkout.stripe.com/session',
      id: 'cs_test123',
    })
    lastCreatedLifetimeCheckoutSession = null
    mockCreateOneTimeCheckoutSession.mockImplementation((params: Record<string, unknown>) => {
      lastCreatedLifetimeCheckoutSession = createdLifetimeCheckoutSession(params)
      return Promise.resolve(lastCreatedLifetimeCheckoutSession)
    })
    mockRetrieveOneTimeCheckoutSession.mockImplementation(() =>
      Promise.resolve(lastCreatedLifetimeCheckoutSession || recoveredLifetimeCheckoutSession)
    )
    mockListCheckoutLineItems.mockResolvedValue({
      data: [lifetimeCheckoutLine],
      has_more: false,
    })
    mockListSubscriptionItems.mockResolvedValue({ data: [], has_more: false })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
    mockExpireOneTimeCheckoutSession.mockResolvedValue({ id: 'cs_lifetime123', status: 'expired' })
    mockListSubscriptions.mockResolvedValue({ data: [], has_more: false })
    mockSubscriptionQuery.maybeSingle.mockResolvedValue({ data: null, error: null })
    // Reset env mock
    mockEnv.STRIPE_SECRET_KEY = 'sk_test_123'
    mockEnv.NEXT_PUBLIC_APP_URL = 'https://app.test.com'
    mockEnv.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    mockEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test.com'
    delete process.env.VERCEL_ENV
    delete process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED
  })

  afterEach(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV
    } else {
      process.env.VERCEL_ENV = originalVercelEnv
    }
    if (originalLifetimeCheckoutEnabled === undefined) {
      delete process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED
    } else {
      process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED = originalLifetimeCheckoutEnabled
    }
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
    mockRpc.mockResolvedValue({
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

  it('blocks checkout when exact Stripe customer ownership conflicts', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'identity_conflict' }, error: null })
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
    expect(mockRpc).not.toHaveBeenCalled()
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
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('returns 503 when the duplicate-subscription lookup fails', async () => {
    mockSubscriptionQuery.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'subscriptions read unavailable' },
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
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
    expect(mockAssertProPriceReady).toHaveBeenCalledWith('monthly', 'price_monthly123')
    expect(mockAssertProPriceReady).toHaveBeenCalledWith('yearly', 'price_yearly123')
    expect(mockRpc).toHaveBeenCalledWith('bind_stripe_customer_owner_atomic', {
      p_user_id: 'user-123',
      p_new_stripe_customer_id: 'cus_test123',
      p_expected_previous_stripe_customer_id: null,
    })
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

  it.each(['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'])(
    'blocks a stale-local recurring checkout when Stripe has a %s Pro subscription',
    async (status) => {
      mockListSubscriptions.mockResolvedValue({
        data: [customerSubscription({ id: `sub_pro_${status}`, status })],
        has_more: false,
      })
      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly' }),
      })

      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(409)
      expect(body.code).toBe('ALREADY_SUBSCRIBED')
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    }
  )

  it.each(['canceled', 'incomplete_expired'])(
    'allows recurring checkout when the only exact Pro subscription is terminal: %s',
    async (status) => {
      mockListSubscriptions.mockResolvedValue({
        data: [customerSubscription({ id: `sub_pro_${status}`, status })],
        has_more: false,
      })
      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'yearly' }),
      })

      const res = await POST(req)

      expect(res.status).toBe(200)
      expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1)
    }
  )

  it('fails closed when the local active Pro projection points to a Stripe-terminal subscription', async () => {
    mockSubscriptionQuery.maybeSingle.mockResolvedValue({
      data: {
        tier: 'pro',
        status: 'active',
        stripe_subscription_id: 'sub_pro_terminal',
      },
      error: null,
    })
    mockListSubscriptions.mockResolvedValue({
      data: [
        customerSubscription({
          id: 'sub_pro_terminal',
          status: 'canceled',
        }),
      ],
      has_more: false,
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

  it('fails closed when a local non-terminal Pro projection has no exact Stripe authority', async () => {
    mockSubscriptionQuery.maybeSingle.mockResolvedValue({
      data: {
        tier: 'pro',
        status: 'active',
        stripe_subscription_id: 'sub_missing_from_customer',
      },
      error: null,
    })
    mockListSubscriptions.mockResolvedValue({ data: [], has_more: false })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('isolates a non-terminal API-tier subscription by exact price', async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        customerSubscription({
          id: 'sub_api_active',
          status: 'active',
          priceId: 'price_api_pro',
        }),
      ],
      has_more: false,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1)
  })

  it('finds a non-terminal Pro subscription on the fully paginated second page', async () => {
    const firstHundred = Array.from({ length: 100 }, (_, index) =>
      customerSubscription({
        id: `sub_api_${index + 1}`,
        status: 'active',
        priceId: 'price_api_pro',
      })
    )
    mockListSubscriptions
      .mockResolvedValueOnce({ data: firstHundred, has_more: true })
      .mockResolvedValueOnce({
        data: [customerSubscription({ id: 'sub_pro_101', status: 'past_due' })],
        has_more: false,
      })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(409)
    expect(mockListSubscriptions).toHaveBeenNthCalledWith(2, {
      customer: 'cus_test123',
      status: 'all',
      limit: 100,
      starting_after: 'sub_api_100',
    })
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('paginates subscription items before classifying an exact Pro price', async () => {
    const subscription = customerSubscription({
      id: 'sub_mixed_items',
      status: 'past_due',
      priceId: 'price_api_pro',
    })
    subscription.items.has_more = true
    mockListSubscriptions.mockResolvedValue({ data: [subscription], has_more: false })
    mockListSubscriptionItems.mockResolvedValue({
      data: [
        {
          id: 'si_pro_second',
          subscription: 'sub_mixed_items',
          price: { id: 'price_yearly123' },
        },
      ],
      has_more: false,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(409)
    expect(mockListSubscriptionItems).toHaveBeenCalledWith({
      subscription: 'sub_mixed_items',
      limit: 100,
      starting_after: 'si_mixed_items',
    })
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it.each([
    [
      'customer identity mismatch',
      customerSubscription({
        id: 'sub_wrong_customer',
        status: 'active',
        customerId: 'cus_other',
      }),
    ],
    [
      'missing item identity',
      {
        ...customerSubscription({ id: 'sub_missing_item', status: 'active' }),
        items: {
          data: [{ subscription: 'sub_missing_item', price: { id: 'price_monthly123' } }],
          has_more: false,
        },
      },
    ],
  ])('fails closed on Stripe subscription %s', async (_label, subscription) => {
    mockListSubscriptions.mockResolvedValue({ data: [subscription], has_more: false })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('fails closed when the exact Stripe subscription lookup is unavailable', async () => {
    mockListSubscriptions.mockRejectedValue(new Error('temporary Stripe outage'))
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
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

  it('does not let an API-tier trial consume the exact Pro trial', async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        customerSubscription({
          id: 'sub_api_trial',
          status: 'canceled',
          priceId: 'price_api_pro',
          trialStart: 1_700_000_000,
          trialEnd: 1_700_604_800,
        }),
      ],
      has_more: false,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: true }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ trialDays: 7 })
    )
  })

  it('finds a prior trial on the 101st Stripe subscription and denies another trial', async () => {
    const firstHundred = Array.from({ length: 100 }, (_, index) =>
      customerSubscription({ id: `sub_history_${index + 1}` })
    )
    mockListSubscriptions
      .mockResolvedValueOnce({ data: firstHundred, has_more: true })
      .mockResolvedValueOnce({
        data: [
          customerSubscription({
            id: 'sub_trial_101',
            trialStart: 1_700_000_000,
            trialEnd: 1_700_604_800,
          }),
        ],
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

  it('fails closed on a non-advancing Stripe customer-subscription page', async () => {
    mockListSubscriptions.mockResolvedValue({ data: [], has_more: true })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'yearly', trial: true }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
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
        automatic_tax: { enabled: false },
        adaptive_pricing: { enabled: false },
        expires_at: lifetimeCheckoutExpiresAt,
        metadata: expect.objectContaining({
          lifetime_reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
          lifetime_reservation_nonce: expect.stringMatching(/^lifetime:user-123:/),
        }),
        payment_intent_data: {
          metadata: expect.objectContaining({
            lifetime_reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
          }),
        },
      }),
      {
        idempotencyKey: 'checkout_lifetime_9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
      }
    )
    expect(mockRpc).toHaveBeenCalledWith(
      'bind_lifetime_membership_reservation_session_atomic',
      expect.objectContaining({
        p_user_id: 'user-123',
        p_reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
        p_checkout_session_id: 'cs_lifetime123',
        p_session_expires_at: '2099-01-01T00:00:00.000Z',
      })
    )
  })

  it('uses a fresh retrieved Session instead of trusting the create response snapshot', async () => {
    mockCreateOneTimeCheckoutSession.mockImplementation((params: Record<string, unknown>) => {
      lastCreatedLifetimeCheckoutSession = createdLifetimeCheckoutSession(params)
      return Promise.resolve({
        ...lastCreatedLifetimeCheckoutSession,
        customer: 'cus_untrusted_create_snapshot',
        amount_total: 1,
      })
    })
    mockRetrieveOneTimeCheckoutSession.mockImplementation(() =>
      Promise.resolve(lastCreatedLifetimeCheckoutSession)
    )
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockRetrieveOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123', {
      expand: ['line_items'],
    })
  })

  it('fails closed when lifetime line-item pagination returns an empty continuation', async () => {
    mockListCheckoutLineItems
      .mockResolvedValueOnce({ data: [lifetimeCheckoutLine], has_more: true })
      .mockResolvedValueOnce({ data: [], has_more: false })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockListCheckoutLineItems).toHaveBeenNthCalledWith(2, 'cs_lifetime123', {
      limit: 100,
      starting_after: 'li_lifetime123',
    })
    expect(mockExpireOneTimeCheckoutSession).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'bind_lifetime_membership_reservation_session_atomic'
      )
    ).toHaveLength(0)
  })

  it.each([
    [
      'wrong price',
      {
        ...lifetimeCheckoutLine,
        price: { id: 'price_other' },
      },
    ],
    [
      'wrong amount',
      {
        ...lifetimeCheckoutLine,
        amount_total: 1,
      },
    ],
    [
      'line discount',
      {
        ...lifetimeCheckoutLine,
        amount_discount: 100,
        amount_total: 4899,
      },
    ],
  ])(
    'expires, durably reviews, and returns 503 for a lifetime line with %s',
    async (_label, line) => {
      mockListCheckoutLineItems.mockResolvedValue({ data: [line], has_more: false })
      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'lifetime' }),
      })

      const res = await POST(req)

      expect(res.status).toBe(503)
      expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123')
      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'cs_lifetime123',
          reasonKey: 'lifetime_checkout_recovery_identity_conflict',
        })
      )
      expect(
        mockRpc.mock.calls.filter(
          ([name]) => name === 'release_lifetime_membership_reservation_atomic'
        )
      ).toHaveLength(0)
      expect(
        mockRpc.mock.calls.filter(
          ([name]) => name === 'bind_lifetime_membership_reservation_session_atomic'
        )
      ).toHaveLength(0)
    }
  )

  it('expires and reviews a lifetime Session with more than one complete line item', async () => {
    mockListCheckoutLineItems
      .mockResolvedValueOnce({ data: [lifetimeCheckoutLine], has_more: true })
      .mockResolvedValueOnce({
        data: [{ ...lifetimeCheckoutLine, id: 'li_unexpected_second' }],
        has_more: false,
      })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123')
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ actual_line_count: 2 }),
      })
    )
  })

  it('expires and reviews a lifetime Session with a non-zero Session discount', async () => {
    mockRetrieveOneTimeCheckoutSession.mockImplementation(() =>
      Promise.resolve({
        ...lastCreatedLifetimeCheckoutSession,
        total_details: { amount_discount: 100, amount_tax: 0 },
      })
    )
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123')
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ actual_session_discount: 100 }),
      })
    )
  })

  it.each([
    [
      'enabled promotion codes',
      {
        allow_promotion_codes: true,
      },
    ],
    [
      'enabled automatic tax',
      {
        automatic_tax: { enabled: true },
      },
    ],
    [
      'enabled expiry recovery',
      {
        after_expiration: { recovery: { enabled: true } },
      },
    ],
    [
      'enabled adaptive pricing',
      {
        adaptive_pricing: { enabled: true },
      },
    ],
  ])('expires and reviews a lifetime Session with %s', async (_label, overrides) => {
    mockRetrieveOneTimeCheckoutSession.mockImplementation(() =>
      Promise.resolve({
        ...lastCreatedLifetimeCheckoutSession,
        ...overrides,
      })
    )
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123')
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalled()
  })

  it.each([
    ['a nullable promotion-code flag', { allow_promotion_codes: null }],
    ['nullable adaptive pricing', { adaptive_pricing: null }],
  ])('accepts a lifetime Session with %s disabled', async (_label, overrides) => {
    mockRetrieveOneTimeCheckoutSession.mockImplementation(() =>
      Promise.resolve({
        ...lastCreatedLifetimeCheckoutSession,
        ...overrides,
      })
    )
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockExpireOneTimeCheckoutSession).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each([
    ['unexpanded line discounts', { discounts: undefined }],
    ['unexpanded line taxes', { taxes: undefined }],
  ])('accepts a lifetime Session with %s', async (_label, lineOverrides) => {
    mockListCheckoutLineItems.mockResolvedValue({
      data: [{ ...lifetimeCheckoutLine, ...lineOverrides }],
      has_more: false,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockExpireOneTimeCheckoutSession).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('expires and reviews a lifetime Session with a line tax entry', async () => {
    mockListCheckoutLineItems.mockResolvedValue({
      data: [{ ...lifetimeCheckoutLine, taxes: [{ amount: 0 }] }],
      has_more: false,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123')
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalled()
  })

  it('recovers the exact bound lifetime Session after the original response was lost', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_lifetime_membership_spot_atomic') {
        return Promise.resolve({
          data: {
            status: 'reservation_exists',
            reservation_status: 'bound',
            reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
            request_nonce: 'lifetime:user-123:original',
            checkout_expires_at: '2099-01-01T00:00:00.000Z',
            checkout_session_id: 'cs_lifetime123',
          },
          error: null,
        })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_lifetime123',
      sessionId: 'cs_lifetime123',
    })
    expect(mockRetrieveOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123', {
      expand: ['line_items'],
    })
    expect(mockListCheckoutLineItems).toHaveBeenCalledWith('cs_lifetime123', { limit: 100 })
    expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'bind_lifetime_membership_reservation_session_atomic'
      )
    ).toHaveLength(0)
  })

  it('records a durable review and never creates a second Session on bound recovery mismatch', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_lifetime_membership_spot_atomic') {
        return Promise.resolve({
          data: {
            status: 'reservation_exists',
            reservation_status: 'bound',
            reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
            request_nonce: 'lifetime:user-123:original',
            checkout_expires_at: '2099-01-01T00:00:00.000Z',
            checkout_session_id: 'cs_lifetime123',
          },
          error: null,
        })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    mockRetrieveOneTimeCheckoutSession.mockResolvedValue({
      ...recoveredLifetimeCheckoutSession,
      customer: 'cus_other',
    })

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'checkout_session',
        sessionId: 'cs_lifetime123',
        reasonKey: 'lifetime_checkout_recovery_identity_conflict',
      })
    )
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123')
    expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
  })

  it('keeps a safe 503 when deterministic recovery review persistence fails', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_lifetime_membership_spot_atomic') {
        return Promise.resolve({
          data: {
            status: 'reservation_exists',
            reservation_status: 'bound',
            reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
            request_nonce: 'lifetime:user-123:original',
            checkout_expires_at: '2099-01-01T00:00:00.000Z',
            checkout_session_id: 'cs_lifetime123',
          },
          error: null,
        })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    mockRetrieveOneTimeCheckoutSession.mockResolvedValue({
      ...recoveredLifetimeCheckoutSession,
      status: 'expired',
      url: null,
    })
    mockRecordStripeCheckoutManualReview.mockRejectedValue(
      new Error('manual review persistence unavailable')
    )

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledTimes(1)
    expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
  })

  it('reuses the original reservation nonce across minutes after an ambiguous create response loss', async () => {
    let now = Date.parse('2030-01-01T00:00:30.000Z')
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    let originalRequestNonce = ''
    let reservationCalls = 0
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_lifetime_membership_spot_atomic') {
        reservationCalls += 1
        if (reservationCalls === 1) {
          originalRequestNonce = String(args.p_request_nonce)
          return Promise.resolve({
            data: {
              status: 'reserved',
              reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
              checkout_expires_at: '2099-01-01T00:00:00.000Z',
            },
            error: null,
          })
        }
        return Promise.resolve({
          data: {
            status: 'reservation_exists',
            reservation_status: 'reserved',
            reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
            request_nonce: originalRequestNonce,
            checkout_expires_at: '2099-01-01T00:00:00.000Z',
            checkout_session_id: null,
          },
          error: null,
        })
      }
      if (name === 'bind_lifetime_membership_reservation_session_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'release_lifetime_membership_reservation_atomic') {
        return Promise.resolve({ data: { status: 'released' }, error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    mockCreateOneTimeCheckoutSession
      .mockRejectedValueOnce(
        Object.assign(new Error('connection lost after Stripe committed'), {
          type: 'StripeConnectionError',
          code: 'ECONNRESET',
        })
      )
      .mockImplementationOnce((params: Record<string, unknown>) => {
        lastCreatedLifetimeCheckoutSession = createdLifetimeCheckoutSession(params)
        return Promise.resolve(lastCreatedLifetimeCheckoutSession)
      })

    try {
      const first = await POST(
        new NextRequest('http://localhost/api/stripe/create-checkout', {
          method: 'POST',
          headers: { authorization: 'Bearer valid-token' },
          body: JSON.stringify({ plan: 'lifetime' }),
        })
      )
      expect(first.status).toBe(500)

      now += 2 * 60_000
      const second = await POST(
        new NextRequest('http://localhost/api/stripe/create-checkout', {
          method: 'POST',
          headers: { authorization: 'Bearer valid-token' },
          body: JSON.stringify({ plan: 'lifetime' }),
        })
      )

      expect(second.status).toBe(200)
      expect(originalRequestNonce).toBe('lifetime:user-123:31557600')
      expect(mockCreateOneTimeCheckoutSession).toHaveBeenCalledTimes(2)
      expect(mockCreateOneTimeCheckoutSession.mock.calls[0][1]).toEqual({
        idempotencyKey: 'checkout_lifetime_9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
      })
      expect(mockCreateOneTimeCheckoutSession.mock.calls[1][1]).toEqual({
        idempotencyKey: 'checkout_lifetime_9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
      })
      expect(mockCreateOneTimeCheckoutSession.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({
            lifetime_reservation_nonce: originalRequestNonce,
          }),
        })
      )
      expect(mockRpc).toHaveBeenCalledWith(
        'bind_lifetime_membership_reservation_session_atomic',
        expect.objectContaining({ p_request_nonce: originalRequestNonce })
      )
      expect(
        mockRpc.mock.calls.filter(
          ([name]) => name === 'release_lifetime_membership_reservation_atomic'
        )
      ).toHaveLength(0)
    } finally {
      dateNowSpy.mockRestore()
    }
  })

  it('never binds or returns a terminal Session replayed by Stripe idempotency', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_lifetime_membership_spot_atomic') {
        return Promise.resolve({
          data: {
            status: 'reservation_exists',
            reservation_status: 'reserved',
            reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
            request_nonce: 'lifetime:user-123:original',
            checkout_expires_at: '2099-01-01T00:00:00.000Z',
            checkout_session_id: null,
          },
          error: null,
        })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    mockCreateOneTimeCheckoutSession.mockImplementation((params: Record<string, unknown>) => {
      lastCreatedLifetimeCheckoutSession = createdLifetimeCheckoutSession(params, {
        status: 'complete',
        payment_status: 'paid',
        url: null,
      })
      return Promise.resolve(lastCreatedLifetimeCheckoutSession)
    })

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cs_lifetime123',
        reasonKey: 'lifetime_checkout_recovery_identity_conflict',
      })
    )
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'bind_lifetime_membership_reservation_session_atomic'
      )
    ).toHaveLength(0)
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'release_lifetime_membership_reservation_atomic'
      )
    ).toHaveLength(0)
  })

  it('fails closed without creating Stripe Checkout when lifetime capacity is sold out', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_lifetime_membership_spot_atomic') {
        return Promise.resolve({ data: { status: 'sold_out' }, error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(410)
    expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
  })

  it('preserves the durable seat even when Stripe rejects creation before execution', async () => {
    mockCreateOneTimeCheckoutSession.mockRejectedValue(
      Object.assign(new Error('Stripe authentication rejected the request'), {
        type: 'StripeAuthenticationError',
      })
    )

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(500)
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'release_lifetime_membership_reservation_atomic'
      )
    ).toHaveLength(0)
  })

  it('preserves the seat for an InvalidRequest idempotency conflict that may have created a Session', async () => {
    mockCreateOneTimeCheckoutSession.mockRejectedValue(
      Object.assign(new Error('Idempotency key was reused with different parameters'), {
        type: 'StripeInvalidRequestError',
        code: 'idempotency_key_in_use',
      })
    )

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(500)
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'release_lifetime_membership_reservation_atomic'
      )
    ).toHaveLength(0)
  })

  it('expires an unbound payable Session but preserves its seat for the signed webhook', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_lifetime_membership_spot_atomic') {
        return Promise.resolve({
          data: {
            status: 'reserved',
            reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
            checkout_expires_at: '2099-01-01T00:00:00.000Z',
          },
          error: null,
        })
      }
      if (name === 'bind_lifetime_membership_reservation_session_atomic') {
        return Promise.resolve({ data: { status: 'identity_conflict' }, error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123')
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'release_lifetime_membership_reservation_atomic'
      )
    ).toHaveLength(0)
  })

  it('preserves the seat when expiring an unbound payable Session fails', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_lifetime_membership_spot_atomic') {
        return Promise.resolve({
          data: {
            status: 'reserved',
            reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
            checkout_expires_at: '2099-01-01T00:00:00.000Z',
          },
          error: null,
        })
      }
      if (name === 'bind_lifetime_membership_reservation_session_atomic') {
        return Promise.resolve({ data: { status: 'identity_conflict' }, error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    mockExpireOneTimeCheckoutSession.mockRejectedValue(new Error('Stripe expire unavailable'))

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123')
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'release_lifetime_membership_reservation_atomic'
      )
    ).toHaveLength(0)
  })

  it('preserves the seat after a created Session returns mismatched immutable identity', async () => {
    mockCreateOneTimeCheckoutSession.mockImplementation((params: Record<string, unknown>) => {
      lastCreatedLifetimeCheckoutSession = createdLifetimeCheckoutSession(params, {
        expires_at: lifetimeCheckoutExpiresAt + 60,
      })
      return Promise.resolve(lastCreatedLifetimeCheckoutSession)
    })

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_lifetime123')
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'release_lifetime_membership_reservation_atomic'
      )
    ).toHaveLength(0)
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'bind_lifetime_membership_reservation_session_atomic'
      )
    ).toHaveLength(0)
  })

  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['non-exact uppercase value', 'TRUE'],
  ])(
    'blocks Production lifetime checkout when the server flag is %s before payment work',
    async (_label, flagValue) => {
      process.env.VERCEL_ENV = 'production'
      if (flagValue === undefined) {
        delete process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED
      } else {
        process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED = flagValue
      }

      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'lifetime' }),
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(503)
      expect(body).toEqual({
        error: 'Lifetime checkout is temporarily unavailable.',
        code: 'LIFETIME_CHECKOUT_UNAVAILABLE',
      })
      expect(mockExtractUser).not.toHaveBeenCalled()
      expect(mockBillingProfileSingle).not.toHaveBeenCalled()
      expect(mockAssertStripePaymentRuntimeReady).not.toHaveBeenCalled()
      expect(mockAssertProPriceReady).not.toHaveBeenCalled()
      expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
      expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
    }
  )

  it.each(['monthly', 'yearly'])(
    'keeps Production %s checkout available without the lifetime flag',
    async (plan) => {
      process.env.VERCEL_ENV = 'production'
      delete process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED

      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan }),
      })
      const res = await POST(req)

      expect(res.status).toBe(200)
      expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1)
      expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
    }
  )

  it('allows Production lifetime checkout only when the server flag is exactly true', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED = 'true'

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'lifetime' }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      url: 'https://checkout.stripe.com/lifetime',
      sessionId: 'cs_lifetime123',
    })
    expect(mockAssertStripePaymentRuntimeReady).toHaveBeenCalledTimes(1)
    expect(mockAssertProPriceReady).toHaveBeenCalledWith('lifetime', 'price_lifetime123')
    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledTimes(1)
    expect(mockCreateOneTimeCheckoutSession).toHaveBeenCalledTimes(1)
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
