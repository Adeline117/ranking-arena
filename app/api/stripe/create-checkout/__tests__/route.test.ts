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
    headers: {
      get: (key: string) => string | null
      set: (key: string, value: string) => void
    }
    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
      const values = new Map(
        Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
      )
      this.headers = {
        get: (key: string) => values.get(key.toLowerCase()) || null,
        set: (key: string, value: string) => {
          values.set(key.toLowerCase(), value)
        },
      }
    }
    async json() {
      return this._body
    }
    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
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
        Object.entries({
          'user-agent': 'Mozilla/5.0 (Test)',
          origin: 'https://app.test.com',
          'sec-fetch-site': 'same-origin',
          ...(opts?.headers || {}),
        }).map(([key, value]) => [key.toLowerCase(), value])
      )
      this._body = opts?.body
    }

    get headers() {
      const headers = this._headers
      return { get: (key: string) => headers.get(key.toLowerCase()) || null }
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
const mockListCheckoutSessions = jest.fn()
const mockListStripeEvents = jest.fn()
const mockRetrieveStripeEvent = jest.fn()
const mockExpireOneTimeCheckoutSession = jest.fn()
const mockRetrieveOneTimeCheckoutSession = jest.fn()
const mockRetrieveCustomer = jest.fn()
const mockHandleCheckoutComplete = jest.fn()
const lifetimeCheckoutExpiresAt = Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000)
const proCheckoutExpiresAt = lifetimeCheckoutExpiresAt - 3600
const proReservationId = '71e34ce2-43c1-4bcc-8f19-79b36d56605c'

jest.mock('@/app/api/stripe/webhook/handlers/checkout', () => ({
  handleCheckoutComplete: (...args: unknown[]) => mockHandleCheckoutComplete(...args),
}))
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

function createdProCheckoutSession(
  params: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  const priceId = String(params.priceId)
  const yearly = priceId === 'price_yearly123'
  const priceAmount = yearly ? 2999 : 499
  const amount = params.trialDays === 7 ? 0 : priceAmount
  return {
    id: 'cs_test123',
    object: 'checkout.session',
    customer: params.customerId,
    metadata: params.metadata,
    created: Number(params.expiresAt) - 2700,
    expires_at: params.expiresAt,
    client_reference_id: params.clientReferenceId,
    mode: 'subscription',
    status: 'open',
    payment_status: 'unpaid',
    subscription: null,
    after_expiration: null,
    url: 'https://checkout.stripe.com/session',
    livemode: false,
    currency: 'usd',
    amount_subtotal: amount,
    amount_total: amount,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    discounts: [],
    optional_items: [],
    custom_fields: [],
    allow_promotion_codes: false,
    automatic_tax: { enabled: false },
    adaptive_pricing: { enabled: false },
    ...overrides,
  }
}

function proCheckoutMetadata(plan: 'monthly' | 'yearly' = 'monthly', trialDays: 0 | 7 = 0) {
  const yearly = plan === 'yearly'
  return {
    currency: 'usd',
    userId: 'user-123',
    supabase_user_id: 'user-123',
    type: 'pro_membership',
    plan,
    pro_membership_reservation_id: proReservationId,
    pro_price_id: yearly ? 'price_yearly123' : 'price_monthly123',
    trial_days: String(trialDays),
    unit_amount: String(yearly ? 2999 : 499),
  }
}

function proCheckoutLine(priceId: string, trialDays: 0 | 7 = 0) {
  const yearly = priceId === 'price_yearly123'
  const priceAmount = yearly ? 2999 : 499
  const amount = trialDays === 7 ? 0 : priceAmount
  return {
    id: 'li_pro123',
    object: 'item',
    price: {
      id: priceId,
      object: 'price',
      active: true,
      billing_scheme: 'per_unit',
      currency: 'usd',
      currency_options: undefined,
      custom_unit_amount: null,
      livemode: false,
      recurring: {
        interval: yearly ? 'year' : 'month',
        interval_count: 1,
        usage_type: 'licensed',
      },
      tiers_mode: null,
      transform_quantity: null,
      type: 'recurring',
      unit_amount: priceAmount,
      unit_amount_decimal: String(priceAmount),
    },
    quantity: 1,
    currency: 'usd',
    amount_subtotal: amount,
    amount_total: amount,
    amount_discount: 0,
    amount_tax: 0,
    discounts: [],
    taxes: [],
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
  const priceId = params.priceId || 'price_monthly123'
  const yearly = priceId === 'price_yearly123'
  const amount = yearly ? 2999 : priceId.startsWith('price_api_') ? 1000 : 499
  return {
    id: params.id,
    object: 'subscription',
    livemode: false,
    customer: params.customerId || 'cus_test123',
    status: params.status || 'canceled',
    trial_start: params.trialStart ?? null,
    trial_end: params.trialEnd ?? null,
    items: {
      data: [
        {
          id: `si_${params.id.slice(4)}`,
          object: 'subscription_item',
          subscription: params.id,
          quantity: 1,
          discounts: [],
          tax_rates: [],
          price: {
            id: priceId,
            object: 'price',
            livemode: false,
            type: 'recurring',
            billing_scheme: 'per_unit',
            currency: 'usd',
            unit_amount: amount,
            custom_unit_amount: null,
            transform_quantity: null,
            tiers_mode: null,
            recurring: {
              interval: yearly ? 'year' : 'month',
              interval_count: 1,
              usage_type: 'licensed',
            },
          },
        },
      ],
      has_more: false,
    },
  }
}

const mockCreateOneTimeCheckoutSession = jest.fn()
let lastCreatedLifetimeCheckoutSession: Record<string, unknown> | null = null
let lastCreatedProCheckoutSession: Record<string, unknown> | null = null
let lastCreatedProCheckoutPriceId = 'price_monthly123'
let lastCreatedProCheckoutTrialDays: 0 | 7 = 0

function installProReservationRpc(
  params: {
    reservation?: Record<string, unknown>
    bind?:
      | { data: unknown; error: { code?: string; message?: string } | null; status?: number }
      | Error
    observation?:
      | { data: unknown; error: { code?: string; message?: string } | null; status?: number }
      | Error
  } = {}
) {
  mockRpc.mockImplementation((name: string, args?: Record<string, unknown>) => {
    if (name === 'bind_stripe_customer_owner_atomic') {
      return Promise.resolve({ data: { status: 'bound' }, error: null, status: 200 })
    }
    if (name === 'reserve_pro_membership_checkout_atomic') {
      return Promise.resolve({
        data: {
          status: 'reserved',
          reservation_id: proReservationId,
          pro_plan: args?.p_pro_plan,
          stripe_price_id: args?.p_stripe_price_id,
          unit_amount: args?.p_unit_amount,
          currency: args?.p_currency,
          trial_days: args?.p_trial_days,
          success_url: args?.p_success_url,
          cancel_url: args?.p_cancel_url,
          checkout_expires_at: proCheckoutExpiresAt,
          checkout_session_id: null,
          ...params.reservation,
        },
        error: null,
        status: 200,
      })
    }
    if (name === 'resolve_b2c_recurring_price_authority') {
      return Promise.resolve({ data: { status: 'not_found' }, error: null, status: 200 })
    }
    if (name === 'bind_pro_membership_checkout_session_atomic') {
      if (params.bind instanceof Error) return Promise.reject(params.bind)
      return Promise.resolve(params.bind || { data: { status: 'bound' }, error: null, status: 200 })
    }
    if (name === 'release_pro_membership_checkout_observation_atomic') {
      if (params.observation instanceof Error) return Promise.reject(params.observation)
      return Promise.resolve(
        params.observation || { data: { status: 'released' }, error: null, status: 200 }
      )
    }
    throw new Error(`Unexpected RPC ${name}`)
  })
}
const mockGetStripe = jest.fn(() => ({
  customers: {
    retrieve: (...args: unknown[]) => mockRetrieveCustomer(...args),
  },
  checkout: {
    sessions: {
      create: (...args: unknown[]) => mockCreateOneTimeCheckoutSession(...args),
      expire: (...args: unknown[]) => mockExpireOneTimeCheckoutSession(...args),
      retrieve: (...args: unknown[]) => mockRetrieveOneTimeCheckoutSession(...args),
      listLineItems: (...args: unknown[]) => mockListCheckoutLineItems(...args),
      list: (...args: unknown[]) => mockListCheckoutSessions(...args),
    },
  },
  events: {
    list: (...args: unknown[]) => mockListStripeEvents(...args),
    retrieve: (...args: unknown[]) => mockRetrieveStripeEvent(...args),
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
  STRIPE_API_PRICE_IDS: {
    starter: 'price_api_starter',
    pro: 'price_api_pro',
  },
  getOrCreateStripeCustomer: (...args: unknown[]) => mockGetOrCreateStripeCustomer(...args),
  assertProPriceReady: (...args: unknown[]) => mockAssertProPriceReady(...args),
  assertStripePaymentRuntimeReady: () => mockAssertStripePaymentRuntimeReady(),
  createCheckoutSession: (...args: unknown[]) => mockCreateCheckoutSession(...args),
  getStripe: () => mockGetStripe(),
}))
const mockAssertUserStripeBillingSurfaceAccess = jest.fn()
jest.mock('@/lib/stripe/billing-surface-access', () => ({
  BILLING_SURFACE_UNAVAILABLE_MESSAGE: 'Billing is temporarily unavailable. Please retry.',
  assertUserStripeBillingSurfaceAccess: (...args: unknown[]) =>
    mockAssertUserStripeBillingSurfaceAccess(...args),
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
import { recoverExpiredProCheckoutReservation } from '@/lib/stripe/pro-checkout-recovery'
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
    mockAssertUserStripeBillingSurfaceAccess.mockResolvedValue(undefined)
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_test123')
    mockRetrieveCustomer.mockResolvedValue({
      id: 'cus_test123',
      object: 'customer',
      livemode: false,
      metadata: { userId: 'user-123' },
    })
    mockBillingProfileSingle.mockResolvedValue({
      data: { stripe_customer_id: null },
      error: null,
    })
    mockRpc.mockImplementation((name: string, args?: Record<string, unknown>) => {
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
      if (name === 'reserve_pro_membership_checkout_atomic') {
        return Promise.resolve({
          data: {
            status: 'reserved',
            reservation_id: proReservationId,
            pro_plan: args?.p_pro_plan,
            stripe_price_id: args?.p_stripe_price_id,
            unit_amount: args?.p_unit_amount,
            currency: args?.p_currency,
            trial_days: args?.p_trial_days,
            success_url: args?.p_success_url,
            cancel_url: args?.p_cancel_url,
            checkout_expires_at: proCheckoutExpiresAt,
            checkout_session_id: null,
          },
          error: null,
          status: 200,
        })
      }
      if (name === 'resolve_b2c_recurring_price_authority') {
        return Promise.resolve({ data: { status: 'not_found' }, error: null, status: 200 })
      }
      if (name === 'bind_pro_membership_checkout_session_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null, status: 200 })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    mockAssertProPriceReady.mockResolvedValue(undefined)
    mockAssertStripePaymentRuntimeReady.mockReturnValue(undefined)
    lastCreatedProCheckoutSession = null
    lastCreatedProCheckoutPriceId = 'price_monthly123'
    lastCreatedProCheckoutTrialDays = 0
    mockCreateCheckoutSession.mockImplementation((params: Record<string, unknown>) => {
      lastCreatedProCheckoutPriceId = String(params.priceId)
      lastCreatedProCheckoutTrialDays = params.trialDays === 7 ? 7 : 0
      lastCreatedProCheckoutSession = createdProCheckoutSession(params)
      return Promise.resolve({ id: 'cs_test123' })
    })
    lastCreatedLifetimeCheckoutSession = null
    mockCreateOneTimeCheckoutSession.mockImplementation((params: Record<string, unknown>) => {
      lastCreatedLifetimeCheckoutSession = createdLifetimeCheckoutSession(params)
      return Promise.resolve(lastCreatedLifetimeCheckoutSession)
    })
    mockRetrieveOneTimeCheckoutSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'cs_test123') {
        return Promise.resolve(lastCreatedProCheckoutSession)
      }
      return Promise.resolve(lastCreatedLifetimeCheckoutSession || recoveredLifetimeCheckoutSession)
    })
    mockListCheckoutLineItems.mockImplementation((sessionId: string) => {
      if (sessionId === 'cs_test123') {
        return Promise.resolve({
          data: [proCheckoutLine(lastCreatedProCheckoutPriceId, lastCreatedProCheckoutTrialDays)],
          has_more: false,
        })
      }
      return Promise.resolve({
        data: [lifetimeCheckoutLine],
        has_more: false,
      })
    })
    mockListSubscriptionItems.mockResolvedValue({ data: [], has_more: false })
    mockListCheckoutSessions.mockResolvedValue({ data: [], has_more: false })
    mockListStripeEvents.mockResolvedValue({ data: [], has_more: false })
    mockHandleCheckoutComplete.mockResolvedValue(undefined)
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

  it.each([
    ['a missing Origin', null, 'same-origin'],
    ['a foreign Origin', 'https://attacker.example', 'same-origin'],
    ['a missing Sec-Fetch-Site', 'https://app.test.com', null],
    ['a cross-site fetch context', 'https://app.test.com', 'cross-site'],
  ])(
    'rejects %s before rate limiting, authentication, database, or Stripe work',
    async (_label, origin, fetchSite) => {
      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
      const requestHeaders = (req as unknown as { _headers: Map<string, string> })._headers
      if (origin === null) requestHeaders.delete('origin')
      else requestHeaders.set('origin', origin)
      if (fetchSite === null) requestHeaders.delete('sec-fetch-site')
      else requestHeaders.set('sec-fetch-site', fetchSite)

      const res = await POST(req)

      expect(res.status).toBe(403)
      expect(res.headers.get('Cache-Control')).toBe('private, no-store')
      expect(mockCheckRateLimit).not.toHaveBeenCalled()
      expect(mockExtractUser).not.toHaveBeenCalled()
      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    }
  )

  it('does not let a poisoned request Host redefine the trusted application Origin', async () => {
    const req = new NextRequest('https://poisoned.example/api/stripe/create-checkout', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        origin: 'https://poisoned.example',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(403)
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockExtractUser).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('returns rate limit response when rate limited', async () => {
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    mockCheckRateLimit.mockResolvedValue(
      NextResponse.json({ error: 'Rate limited' }, { status: 429 })
    )

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })
    const res = await POST(req)

    expect(res.status).toBe(429)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  // --- Stripe Not Configured ---

  it('returns 503 when STRIPE_SECRET_KEY is not set', async () => {
    mockEnv.STRIPE_SECRET_KEY = undefined

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.error).toMatch(/not configured/)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  // --- Authentication ---

  it('returns 401 when auth token is invalid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid token' } })
    mockExtractUser.mockResolvedValue({ user: null, error: 'Invalid token' })

    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer invalid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })
    const res = await POST(req)
    await res.json()

    expect(res.status).toBe(401)
  })

  // --- Input Validation ---

  it.each([
    ['an omitted recurring choice', { plan: 'monthly' }, 'TRIAL_CHOICE_REQUIRED'],
    ['a string trial choice', { plan: 'monthly', trial: 'true' }, 'INVALID_TRIAL_CHOICE'],
    ['a numeric trial choice', { plan: 'yearly', trial: 1 }, 'INVALID_TRIAL_CHOICE'],
    ['a null trial choice', { plan: 'monthly', trial: null }, 'INVALID_TRIAL_CHOICE'],
    ['a trial on lifetime', { plan: 'lifetime', trial: true }, 'INVALID_TRIAL_CHOICE'],
  ])(
    'rejects %s before rate, auth, database, or Stripe side effects',
    async (_label, input, code) => {
      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify(input),
      })

      const res = await POST(req)

      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual(expect.objectContaining({ code }))
      expect(mockCheckRateLimit).not.toHaveBeenCalled()
      expect(mockExtractUser).not.toHaveBeenCalled()
      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    }
  )

  it('rejects malformed JSON before rate, auth, database, or Stripe side effects', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: '{',
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ code: 'INVALID_JSON' }))
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockExtractUser).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('fails closed when a fresh Stripe Customer retrieve is unavailable', async () => {
    mockRetrieveCustomer.mockRejectedValue(new Error('temporary Stripe read outage'))
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it.each([
    ['deleted Customer', { id: 'cus_test123', object: 'customer', deleted: true }],
    [
      'wrong Stripe mode',
      {
        id: 'cus_test123',
        object: 'customer',
        livemode: true,
        metadata: { userId: 'user-123' },
      },
    ],
    [
      'conflicting user alias',
      {
        id: 'cus_test123',
        object: 'customer',
        livemode: false,
        metadata: { userId: 'user-123', supabase_user_id: 'attacker' },
      },
    ],
    [
      'ownerless Customer',
      {
        id: 'cus_test123',
        object: 'customer',
        livemode: false,
        metadata: {},
      },
    ],
  ])('fails closed on a freshly attested %s', async (_label, customer) => {
    mockRetrieveCustomer.mockResolvedValue(customer)
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('blocks checkout when exact Stripe customer ownership conflicts', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'identity_conflict' }, error: null })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
  })

  // --- Success Cases ---

  it.each(['blocked', 'database error', 'malformed acknowledgement'])(
    'fails closed before every Stripe side effect when billing access is %s',
    async (reason) => {
      mockAssertUserStripeBillingSurfaceAccess.mockRejectedValueOnce(new Error(reason))
      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })

      const res = await POST(req)

      expect(res.status).toBe(503)
      await expect(res.json()).resolves.toEqual({
        error: 'Billing is temporarily unavailable. Please retry.',
      })
      expect(mockAssertUserStripeBillingSurfaceAccess).toHaveBeenCalledWith('user-123')
      expect(mockBillingProfileSingle).not.toHaveBeenCalled()
      expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
      expect(mockGetStripe).not.toHaveBeenCalled()
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
      expect(mockCreateOneTimeCheckoutSession).not.toHaveBeenCalled()
      expect(mockRpc).not.toHaveBeenCalled()
    }
  )

  it('creates monthly subscription checkout session', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.url).toBeDefined()
    expect(body.sessionId).toBeDefined()
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockAssertUserStripeBillingSurfaceAccess).toHaveBeenCalledWith('user-123')
    expect(mockAssertUserStripeBillingSurfaceAccess.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetOrCreateStripeCustomer.mock.invocationCallOrder[0]
    )
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
      body: JSON.stringify({ plan: 'yearly', trial: false }),
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

  it('uses one durable reservation UUID for Stripe idempotency, metadata, expiry, and client identity', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('reserve_pro_membership_checkout_atomic', {
      p_user_id: 'user-123',
      p_livemode: false,
      p_stripe_customer_id: 'cus_test123',
      p_pro_plan: 'monthly',
      p_stripe_price_id: 'price_monthly123',
      p_unit_amount: 499,
      p_currency: 'usd',
      p_trial_days: 0,
      p_success_url: 'https://app.test.com/pricing/success?session_id={CHECKOUT_SESSION_ID}',
      p_cancel_url: 'https://app.test.com/pricing',
    })
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      customerId: 'cus_test123',
      priceId: 'price_monthly123',
      successUrl: 'https://app.test.com/pricing/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.test.com/pricing',
      metadata: {
        currency: 'usd',
        userId: 'user-123',
        supabase_user_id: 'user-123',
        type: 'pro_membership',
        plan: 'monthly',
        pro_membership_reservation_id: proReservationId,
        pro_price_id: 'price_monthly123',
        trial_days: '0',
        unit_amount: '499',
      },
      allowPromotionCodes: false,
      idempotencyKey: `pro_membership_checkout_test_${proReservationId}`,
      expiresAt: proCheckoutExpiresAt,
      clientReferenceId: proReservationId,
    })
    expect(mockRetrieveOneTimeCheckoutSession).toHaveBeenCalledWith('cs_test123', {
      expand: ['line_items.data.price'],
    })
    expect(mockListCheckoutLineItems).toHaveBeenCalledWith('cs_test123', {
      limit: 100,
      expand: ['data.price'],
    })
    expect(mockRpc).toHaveBeenCalledWith('bind_pro_membership_checkout_session_atomic', {
      p_reservation_id: proReservationId,
      p_user_id: 'user-123',
      p_livemode: false,
      p_stripe_customer_id: 'cus_test123',
      p_pro_plan: 'monthly',
      p_stripe_price_id: 'price_monthly123',
      p_unit_amount: 499,
      p_currency: 'usd',
      p_trial_days: 0,
      p_checkout_session_id: 'cs_test123',
      p_checkout_expires_at: proCheckoutExpiresAt,
    })
  })

  it('returns 409 when another plan already owns the active durable reservation', async () => {
    installProReservationRpc({
      reservation: {
        status: 'existing',
        pro_plan: 'yearly',
        stripe_price_id: 'price_yearly123',
      },
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('PRO_CHECKOUT_CONFLICT')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('never reuses an existing trial reservation for an explicit paid request', async () => {
    installProReservationRpc({
      reservation: {
        status: 'existing',
        trial_days: 7,
      },
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('PRO_CHECKOUT_CONFLICT')
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    expect(mockRetrieveOneTimeCheckoutSession).not.toHaveBeenCalled()
  })

  it('never reuses an existing reservation with different exact redirect URLs', async () => {
    installProReservationRpc({
      reservation: {
        status: 'existing',
        success_url: 'https://app.test.com/pricing/success?flow=older',
      },
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('PRO_CHECKOUT_CONFLICT')
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    expect(mockRetrieveOneTimeCheckoutSession).not.toHaveBeenCalled()
  })

  it('withholds an existing reservation whose persisted redirect leaves the canonical app origin', async () => {
    installProReservationRpc({
      reservation: {
        status: 'existing',
        success_url: 'https://attacker.example/paid',
      },
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    expect(mockRetrieveOneTimeCheckoutSession).not.toHaveBeenCalled()
  })

  it('recovers and verifies the exact bound Session without creating another one', async () => {
    const metadata = {
      currency: 'usd',
      userId: 'user-123',
      supabase_user_id: 'user-123',
      type: 'pro_membership',
      plan: 'monthly',
      pro_membership_reservation_id: proReservationId,
      pro_price_id: 'price_monthly123',
      trial_days: '0',
      unit_amount: '499',
    }
    lastCreatedProCheckoutSession = createdProCheckoutSession({
      customerId: 'cus_test123',
      priceId: 'price_monthly123',
      metadata,
      expiresAt: proCheckoutExpiresAt,
      clientReferenceId: proReservationId,
    })
    installProReservationRpc({
      reservation: {
        status: 'existing',
        checkout_session_id: 'cs_test123',
      },
      bind: { data: { status: 'already_bound' }, error: null, status: 200 },
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    expect(mockRetrieveOneTimeCheckoutSession).toHaveBeenCalledWith('cs_test123', {
      expand: ['line_items.data.price'],
    })
  })

  it('releases an expired bound reservation from a fresh exact expired Session even after its Price is deactivated', async () => {
    const checkoutExpiresAt = Math.floor(Date.now() / 1000) - 3600
    const metadata = proCheckoutMetadata()
    lastCreatedProCheckoutSession = createdProCheckoutSession(
      {
        customerId: 'cus_test123',
        priceId: 'price_monthly123',
        metadata,
        expiresAt: checkoutExpiresAt,
        clientReferenceId: proReservationId,
      },
      { status: 'expired', url: null }
    )
    const inactiveLine = proCheckoutLine('price_monthly123')
    inactiveLine.price.active = false
    mockListCheckoutLineItems.mockResolvedValue({ data: [inactiveLine], has_more: false })
    installProReservationRpc({
      reservation: {
        status: 'existing',
        checkout_expires_at: checkoutExpiresAt,
        checkout_session_id: 'cs_test123',
      },
    })

    const res = await POST(
      new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
    )

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ code: 'PRO_CHECKOUT_RECOVERED' })
    expect(mockRpc).toHaveBeenCalledWith(
      'release_pro_membership_checkout_observation_atomic',
      expect.objectContaining({
        p_reservation_id: proReservationId,
        p_checkout_session_id: 'cs_test123',
        p_observation_kind: 'expired_session',
      })
    )
  })

  it('expires and re-reads an exact cached open Session before releasing an expired reservation', async () => {
    const checkoutExpiresAt = Math.floor(Date.now() / 1000) - 3600
    const metadata = proCheckoutMetadata()
    const open = createdProCheckoutSession({
      customerId: 'cus_test123',
      priceId: 'price_monthly123',
      metadata,
      expiresAt: checkoutExpiresAt,
      clientReferenceId: proReservationId,
    })
    const expired = { ...open, status: 'expired', url: null }
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_test123' })
    mockRetrieveOneTimeCheckoutSession.mockResolvedValueOnce(open).mockResolvedValueOnce(expired)
    installProReservationRpc({
      reservation: { status: 'existing', checkout_expires_at: checkoutExpiresAt },
    })

    const res = await POST(
      new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
    )

    expect(res.status).toBe(409)
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `pro_membership_checkout_test_${proReservationId}`,
        expiresAt: checkoutExpiresAt,
      })
    )
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_test123')
    expect(mockRetrieveOneTimeCheckoutSession).toHaveBeenCalledTimes(2)
  })

  it('releases an old unbound orphan only after exact expired-parameter rejection and a complete empty Session scan', async () => {
    const checkoutExpiresAt = Math.floor(Date.now() / 1000) - 25 * 60 * 60
    installProReservationRpc({
      reservation: { status: 'existing', checkout_expires_at: checkoutExpiresAt },
    })
    mockCreateCheckoutSession.mockRejectedValue(
      Object.assign(new Error('expires_at must be in the future'), {
        type: 'StripeInvalidRequestError',
        param: 'expires_at',
      })
    )
    mockListCheckoutSessions
      .mockResolvedValueOnce({
        data: [
          {
            id: 'cs_irrelevant',
            object: 'checkout.session',
            livemode: false,
            customer: 'cus_test123',
            client_reference_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
            metadata: {},
          },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'cs_irrelevant_second',
            object: 'checkout.session',
            livemode: false,
            customer: 'cus_test123',
            client_reference_id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
            metadata: {},
          },
        ],
        has_more: false,
      })

    const res = await POST(
      new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
    )

    expect(res.status).toBe(409)
    expect(mockListCheckoutSessions).toHaveBeenNthCalledWith(1, {
      customer: 'cus_test123',
      limit: 100,
    })
    expect(mockListCheckoutSessions).toHaveBeenNthCalledWith(2, {
      customer: 'cus_test123',
      limit: 100,
      starting_after: 'cs_irrelevant',
    })
    expect(mockRpc).toHaveBeenCalledWith(
      'release_pro_membership_checkout_observation_atomic',
      expect.objectContaining({
        p_checkout_session_id: null,
        p_observation_kind: 'absent_session',
      })
    )
  })

  it.each([
    ['a network error', new Error('connection reset after write')],
    [
      'an idempotency-key-in-use response',
      Object.assign(new Error('another request is still executing'), {
        type: 'StripeIdempotencyError',
        code: 'idempotency_key_in_use',
      }),
    ],
  ])(
    'preserves an expired unbound reservation after %s even when a complete scan is empty',
    async (_label, createError) => {
      const checkoutExpiresAt = Math.floor(Date.now() / 1000) - 3600
      installProReservationRpc({
        reservation: { status: 'existing', checkout_expires_at: checkoutExpiresAt },
      })
      mockCreateCheckoutSession.mockRejectedValue(createError)

      const res = await POST(
        new NextRequest('http://localhost/api/stripe/create-checkout', {
          method: 'POST',
          headers: { authorization: 'Bearer valid-token' },
          body: JSON.stringify({ plan: 'monthly', trial: false }),
        })
      )

      expect(res.status).toBe(503)
      expect(mockListCheckoutSessions).toHaveBeenCalledTimes(1)
      expect(mockRpc).not.toHaveBeenCalledWith(
        'release_pro_membership_checkout_observation_atomic',
        expect.anything()
      )
    }
  )

  it('preserves an expired unbound reservation when the full Session scan is malformed', async () => {
    const checkoutExpiresAt = Math.floor(Date.now() / 1000) - 3600
    installProReservationRpc({
      reservation: { status: 'existing', checkout_expires_at: checkoutExpiresAt },
    })
    mockCreateCheckoutSession.mockRejectedValue(
      Object.assign(new Error('expired'), {
        type: 'StripeInvalidRequestError',
        param: 'expires_at',
      })
    )
    mockListCheckoutSessions.mockResolvedValue({ data: [], has_more: true })

    const res = await POST(
      new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
    )

    expect(res.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalledWith(
      'release_pro_membership_checkout_observation_atomic',
      expect.anything()
    )
  })

  it('preserves an expired unbound reservation when two Stripe Sessions claim its marker', async () => {
    const checkoutExpiresAt = Math.floor(Date.now() / 1000) - 3600
    installProReservationRpc({
      reservation: { status: 'existing', checkout_expires_at: checkoutExpiresAt },
    })
    mockCreateCheckoutSession.mockRejectedValue(
      Object.assign(new Error('expired'), {
        type: 'StripeInvalidRequestError',
        param: 'expires_at',
      })
    )
    mockListCheckoutSessions.mockResolvedValue({
      data: ['cs_duplicate_one', 'cs_duplicate_two'].map((id) => ({
        id,
        object: 'checkout.session',
        livemode: false,
        customer: 'cus_test123',
        client_reference_id: proReservationId,
        metadata: proCheckoutMetadata(),
      })),
      has_more: false,
    })

    const res = await POST(
      new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
    )

    expect(res.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalledWith(
      'release_pro_membership_checkout_observation_atomic',
      expect.anything()
    )
  })

  it('preserves an expired orphan when the observation release is rejected by the database', async () => {
    const checkoutExpiresAt = Math.floor(Date.now() / 1000) - 3600
    installProReservationRpc({
      reservation: { status: 'existing', checkout_expires_at: checkoutExpiresAt },
      observation: {
        data: null,
        error: { code: '40001', message: 'reservation changed' },
        status: 409,
      },
    })
    mockCreateCheckoutSession.mockRejectedValue(
      Object.assign(new Error('expired'), {
        type: 'StripeInvalidRequestError',
        param: 'expires_at',
      })
    )

    const res = await POST(
      new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
    )

    expect(res.status).toBe(503)
  })

  it('recovers a completed reservation from a created-time-bounded real Event snapshot even with old account history', async () => {
    const now = Math.floor(Date.now() / 1000)
    const checkoutExpiresAt = now - 3600
    const metadata = proCheckoutMetadata()
    const completed = createdProCheckoutSession(
      {
        customerId: 'cus_test123',
        priceId: 'price_monthly123',
        metadata,
        expiresAt: checkoutExpiresAt,
        clientReferenceId: proReservationId,
      },
      {
        created: checkoutExpiresAt - 1200,
        recovered_from: null,
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_recovered123',
        url: null,
      }
    )
    lastCreatedProCheckoutSession = completed
    const inactiveLine = proCheckoutLine('price_monthly123')
    inactiveLine.price.active = false
    mockListCheckoutLineItems.mockResolvedValue({ data: [inactiveLine], has_more: false })
    mockListStripeEvents.mockResolvedValue({
      data: [
        {
          id: 'evt_recovered123',
          object: 'event',
          type: 'checkout.session.completed',
          livemode: false,
          created: checkoutExpiresAt - 600,
          data: { object: completed },
        },
      ],
      has_more: false,
    })
    mockHandleCheckoutComplete.mockResolvedValue({ status: 'pro_reservation_converted' })
    installProReservationRpc({
      reservation: {
        status: 'existing',
        checkout_expires_at: checkoutExpiresAt,
        checkout_session_id: 'cs_test123',
      },
    })

    const res = await POST(
      new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
    )

    expect(res.status).toBe(409)
    expect(mockListStripeEvents).toHaveBeenCalledWith({
      type: 'checkout.session.completed',
      created: {
        gte: checkoutExpiresAt - 1200,
        lte: expect.any(Number),
      },
      limit: 100,
    })
    expect(mockHandleCheckoutComplete).toHaveBeenCalledWith(
      completed,
      { id: 'evt_recovered123', created: checkoutExpiresAt - 600, livemode: false },
      { reportProReservationConversion: true }
    )
  })

  it('replays an unexpired converted reservation from its exact durable Event identity', async () => {
    const now = Math.floor(Date.now() / 1000)
    const checkoutExpiresAt = now + 30 * 60
    const eventCreated = now - 5 * 60
    const metadata = proCheckoutMetadata()
    const completed = createdProCheckoutSession(
      {
        customerId: 'cus_test123',
        priceId: 'price_monthly123',
        metadata,
        expiresAt: checkoutExpiresAt,
        clientReferenceId: proReservationId,
      },
      {
        recovered_from: null,
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_recovered123',
        url: null,
      }
    )
    lastCreatedProCheckoutSession = completed
    mockRetrieveStripeEvent.mockResolvedValue({
      id: 'evt_recovered123',
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      created: eventCreated,
      data: { object: completed },
    })
    mockHandleCheckoutComplete.mockResolvedValue({ status: 'pro_reservation_converted' })

    const result = await recoverExpiredProCheckoutReservation({
      stripeClient: mockGetStripe() as never,
      supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) } as never,
      reservation: {
        status: 'converted',
        reservationId: proReservationId,
        plan: 'monthly',
        priceId: 'price_monthly123',
        unitAmount: 499,
        currency: 'usd',
        trialDays: 0,
        successUrl: 'https://app.test.com/pricing/success',
        cancelUrl: 'https://app.test.com/pricing',
        checkoutExpiresAtSeconds: checkoutExpiresAt,
        checkoutSessionId: 'cs_test123',
      },
      userId: 'user-123',
      customerId: 'cus_test123',
      livemode: false,
      metadata,
      expectedCompletion: {
        eventId: 'evt_recovered123',
        eventCreated,
        subscriptionId: 'sub_recovered123',
      },
    })

    expect(result).toBe('converted')
    expect(mockRetrieveStripeEvent).toHaveBeenCalledWith('evt_recovered123')
    expect(mockListStripeEvents).not.toHaveBeenCalled()
    expect(mockHandleCheckoutComplete).toHaveBeenCalledWith(
      completed,
      { id: 'evt_recovered123', created: eventCreated, livemode: false },
      { reportProReservationConversion: true }
    )
  })

  it.each([
    ['the handler durably reviews instead of converting', 'review'],
    ['activation crashes after conversion', 'crash'],
    ['the signed Event snapshot drifts from the reservation', 'snapshot_drift'],
  ])('preserves a completed reservation when %s', async (_label, failure) => {
    const now = Math.floor(Date.now() / 1000)
    const checkoutExpiresAt = now - 3600
    const metadata = proCheckoutMetadata()
    const current = createdProCheckoutSession(
      {
        customerId: 'cus_test123',
        priceId: 'price_monthly123',
        metadata,
        expiresAt: checkoutExpiresAt,
        clientReferenceId: proReservationId,
      },
      {
        created: checkoutExpiresAt - 1200,
        recovered_from: null,
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_recovered123',
        url: null,
      }
    )
    const snapshot =
      failure === 'snapshot_drift'
        ? { ...current, metadata: { ...metadata, unit_amount: '599' } }
        : current
    lastCreatedProCheckoutSession = current
    mockListStripeEvents.mockResolvedValue({
      data: [
        {
          id: 'evt_recovered123',
          object: 'event',
          type: 'checkout.session.completed',
          livemode: false,
          created: checkoutExpiresAt - 600,
          data: { object: snapshot },
        },
      ],
      has_more: false,
    })
    if (failure === 'crash') {
      mockHandleCheckoutComplete.mockRejectedValue(
        new Error('simulated activation crash after conversion')
      )
    } else {
      mockHandleCheckoutComplete.mockResolvedValue(undefined)
    }
    installProReservationRpc({
      reservation: {
        status: 'existing',
        checkout_expires_at: checkoutExpiresAt,
        checkout_session_id: 'cs_test123',
      },
    })

    const res = await POST(
      new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
    )

    expect(res.status).toBe(503)
    if (failure === 'snapshot_drift') {
      expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
    }
  })

  it('preserves the reservation when Stripe create has an ambiguous outcome', async () => {
    mockCreateCheckoutSession.mockRejectedValue(new Error('connection reset after write'))
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_pro_membership_checkout_session_atomic',
      expect.anything()
    )
    expect(mockRpc).not.toHaveBeenCalledWith(
      'release_pro_membership_checkout_reservation_atomic',
      expect.anything()
    )
  })

  it('preserves an exact Session when the bind outcome is ambiguous', async () => {
    installProReservationRpc({ bind: new Error('response lost after commit') })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalledWith(
      'release_pro_membership_checkout_reservation_atomic',
      expect.anything()
    )
  })

  it('expires an exact-owned Session only after an explicit database bind rejection', async () => {
    installProReservationRpc({
      bind: {
        data: null,
        error: { code: '40001', message: 'identity conflict' },
        status: 409,
      },
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_test123')
    expect(mockRpc).not.toHaveBeenCalledWith(
      'release_pro_membership_checkout_reservation_atomic',
      expect.anything()
    )
  })

  it('withholds but never expires a Session whose exact owner cannot be established', async () => {
    mockRetrieveOneTimeCheckoutSession.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 'cs_test123') return recoveredLifetimeCheckoutSession
      return { ...lastCreatedProCheckoutSession, customer: 'cus_attacker' }
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).not.toHaveBeenCalled()
  })

  it('expires an exact-owned Session whose Price becomes variable or mismatched', async () => {
    mockListCheckoutLineItems.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 'cs_test123') {
        return { data: [lifetimeCheckoutLine], has_more: false }
      }
      const line = proCheckoutLine('price_monthly123')
      return {
        data: [{ ...line, price: { ...line.price, custom_unit_amount: { enabled: true } } }],
        has_more: false,
      }
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_test123')
  })

  it('accepts the exact zero-due-today trial shape while preserving the future unit Price', async () => {
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: true }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(lastCreatedProCheckoutSession).toEqual(
      expect.objectContaining({ amount_subtotal: 0, amount_total: 0 })
    )
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ trialDays: 7 })
    )
  })

  it('rejects a database trial downgrade instead of creating an immediate paid Session', async () => {
    installProReservationRpc({ reservation: { trial_days: 0 } })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'yearly', trial: true }),
    })

    const res = await POST(req)

    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('TRIAL_ALREADY_USED')
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('rejects the atomic trial-history winner without reserving or creating a paid Session', async () => {
    installProReservationRpc({ reservation: { status: 'trial_already_used' } })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: true }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('TRIAL_ALREADY_USED')
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_pro_membership_checkout_session_atomic',
      expect.anything()
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
        body: JSON.stringify({ plan: 'monthly', trial: false }),
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
        body: JSON.stringify({ plan: 'yearly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1)
  })

  it('blocks an active historical Pro Price even without a local row or 073 reservation', async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [
        customerSubscription({
          id: 'sub_legacy_pro_active',
          status: 'active',
          priceId: 'price_retired_pro_monthly',
        }),
      ],
      has_more: false,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('ALREADY_SUBSCRIBED')
    expect(mockRpc).toHaveBeenCalledWith('resolve_b2c_recurring_price_authority', {
      p_stripe_subscription_id: 'sub_legacy_pro_active',
      p_livemode: false,
      p_stripe_price_id: 'price_retired_pro_monthly',
    })
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('accepts exact durable amount and currency authority for a terminal historical Pro Price', async () => {
    const defaultRpc = mockRpc.getMockImplementation()
    mockRpc.mockImplementation((name: string, args?: Record<string, unknown>) => {
      if (name === 'resolve_b2c_recurring_price_authority') {
        return Promise.resolve({
          data: {
            status: 'resolved',
            user_id: 'user-123',
            stripe_customer_id: 'cus_test123',
            stripe_price_id: 'price_retired_pro_monthly',
            expected_amount: 499,
            currency: 'usd',
            plan: 'monthly',
            pro_plan: 'monthly',
            source_kind: 'converted_checkout_reservation',
          },
          error: null,
          status: 200,
        })
      }
      return defaultRpc?.(name, args)
    })
    mockListSubscriptions.mockResolvedValue({
      data: [
        customerSubscription({
          id: 'sub_legacy_pro_terminal',
          status: 'canceled',
          priceId: 'price_retired_pro_monthly',
        }),
      ],
      has_more: false,
    })

    const res = await POST(
      new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })
    )

    expect(res.status).toBe(200)
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['amount', { expected_amount: 599, currency: 'usd' }],
    ['currency', { expected_amount: 499, currency: 'eur' }],
    ['missing amount', { currency: 'usd' }],
  ])(
    'fails closed when historical Pro %s authority disagrees with the fresh Stripe Price',
    async (_label, authorityFields) => {
      const defaultRpc = mockRpc.getMockImplementation()
      mockRpc.mockImplementation((name: string, args?: Record<string, unknown>) => {
        if (name === 'resolve_b2c_recurring_price_authority') {
          return Promise.resolve({
            data: {
              status: 'resolved',
              user_id: 'user-123',
              stripe_customer_id: 'cus_test123',
              stripe_price_id: 'price_retired_pro_monthly',
              plan: 'monthly',
              pro_plan: 'monthly',
              source_kind: 'converted_checkout_reservation',
              ...authorityFields,
            },
            error: null,
            status: 200,
          })
        }
        return defaultRpc?.(name, args)
      })
      mockListSubscriptions.mockResolvedValue({
        data: [
          customerSubscription({
            id: 'sub_legacy_pro_terminal',
            status: 'canceled',
            priceId: 'price_retired_pro_monthly',
          }),
        ],
        has_more: false,
      })

      const res = await POST(
        new NextRequest('http://localhost/api/stripe/create-checkout', {
          method: 'POST',
          headers: { authorization: 'Bearer valid-token' },
          body: JSON.stringify({ plan: 'monthly', trial: false }),
        })
      )

      expect(res.status).toBe(503)
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    }
  )

  it('expires the exact new Session when a remote Pro authority appears before bind', async () => {
    mockListSubscriptions
      .mockResolvedValue({
        data: [customerSubscription({ id: 'sub_manual_race', status: 'active' })],
        has_more: false,
      })
      .mockResolvedValueOnce({ data: [], has_more: false })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(409)
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_test123')
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_pro_membership_checkout_session_atomic',
      expect.anything()
    )
  })

  it('returns only TRIAL_ALREADY_USED when trial history appears in the second pre-bind scan', async () => {
    mockListSubscriptions
      .mockResolvedValue({
        data: [
          customerSubscription({
            id: 'sub_trial_history_race',
            status: 'canceled',
            trialStart: 1_700_000_000,
            trialEnd: 1_700_604_800,
          }),
        ],
        has_more: false,
      })
      .mockResolvedValueOnce({ data: [], has_more: false })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: true }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('TRIAL_ALREADY_USED')
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ trialDays: 7 })
    )
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_test123')
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_pro_membership_checkout_session_atomic',
      expect.anything()
    )
  })

  it('re-attests the fresh Customer before bind and expires the Session on ownership drift', async () => {
    mockRetrieveCustomer
      .mockResolvedValueOnce({
        id: 'cus_test123',
        object: 'customer',
        livemode: false,
        metadata: { userId: 'user-123' },
      })
      .mockResolvedValueOnce({
        id: 'cus_test123',
        object: 'customer',
        livemode: false,
        metadata: { userId: 'other-user' },
      })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockRetrieveCustomer).toHaveBeenCalledTimes(2)
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1)
    expect(mockExpireOneTimeCheckoutSession).toHaveBeenCalledWith('cs_test123')
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_pro_membership_checkout_session_atomic',
      expect.anything()
    )
  })

  it('preserves the exact Session when the second fresh Customer read is unavailable', async () => {
    mockRetrieveCustomer
      .mockResolvedValueOnce({
        id: 'cus_test123',
        object: 'customer',
        livemode: false,
        metadata: { userId: 'user-123' },
      })
      .mockRejectedValueOnce(new Error('temporary second Customer read outage'))
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockRetrieveCustomer).toHaveBeenCalledTimes(2)
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1)
    expect(mockExpireOneTimeCheckoutSession).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_pro_membership_checkout_session_atomic',
      expect.anything()
    )
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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

  it('paginates subscription items and fails closed on ambiguous multi-item semantics', async () => {
    const subscription = customerSubscription({
      id: 'sub_mixed_items',
      status: 'past_due',
      priceId: 'price_api_pro',
    })
    subscription.items.has_more = true
    mockListSubscriptions.mockResolvedValue({ data: [subscription], has_more: false })
    const secondItem = customerSubscription({
      id: 'sub_second_item',
      priceId: 'price_yearly123',
    }).items.data[0]
    mockListSubscriptionItems.mockResolvedValue({
      data: [
        {
          ...secondItem,
          id: 'si_pro_second',
          subscription: 'sub_mixed_items',
        },
      ],
      has_more: false,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockListSubscriptionItems).toHaveBeenCalledWith({
      subscription: 'sub_mixed_items',
      limit: 100,
      starting_after: 'si_mixed_items',
    })
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('rejects an oversized Stripe customer Subscription page', async () => {
    mockListSubscriptions.mockResolvedValue({
      data: Array.from({ length: 101 }, (_, index) =>
        customerSubscription({ id: `sub_oversized_${index + 1}` })
      ),
      has_more: false,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it.each(['initial', 'continuation'])(
    'rejects an oversized Stripe Subscription Item %s page',
    async (pageKind) => {
      const subscription = customerSubscription({ id: `sub_oversized_items_${pageKind}` })
      const makeItem = (index: number) => ({
        ...subscription.items.data[0],
        id: `si_oversized_${pageKind}_${index + 1}`,
        subscription: subscription.id,
      })
      if (pageKind === 'initial') {
        subscription.items.data = Array.from({ length: 101 }, (_, index) => makeItem(index))
      } else {
        subscription.items.has_more = true
        mockListSubscriptionItems.mockResolvedValue({
          data: Array.from({ length: 101 }, (_, index) => makeItem(index)),
          has_more: false,
        })
      }
      mockListSubscriptions.mockResolvedValue({ data: [subscription], has_more: false })
      const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ plan: 'monthly', trial: false }),
      })

      const res = await POST(req)

      expect(res.status).toBe(503)
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    }
  )

  it('rejects an oversized Stripe Checkout line-item page before exposing its URL', async () => {
    mockListCheckoutLineItems.mockResolvedValue({
      data: Array.from({ length: 101 }, () => proCheckoutLine('price_monthly123')),
      has_more: false,
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_pro_membership_checkout_session_atomic',
      expect.anything()
    )
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
    [
      'wrong mode',
      {
        ...customerSubscription({ id: 'sub_wrong_mode', status: 'active' }),
        livemode: true,
      },
    ],
    [
      'wrong object type',
      {
        ...customerSubscription({ id: 'sub_wrong_object', status: 'active' }),
        object: 'customer',
      },
    ],
    [
      'Price mode mismatch',
      {
        ...customerSubscription({ id: 'sub_wrong_price_mode', status: 'active' }),
        items: {
          data: [
            {
              ...customerSubscription({ id: 'sub_wrong_price_mode' }).items.data[0],
              price: {
                ...customerSubscription({ id: 'sub_wrong_price_mode' }).items.data[0].price,
                livemode: true,
              },
            },
          ],
          has_more: false,
        },
      },
    ],
    ...[
      ['leading whitespace', ' sub_whitespace'],
      ['empty suffix', 'sub_'],
      ['punctuation', 'sub_bad-id'],
      ['oversize identity', `sub_${'a'.repeat(252)}`],
    ].map(([label, id]) => [
      `invalid Subscription ${label}`,
      customerSubscription({ id, status: 'active' }),
    ]),
    ...[
      ['leading whitespace', ' si_whitespace'],
      ['empty suffix', 'si_'],
      ['punctuation', 'si_bad-id'],
      ['oversize identity', `si_${'a'.repeat(253)}`],
    ].map(([label, id]) => {
      const subscription = customerSubscription({ id: `sub_item_${label.replaceAll(' ', '_')}` })
      subscription.items.data[0].id = id
      return [`invalid Subscription Item ${label}`, subscription]
    }),
    ...[
      ['leading whitespace', ' price_whitespace'],
      ['empty suffix', 'price_'],
      ['punctuation', 'price_bad-id'],
      ['oversize identity', `price_${'a'.repeat(250)}`],
    ].map(([label, priceId]) => [
      `invalid Price ${label}`,
      customerSubscription({
        id: `sub_price_${label.replaceAll(' ', '_')}`,
        status: 'active',
        priceId,
      }),
    ]),
  ])('fails closed on Stripe subscription %s', async (_label, subscription) => {
    mockListSubscriptions.mockResolvedValue({ data: [subscription], has_more: false })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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

  it('finds a prior trial on the 101st Stripe subscription and refuses paid fallback', async () => {
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

    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('TRIAL_ALREADY_USED')
    expect(mockListSubscriptions).toHaveBeenNthCalledWith(2, {
      customer: 'cus_test123',
      status: 'all',
      limit: 100,
      starting_after: 'sub_history_100',
    })
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
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

  it('fails closed when Stripe customer-subscription pagination exceeds the explicit cap', async () => {
    mockListSubscriptions.mockImplementation((args: { starting_after?: string }) => {
      const previous = args.starting_after ? Number(args.starting_after.replace('sub_cap_', '')) : 0
      const next = previous + 1
      return Promise.resolve({
        data: [
          customerSubscription({
            id: `sub_cap_${next}`,
            status: 'canceled',
            priceId: 'price_api_pro',
          }),
        ],
        has_more: true,
      })
    })
    const req = new NextRequest('http://localhost/api/stripe/create-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(mockListSubscriptions).toHaveBeenCalledTimes(100)
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
    expect(mockRpc).toHaveBeenCalledWith(
      'reserve_lifetime_membership_spot_atomic',
      expect.objectContaining({
        p_user_id: 'user-123',
        p_livemode: false,
      })
    )
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
        p_livemode: false,
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
        body: JSON.stringify({ plan, trial: false }),
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
        body: JSON.stringify({
          plan,
          ...(plan === 'lifetime' ? {} : { trial: false }),
          promotionCode: 'promo_free_100_percent',
        }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
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
      body: JSON.stringify({ plan: 'monthly', trial: false }),
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.error).toMatch(/Network error/)
  })
})
