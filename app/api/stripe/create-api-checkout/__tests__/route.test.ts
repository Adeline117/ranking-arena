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
const mockCreateCheckoutSession = jest
  .fn()
  .mockResolvedValue({ url: 'https://checkout.stripe.com/api-session', id: 'cs_api_test123' })
jest.mock('@/lib/stripe', () => ({
  STRIPE_API_PRICE_IDS: {
    starter: 'price_api_starter123',
    pro: 'price_api_pro123',
  },
  getOrCreateStripeCustomer: (...args: unknown[]) => mockGetOrCreateStripeCustomer(...args),
  assertApiPriceReady: (...args: unknown[]) => mockAssertApiPriceReady(...args),
  assertStripePaymentRuntimeReady: () => mockAssertStripePaymentRuntimeReady(),
  createCheckoutSession: (...args: unknown[]) => mockCreateCheckoutSession(...args),
}))

const mockExtractUser = jest.fn()
jest.mock('@/lib/auth/extract-user', () => ({
  extractUserFromRequest: (...args: unknown[]) => mockExtractUser(...args),
}))

const mockProfileMaybeSingle = jest.fn()
const mockProfileUpdate = jest.fn()
const mockProfileUpdateEq = jest.fn()
const mockProfileUpdateSelect = jest.fn()
const mockProfileUpdateMaybeSingle = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          maybeSingle: (...args: unknown[]) => mockProfileMaybeSingle(...args),
        }),
      }),
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
    })),
  })),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

describe('POST /api/stripe/create-api-checkout', () => {
  const validUser = { id: 'user-123', email: 'user@test.com' }

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
    mockProfileUpdateMaybeSingle.mockResolvedValue({
      data: { id: 'user-123' },
      error: null,
    })
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_test123')
    mockAssertApiPriceReady.mockResolvedValue(undefined)
    mockAssertStripePaymentRuntimeReady.mockReturnValue(undefined)
    mockCreateCheckoutSession.mockResolvedValue({
      url: 'https://checkout.stripe.com/api-session',
      id: 'cs_api_test123',
    })
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
    expect(mockProfileUpdate).not.toHaveBeenCalled()
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
    expect(mockProfileUpdate).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('blocks checkout when updating the existing customer link fails', async () => {
    mockProfileUpdateMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    })

    const res = await POST(request())

    expect(res.status).toBe(503)
    expect(mockProfileUpdate).toHaveBeenCalledWith({
      stripe_customer_id: 'cus_test123',
      updated_at: expect.any(String),
    })
    expect(mockProfileUpdateEq).toHaveBeenCalledWith('id', 'user-123')
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
    expect(mockProfileUpdate).not.toHaveBeenCalled()
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('blocks checkout if the profile disappears before the customer link update', async () => {
    mockProfileUpdateMaybeSingle.mockResolvedValue({ data: null, error: null })

    const res = await POST(request())

    expect(res.status).toBe(503)
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled()
  })

  it('updates the existing profile and preserves successful checkout semantics', async () => {
    const res = await POST(request('pro'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      url: 'https://checkout.stripe.com/api-session',
      sessionId: 'cs_api_test123',
    })
    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledWith(
      'user-123',
      'user@test.com',
      {
        source: 'ranking-arena-api',
        plan: 'api_pro',
      },
      'cus_existing'
    )
    expect(mockProfileUpdate).toHaveBeenCalledWith({
      stripe_customer_id: 'cus_test123',
      updated_at: expect.any(String),
    })
    expect(mockProfileUpdateEq).toHaveBeenCalledWith('id', 'user-123')
    expect(mockProfileUpdateSelect).toHaveBeenCalledWith('id')
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_test123',
        priceId: 'price_api_pro123',
      })
    )
  })
})
