jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
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

const mockEnv: Record<string, string | undefined> = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  NEXT_PUBLIC_APP_URL: 'https://app.test.com',
}
jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_target, key) {
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

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  })),
}))

const mockGetOrCreateStripeCustomer = jest.fn().mockResolvedValue('cus_test123')
const mockAssertApiPriceReady = jest.fn().mockResolvedValue(undefined)
const mockAssertStripePaymentRuntimeReady = jest.fn()
const mockCreateCheckoutSession = jest.fn()
const mockExpireCheckoutSession = jest.fn().mockResolvedValue({ status: 'expired' })
jest.mock('@/lib/stripe', () => ({
  STRIPE_API_PRICE_IDS: {
    starter: 'price_api_starter123',
    pro: 'price_api_pro123',
  },
  getOrCreateStripeCustomer: (...args: unknown[]) => mockGetOrCreateStripeCustomer(...args),
  assertApiPriceReady: (...args: unknown[]) => mockAssertApiPriceReady(...args),
  assertStripePaymentRuntimeReady: () => mockAssertStripePaymentRuntimeReady(),
  createCheckoutSession: (...args: unknown[]) => mockCreateCheckoutSession(...args),
  getStripe: () => ({
    checkout: {
      sessions: {
        expire: (...args: unknown[]) => mockExpireCheckoutSession(...args),
      },
    },
  }),
}))

const mockExtractUser = jest.fn()
jest.mock('@/lib/auth/extract-user', () => ({
  extractUserFromRequest: (...args: unknown[]) => mockExtractUser(...args),
}))

const mockProfileMaybeSingle = jest.fn()
const mockRpc = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          maybeSingle: (...args: unknown[]) => mockProfileMaybeSingle(...args),
        }),
      }),
    })),
    rpc: (...args: unknown[]) => mockRpc(...args),
  })),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222'
const CHECKOUT_EXPIRES_AT_SECONDS = Math.floor(Date.now() / 1000) + 60 * 60

type CheckoutCreateParams = {
  customerId: string
  priceId: string
  metadata: Record<string, string>
  expiresAt: number
  clientReferenceId: string
  allowPromotionCodes: boolean
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    status: 'reserved',
    reservation_id: RESERVATION_ID,
    api_plan: 'starter',
    stripe_price_id: 'price_api_starter123',
    checkout_expires_at: CHECKOUT_EXPIRES_AT_SECONDS,
    checkout_session_id: null,
    ...overrides,
  }
}

function freshSession(params: CheckoutCreateParams, overrides: Record<string, unknown> = {}) {
  const amount = params.priceId.includes('pro') ? 19_900 : 4_900
  return {
    id: 'cs_test_api_123',
    object: 'checkout.session',
    url: 'https://checkout.stripe.com/c/pay/cs_test_api_123',
    mode: 'subscription',
    status: 'open',
    payment_status: 'unpaid',
    allow_promotion_codes: false,
    discounts: [],
    currency: 'usd',
    amount_subtotal: amount,
    amount_total: amount,
    total_details: {
      amount_discount: 0,
      amount_shipping: 0,
      amount_tax: 0,
    },
    subscription: null,
    customer: params.customerId,
    livemode: false,
    expires_at: params.expiresAt,
    client_reference_id: params.clientReferenceId,
    metadata: params.metadata,
    ...overrides,
  }
}

function useRpcStatus(
  options: {
    customerBind?: { data: unknown; error: unknown; status?: number }
    reserve?: { data: unknown; error: unknown; status?: number }
    checkoutBind?: { data: unknown; error: unknown; status?: number }
  } = {}
) {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'bind_stripe_customer_owner_atomic') {
      return Promise.resolve(options.customerBind ?? { data: { status: 'bound' }, error: null })
    }
    if (name === 'reserve_api_tier_checkout_atomic') {
      return Promise.resolve(options.reserve ?? { data: reservation(), error: null })
    }
    if (name === 'bind_api_tier_checkout_session_atomic') {
      return Promise.resolve(options.checkoutBind ?? { data: { status: 'bound' }, error: null })
    }
    throw new Error(`Unexpected RPC: ${name}`)
  })
}

describe('POST /api/stripe/create-api-checkout', () => {
  const validUser = { id: USER_ID, email: 'user@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockEnv.STRIPE_SECRET_KEY = 'sk_test_123'
    mockEnv.NEXT_PUBLIC_APP_URL = 'https://app.test.com'
    mockCheckRateLimit.mockResolvedValue(null)
    mockExtractUser.mockResolvedValue({ user: validUser, error: null })
    mockProfileMaybeSingle.mockResolvedValue({
      data: {
        api_tier: 'free',
        api_stripe_subscription_id: null,
        stripe_customer_id: 'cus_existing',
      },
      error: null,
    })
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_test123')
    mockAssertApiPriceReady.mockResolvedValue(undefined)
    mockAssertStripePaymentRuntimeReady.mockReturnValue(undefined)
    mockCreateCheckoutSession.mockImplementation(async (params: CheckoutCreateParams) =>
      freshSession(params)
    )
    mockExpireCheckoutSession.mockResolvedValue({ status: 'expired' })
    useRpcStatus()
  })

  function request(plan = 'starter') {
    return new NextRequest('http://localhost/api/stripe/create-api-checkout', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ plan }),
    })
  }

  it('fails closed before Stripe work when the billing profile is missing', async () => {
    mockProfileMaybeSingle.mockResolvedValue({ data: null, error: null })

    const res = await POST(request())

    expect(res.status).toBe(503)
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('fails closed before Stripe work when the billing profile lookup errors', async () => {
    mockProfileMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    })

    const res = await POST(request())

    expect(res.status).toBe(503)
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a different paid API tier',
      { api_tier: 'starter', api_stripe_subscription_id: 'sub_existing' },
    ],
    [
      'a persisted subscription identity',
      { api_tier: 'free', api_stripe_subscription_id: 'sub_stale' },
    ],
  ])('blocks a second checkout when the profile has %s', async (_reason, entitlement) => {
    mockProfileMaybeSingle.mockResolvedValue({
      data: {
        ...entitlement,
        stripe_customer_id: 'cus_existing',
      },
      error: null,
    })

    const res = await POST(request('pro'))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(
      expect.objectContaining({
        code: 'ALREADY_SUBSCRIBED',
      })
    )
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('fails closed before customer creation when Production payment runtime is unsafe', async () => {
    mockAssertStripePaymentRuntimeReady.mockImplementation(() => {
      throw new Error('Stripe live mode is required for Production payment actions')
    })

    const res = await POST(request())

    expect(res.status).toBe(503)
    expect(mockAssertApiPriceReady).not.toHaveBeenCalled()
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('blocks before reservation and Checkout when exact Customer ownership cannot bind', async () => {
    useRpcStatus({
      customerBind: { data: { status: 'identity_conflict' }, error: null },
    })

    const res = await POST(request())

    expect(res.status).toBe(503)
    expect(mockRpc).toHaveBeenCalledWith('bind_stripe_customer_owner_atomic', {
      p_user_id: USER_ID,
      p_new_stripe_customer_id: 'cus_test123',
      p_expected_previous_stripe_customer_id: 'cus_existing',
    })
    expect(mockRpc).not.toHaveBeenCalledWith('reserve_api_tier_checkout_atomic', expect.anything())
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('atomically reserves, creates with exact durable identity, binds, then returns the URL', async () => {
    const res = await POST(request('starter'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_test_api_123',
      sessionId: 'cs_test_api_123',
    })
    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledWith(
      USER_ID,
      'user@test.com',
      {
        source: 'ranking-arena-api',
        plan: 'api_starter',
      },
      'cus_existing'
    )
    expect(mockRpc).toHaveBeenCalledWith('reserve_api_tier_checkout_atomic', {
      p_user_id: USER_ID,
      p_livemode: false,
      p_stripe_customer_id: 'cus_test123',
      p_api_plan: 'starter',
      p_stripe_price_id: 'price_api_starter123',
    })
    const metadata = {
      supabase_user_id: USER_ID,
      userId: USER_ID,
      type: 'api_tier',
      api_plan: 'starter',
      api_tier_reservation_id: RESERVATION_ID,
    }
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      customerId: 'cus_test123',
      priceId: 'price_api_starter123',
      successUrl: 'https://app.test.com/settings?api_upgraded=starter',
      cancelUrl: 'https://app.test.com/api-docs',
      metadata,
      idempotencyKey: `api_tier_checkout_test_${RESERVATION_ID}`,
      expiresAt: CHECKOUT_EXPIRES_AT_SECONDS,
      clientReferenceId: RESERVATION_ID,
      allowPromotionCodes: false,
    })
    expect(mockRpc).toHaveBeenCalledWith('bind_api_tier_checkout_session_atomic', {
      p_reservation_id: RESERVATION_ID,
      p_user_id: USER_ID,
      p_livemode: false,
      p_stripe_customer_id: 'cus_test123',
      p_api_plan: 'starter',
      p_stripe_price_id: 'price_api_starter123',
      p_checkout_session_id: 'cs_test_api_123',
      p_checkout_expires_at: CHECKOUT_EXPIRES_AT_SECONDS,
    })

    const customerBindOrder = mockRpc.mock.invocationCallOrder[0]
    const reserveOrder = mockRpc.mock.invocationCallOrder[1]
    const createOrder = mockCreateCheckoutSession.mock.invocationCallOrder[0]
    const checkoutBindOrder = mockRpc.mock.invocationCallOrder[2]
    expect(customerBindOrder).toBeLessThan(reserveOrder)
    expect(reserveOrder).toBeLessThan(createOrder)
    expect(createOrder).toBeLessThan(checkoutBindOrder)
  })

  it('uses the same reservation identity and Stripe idempotency key on retry', async () => {
    useRpcStatus({
      reserve: {
        data: reservation({
          status: 'existing',
          checkout_session_id: 'cs_test_api_123',
        }),
        error: null,
      },
      checkoutBind: { data: { status: 'already_bound' }, error: null },
    })

    const first = await POST(request())
    const second = await POST(request())

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(2)
    for (const [params] of mockCreateCheckoutSession.mock.calls) {
      expect(params).toEqual(
        expect.objectContaining({
          idempotencyKey: `api_tier_checkout_test_${RESERVATION_ID}`,
          expiresAt: CHECKOUT_EXPIRES_AT_SECONDS,
          clientReferenceId: RESERVATION_ID,
        })
      )
    }
  })

  it.each([
    [
      'plan',
      {
        api_plan: 'starter',
        stripe_price_id: 'price_api_starter123',
      },
    ],
    [
      'price',
      {
        api_plan: 'pro',
        stripe_price_id: 'price_api_other',
      },
    ],
  ])(
    'returns 409 without Stripe creation when an existing reservation conflicts by %s',
    async (_field, existingProduct) => {
      useRpcStatus({
        reserve: {
          data: reservation({
            status: 'existing',
            ...existingProduct,
          }),
          error: null,
        },
      })

      const res = await POST(request('pro'))
      const body = await res.json()

      expect(res.status).toBe(409)
      expect(body).toEqual(expect.objectContaining({ code: 'API_CHECKOUT_CONFLICT' }))
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
      expect(mockRpc).not.toHaveBeenCalledWith(
        'bind_api_tier_checkout_session_atomic',
        expect.anything()
      )
    }
  )

  it.each([
    ['database error', { data: null, error: { message: 'database unavailable' } }],
    ['unknown status', { data: reservation({ status: 'identity_conflict' }), error: null }],
    ['malformed identity', { data: reservation({ reservation_id: 'not-a-uuid' }), error: null }],
    [
      'non-numeric expiry',
      { data: reservation({ checkout_expires_at: '2099-01-01T00:00:00.000Z' }), error: null },
    ],
    [
      'fractional expiry',
      {
        data: reservation({ checkout_expires_at: CHECKOUT_EXPIRES_AT_SECONDS + 0.5 }),
        error: null,
      },
    ],
    [
      'impossible reserved-and-bound state',
      {
        data: reservation({ checkout_session_id: 'cs_test_api_123' }),
        error: null,
      },
    ],
  ])('fails closed without Stripe creation on reservation %s', async (_reason, reserve) => {
    useRpcStatus({ reserve })

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_api_tier_checkout_session_atomic',
      expect.anything()
    )
  })

  it('derives live reservation and idempotency identity from the live secret', async () => {
    mockEnv.STRIPE_SECRET_KEY = 'sk_live_123'
    mockCreateCheckoutSession.mockImplementation(async (params: CheckoutCreateParams) =>
      freshSession(params, { id: 'cs_live_api_123', livemode: true })
    )

    const res = await POST(request())

    expect(res.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'reserve_api_tier_checkout_atomic',
      expect.objectContaining({ p_livemode: true })
    )
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `api_tier_checkout_live_${RESERVATION_ID}`,
      })
    )
    expect(mockRpc).toHaveBeenCalledWith(
      'bind_api_tier_checkout_session_atomic',
      expect.objectContaining({
        p_livemode: true,
        p_checkout_session_id: 'cs_live_api_123',
      })
    )
  })

  it('accepts a converted reservation as a durable terminal bind result', async () => {
    useRpcStatus({
      reserve: {
        data: reservation({
          status: 'existing',
          checkout_session_id: 'cs_test_api_123',
        }),
        error: null,
      },
      checkoutBind: { data: { status: 'converted' }, error: null },
    })

    const res = await POST(request())

    expect(res.status).toBe(200)
    expect(mockExpireCheckoutSession).not.toHaveBeenCalled()
  })

  it('preserves the reservation when Stripe Session creation is ambiguous', async () => {
    mockCreateCheckoutSession.mockRejectedValue(new Error('connection reset after write'))

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockExpireCheckoutSession).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_api_tier_checkout_session_atomic',
      expect.anything()
    )
  })

  it.each([
    ['mode', { mode: 'payment' }],
    ['customer', { customer: 'cus_other' }],
    ['livemode', { livemode: true }],
    ['expiry', { expires_at: CHECKOUT_EXPIRES_AT_SECONDS + 1 }],
    ['metadata', { metadata: { type: 'api_tier' } }],
    ['state', { status: 'complete' }],
    ['promotion-code field', { allow_promotion_codes: true }],
    ['discount', { discounts: [{ promotion_code: 'promo_unsafe' }] }],
    ['discounted total', { amount_total: 4_000 }],
    ['currency', { currency: 'eur' }],
    [
      'total discount',
      {
        total_details: {
          amount_discount: 900,
          amount_shipping: 0,
          amount_tax: 0,
        },
      },
    ],
    ['missing subscription state', { subscription: undefined }],
    ['URL', { url: 'http://checkout.stripe.com/c/pay/cs_test_api_123' }],
  ])('expires and withholds an API Checkout Session with invalid %s', async (_field, drift) => {
    mockCreateCheckoutSession.mockImplementation(async (params: CheckoutCreateParams) =>
      freshSession(params, drift)
    )

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockExpireCheckoutSession).toHaveBeenCalledWith('cs_test_api_123')
    expect(mockRpc).not.toHaveBeenCalledWith(
      'bind_api_tier_checkout_session_atomic',
      expect.anything()
    )
  })

  it('expires and withholds the URL when Session bind returns an explicit database error', async () => {
    useRpcStatus({
      checkoutBind: {
        data: null,
        error: { code: 'P0001', message: 'database rejected the bind' },
        status: 400,
      },
    })

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockExpireCheckoutSession).toHaveBeenCalledWith('cs_test_api_123')
  })

  it('preserves the Session when bind returns an unknown success status', async () => {
    useRpcStatus({
      checkoutBind: { data: { status: 'identity_conflict' }, error: null },
    })

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockExpireCheckoutSession).not.toHaveBeenCalled()
  })

  it('preserves the Session when Session bind transport rejects', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null })
      }
      if (name === 'reserve_api_tier_checkout_atomic') {
        return Promise.resolve({ data: reservation(), error: null })
      }
      if (name === 'bind_api_tier_checkout_session_atomic') {
        return Promise.reject(new Error('database connection reset'))
      }
      throw new Error(`Unexpected RPC: ${name}`)
    })

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockExpireCheckoutSession).not.toHaveBeenCalled()
  })

  it('preserves the Session for the resolved postgrest-js transport-error shape', async () => {
    useRpcStatus({
      checkoutBind: {
        data: null,
        error: {
          code: '',
          details: '',
          hint: '',
          message: 'FetchError: request failed',
        },
        status: 0,
      },
    })

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockExpireCheckoutSession).not.toHaveBeenCalled()
  })

  it('recovers the same bound Session after a commit-then-transport-reject', async () => {
    let reserveCalls = 0
    let bindCalls = 0
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_stripe_customer_owner_atomic') {
        return Promise.resolve({ data: { status: 'already_bound' }, error: null })
      }
      if (name === 'reserve_api_tier_checkout_atomic') {
        reserveCalls += 1
        return Promise.resolve({
          data: reservation(
            reserveCalls === 1 ? {} : { status: 'existing', checkout_session_id: 'cs_test_api_123' }
          ),
          error: null,
        })
      }
      if (name === 'bind_api_tier_checkout_session_atomic') {
        bindCalls += 1
        if (bindCalls === 1) {
          return Promise.reject(new Error('response lost after commit'))
        }
        return Promise.resolve({ data: { status: 'already_bound' }, error: null })
      }
      throw new Error(`Unexpected RPC: ${name}`)
    })

    const uncertain = await POST(request())
    const recovered = await POST(request())

    expect(uncertain.status).toBe(503)
    expect(await uncertain.json()).not.toHaveProperty('url')
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_test_api_123',
      sessionId: 'cs_test_api_123',
    })
    expect(mockExpireCheckoutSession).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(2)
    for (const [params] of mockCreateCheckoutSession.mock.calls) {
      expect(params.idempotencyKey).toBe(`api_tier_checkout_test_${RESERVATION_ID}`)
    }
  })

  it('still returns 503 without a URL when compensating Session expiration fails', async () => {
    useRpcStatus({
      checkoutBind: {
        data: null,
        error: { code: 'P0001', message: 'database rejected the bind' },
        status: 400,
      },
    })
    mockExpireCheckoutSession.mockRejectedValue(new Error('Stripe expire unavailable'))

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).not.toHaveProperty('url')
    expect(mockExpireCheckoutSession).toHaveBeenCalledWith('cs_test_api_123')
  })
})
