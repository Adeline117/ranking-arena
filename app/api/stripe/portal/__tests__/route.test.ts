jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers = new Headers()

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    readonly url: string
    private readonly body: string | undefined

    constructor(url: string, init?: { body?: string }) {
      this.url = url
      this.body = init?.body
    }

    async json() {
      return JSON.parse(this.body ?? '')
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockEnv: Record<string, string | undefined> = {
  NEXT_PUBLIC_APP_URL: 'https://app.test',
  STRIPE_SECRET_KEY: 'sk_test_secret',
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

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

const mockExtractUser = jest.fn()
jest.mock('@/lib/auth/extract-user', () => ({
  extractUserFromRequest: (...args: unknown[]) => mockExtractUser(...args),
}))

const mockStripeClient = { name: 'stripe-client' }
const mockAssertRuntimeReady = jest.fn()
jest.mock('@/lib/stripe', () => ({
  STRIPE_PRICE_IDS: {
    monthly: 'price_membership_monthly',
    yearly: 'price_membership_yearly',
  },
  STRIPE_API_PRICE_IDS: {
    starter: 'price_api_starter',
    pro: 'price_api_pro',
  },
  assertStripePaymentRuntimeReady: () => mockAssertRuntimeReady(),
  getStripe: () => mockStripeClient,
}))

const mockCreatePortalFlow = jest.fn()
jest.mock('@/lib/stripe/billing-portal', () => ({
  createBillingPortalFlow: (...args: unknown[]) => mockCreatePortalFlow(...args),
}))

let mockProfileResult: { data: Record<string, unknown> | null; error: unknown }
let mockSubscriptionsResult: { data: Record<string, unknown>[] | null; error: unknown }
const mockFrom = jest.fn((table: string) => {
  if (table === 'user_profiles') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn(async () => mockProfileResult),
        })),
      })),
    }
  }
  if (table === 'subscriptions') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          not: jest.fn(() => ({
            limit: jest.fn(async () => mockSubscriptionsResult),
          })),
        })),
      })),
    }
  }
  throw new Error(`Unexpected table ${table}`)
})
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const profile = {
  stripe_customer_id: 'cus_current',
  stripe_subscription_id: 'sub_membership',
  api_stripe_subscription_id: 'sub_api',
  api_tier: 'starter',
  deleted_at: null,
}

const membership = {
  stripe_customer_id: 'cus_current',
  stripe_subscription_id: 'sub_membership',
  status: 'active',
  tier: 'pro',
  plan: 'monthly',
}

function request(body: unknown): InstanceType<typeof NextRequest> {
  return new NextRequest('https://app.test/api/stripe/portal', {
    body: JSON.stringify(body),
  })
}

describe('POST /api/stripe/portal', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEnv.NEXT_PUBLIC_APP_URL = 'https://app.test'
    mockEnv.STRIPE_SECRET_KEY = 'sk_test_secret'
    mockCheckRateLimit.mockResolvedValue(null)
    mockExtractUser.mockResolvedValue({
      user: { id: 'user-123', email: 'member@example.com' },
      error: null,
    })
    mockAssertRuntimeReady.mockReturnValue(undefined)
    mockProfileResult = { data: { ...profile }, error: null }
    mockSubscriptionsResult = { data: [{ ...membership }], error: null }
    mockCreatePortalFlow.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/exact',
    })
  })

  it('resolves and creates an exact membership payment-method flow', async () => {
    const response = await POST(
      request({ flow: 'payment_method_update', scope: 'membership' }) as never
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      url: 'https://billing.stripe.com/p/session/exact',
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockCreatePortalFlow).toHaveBeenCalledWith({
      stripe: mockStripeClient,
      authority: {
        userId: 'user-123',
        customerId: 'cus_current',
        subscriptionId: 'sub_membership',
        scope: 'membership',
        plan: 'monthly',
        localStatus: 'active',
        livemode: false,
      },
      flow: 'payment_method_update',
      returnUrl: 'https://app.test/user-center?tab=membership',
      prices: {
        membership: {
          monthly: 'price_membership_monthly',
          yearly: 'price_membership_yearly',
        },
        api: {
          starter: 'price_api_starter',
          pro: 'price_api_pro',
        },
      },
    })
  })

  it('selects only the profile-bound API subscription for cancellation', async () => {
    const response = await POST(request({ flow: 'subscription_cancel', scope: 'api' }) as never)

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledWith('user_profiles')
    expect(mockFrom).not.toHaveBeenCalledWith('subscriptions')
    expect(mockCreatePortalFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: {
          userId: 'user-123',
          customerId: 'cus_current',
          subscriptionId: 'sub_api',
          scope: 'api',
          plan: 'starter',
          localStatus: 'active',
          livemode: false,
        },
        flow: 'subscription_cancel',
        returnUrl: 'https://app.test/settings#api-keys',
      })
    )
  })

  it('does not expose a non-Stripe navigation URL returned by the adapter', async () => {
    mockCreatePortalFlow.mockResolvedValue({
      url: 'https://attacker.example/fake-billing-portal',
    })

    const response = await POST(
      request({ flow: 'payment_method_update', scope: 'membership' }) as never
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'Unable to open subscription management. Please retry.',
      code: 'BILLING_PORTAL_UNAVAILABLE',
    })
  })

  it.each([
    ['generic request', {}],
    ['legacy flow_data', { flow_data: { type: 'payment_method_update' } }],
    ['subscription update', { flow: 'subscription_update', scope: 'membership' }],
    [
      'client-selected subscription',
      {
        flow: 'subscription_cancel',
        scope: 'membership',
        subscriptionId: 'sub_attacker',
      },
    ],
  ])('rejects a %s before authentication or Stripe work', async (_label, body) => {
    const response = await POST(request(body) as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_PORTAL_REQUEST' })
    expect(mockExtractUser).not.toHaveBeenCalled()
    expect(mockAssertRuntimeReady).not.toHaveBeenCalled()
    expect(mockCreatePortalFlow).not.toHaveBeenCalled()
  })

  it('fails closed when local membership customer identity disagrees with the profile', async () => {
    mockSubscriptionsResult = {
      data: [{ ...membership, stripe_customer_id: 'cus_other' }],
      error: null,
    }

    const response = await POST(
      request({ flow: 'subscription_cancel', scope: 'membership' }) as never
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: 'BILLING_IDENTITY_UNAVAILABLE',
    })
    expect(mockCreatePortalFlow).not.toHaveBeenCalled()
  })

  it('fails closed when membership identity is ambiguous', async () => {
    mockSubscriptionsResult = {
      data: [{ ...membership }, { ...membership, stripe_subscription_id: 'sub_second' }],
      error: null,
    }

    const response = await POST(
      request({ flow: 'payment_method_update', scope: 'membership' }) as never
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'NO_MANAGEABLE_SUBSCRIPTION',
    })
    expect(mockCreatePortalFlow).not.toHaveBeenCalled()
  })

  it('does not create an API flow without a paid profile-bound subscription', async () => {
    mockProfileResult = {
      data: { ...profile, api_tier: 'free', api_stripe_subscription_id: null },
      error: null,
    }

    const response = await POST(request({ flow: 'payment_method_update', scope: 'api' }) as never)

    expect(response.status).toBe(409)
    expect(mockCreatePortalFlow).not.toHaveBeenCalled()
  })

  it('blocks deleted accounts and database lookup failures', async () => {
    mockProfileResult = { data: { ...profile, deleted_at: '2026-07-29T00:00:00Z' }, error: null }
    const deletedResponse = await POST(
      request({ flow: 'subscription_cancel', scope: 'api' }) as never
    )
    expect(deletedResponse.status).toBe(409)
    expect(mockCreatePortalFlow).not.toHaveBeenCalled()

    mockProfileResult = { data: null, error: { message: 'database unavailable' } }
    const failedResponse = await POST(
      request({ flow: 'subscription_cancel', scope: 'api' }) as never
    )
    expect(failedResponse.status).toBe(503)
    expect(mockCreatePortalFlow).not.toHaveBeenCalled()
  })

  it('requires authentication and a safe Stripe runtime', async () => {
    mockExtractUser.mockResolvedValue({ user: null, error: new Error('unauthorized') })
    const unauthorized = await POST(
      request({ flow: 'payment_method_update', scope: 'membership' }) as never
    )
    expect(unauthorized.status).toBe(401)
    expect(mockAssertRuntimeReady).not.toHaveBeenCalled()

    mockExtractUser.mockResolvedValue({ user: { id: 'user-123' }, error: null })
    mockAssertRuntimeReady.mockImplementation(() => {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured')
    })
    const unsafeRuntime = await POST(
      request({ flow: 'payment_method_update', scope: 'membership' }) as never
    )
    expect(unsafeRuntime.status).toBe(503)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockCreatePortalFlow).not.toHaveBeenCalled()
  })
})
