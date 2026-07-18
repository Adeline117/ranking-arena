jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private body: unknown
    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
    async json() {
      return this.body
    }
  }

  class MockNextRequest {
    private body: unknown
    constructor(_url: string, init?: { body?: string }) {
      this.body = init?.body ? JSON.parse(init.body) : null
    }
    async json() {
      return this.body
    }
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockSessionRetrieve = jest.fn()
const mockSubscriptionRetrieve = jest.fn()
const mockPaymentIntentRetrieve = jest.fn()
const mockActivateLifetimeCheckoutEntitlement = jest.fn()
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    checkout: { sessions: { retrieve: mockSessionRetrieve } },
    subscriptions: { retrieve: mockSubscriptionRetrieve },
    paymentIntents: { retrieve: mockPaymentIntentRetrieve },
  })),
}))

const mockGetAuthUser = jest.fn()
const mockRpc = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))
jest.mock('@/lib/stripe/lifetime-entitlement', () => ({
  activateLifetimeCheckoutEntitlement: (...args: unknown[]) =>
    mockActivateLifetimeCheckoutEntitlement(...args),
  lifetimeActivationGranted: (status: string) =>
    status === 'activated' || status === 'already_activated',
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {} },
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))
jest.mock('@/lib/env', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_PRO_MONTHLY_PRICE_ID: 'price_monthly',
    STRIPE_PRO_YEARLY_PRICE_ID: 'price_yearly',
  },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

function request() {
  return new NextRequest('http://localhost/api/stripe/verify-session', {
    body: JSON.stringify({ sessionId: 'cs_test_123' }),
  } as never)
}

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_123',
    mode: 'subscription',
    payment_status: 'paid',
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    metadata: { userId: 'user-123', plan: 'monthly' },
    ...overrides,
  }
}

function activeSubscription(priceId = 'price_monthly', status = 'active') {
  return {
    id: 'sub_test_123',
    status,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: priceId },
          current_period_start: 1_780_000_000,
          current_period_end: 1_782_592_000,
        },
      ],
    },
  }
}

describe('POST /api/stripe/verify-session', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: 'user-123' })
    mockSessionRetrieve.mockResolvedValue(baseSession())
    mockSubscriptionRetrieve.mockResolvedValue(activeSubscription())
    mockPaymentIntentRetrieve.mockResolvedValue({
      latest_charge: { id: 'ch_test_123', refunded: false, amount_refunded: 0 },
    })
    mockActivateLifetimeCheckoutEntitlement.mockResolvedValue({ status: 'activated' })
    mockRpc.mockResolvedValue({ error: null })
  })

  it('fails closed when a lifetime refund safety lookup is unavailable', async () => {
    mockSessionRetrieve.mockResolvedValue(
      baseSession({
        mode: 'payment',
        subscription: null,
        payment_intent: 'pi_test_123',
        metadata: { userId: 'user-123', plan: 'lifetime' },
      })
    )
    mockPaymentIntentRetrieve.mockRejectedValue(new Error('Stripe timeout'))

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('atomically activates an unrefunded paid lifetime purchase', async () => {
    mockSessionRetrieve.mockResolvedValue(
      baseSession({
        mode: 'payment',
        subscription: null,
        payment_intent: 'pi_test_123',
        metadata: { userId: 'user-123', plan: 'lifetime' },
      })
    )

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockActivateLifetimeCheckoutEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUserId: 'user-123',
        session: expect.objectContaining({ id: 'cs_test_123' }),
      })
    )
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('does not report success when exact lifetime authority requires review', async () => {
    mockSessionRetrieve.mockResolvedValue(
      baseSession({
        mode: 'payment',
        subscription: null,
        payment_intent: 'pi_test_123',
        metadata: { userId: 'user-123', plan: 'lifetime' },
      })
    )
    mockActivateLifetimeCheckoutEntitlement.mockResolvedValue({
      status: 'reservation_refund_queued',
    })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Payment requires review before membership can be activated.',
      code: 'LIFETIME_ACTIVATION_REVIEW',
    })
  })

  it('supports a no-payment-required trial after verifying Stripe status', async () => {
    mockSessionRetrieve.mockResolvedValue(baseSession({ payment_status: 'no_payment_required' }))
    mockSubscriptionRetrieve.mockResolvedValue(activeSubscription('price_monthly', 'trialing'))

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'update_subscription_and_profile',
      expect.objectContaining({
        p_user_id: 'user-123',
        p_status: 'trialing',
        p_plan: 'monthly',
      })
    )
  })

  it('refuses to grant Pro for a Stripe price outside the configured whitelist', async () => {
    mockSubscriptionRetrieve.mockResolvedValue(activeSubscription('price_unknown'))

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('reports failure when the atomic entitlement sync fails', async () => {
    mockRpc.mockResolvedValue({ error: { message: 'database unavailable' } })

    const response = await POST(request())

    expect(response.status).toBe(500)
  })
})
