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
const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({ rpc: mockRpc, from: mockFrom }),
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

import Stripe from 'stripe'
import { NextRequest } from 'next/server'
import { STRIPE_API_VERSION } from '@/lib/stripe/version'
import { POST } from '../route'

const PERIOD_START = new Date(1_780_000_000 * 1000).toISOString()
const PERIOD_END = new Date(1_782_592_000 * 1000).toISOString()

let localSubscription: Record<string, unknown> | null
let entitlementPayment: Record<string, unknown> | null
let trialEntitlement: Record<string, unknown> | null

function maybeSingleQuery(
  result: () => {
    data: Record<string, unknown> | null
    error: { message: string } | null
  }
) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.maybeSingle.mockImplementation(async () => result())
  return query
}

function request() {
  return new NextRequest('http://localhost/api/stripe/verify-session', {
    body: JSON.stringify({ sessionId: 'cs_test_123' }),
  } as never)
}

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_123',
    mode: 'subscription',
    status: 'complete',
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
    customer: 'cus_test_123',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: priceId },
          quantity: 1,
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
    localSubscription = {
      user_id: 'user-123',
      tier: 'pro',
      status: 'active',
      plan: 'monthly',
      stripe_subscription_id: 'sub_test_123',
      stripe_customer_id: 'cus_test_123',
      current_period_start: PERIOD_START,
      current_period_end: PERIOD_END,
      entitlement_payment_id: 'payment-123',
      entitlement_trial_id: null,
    }
    entitlementPayment = {
      id: 'payment-123',
      user_id: 'user-123',
      payment_kind: 'recurring',
      payment_status: 'paid',
      plan: 'monthly',
      stripe_customer_id: 'cus_test_123',
      stripe_subscription_id: 'sub_test_123',
      period_start: PERIOD_START,
      period_end: PERIOD_END,
      refund_state: 'none',
      refund_succeeded_amount: 0,
      amount_paid: 999,
    }
    trialEntitlement = null
    mockFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return maybeSingleQuery(() => ({ data: localSubscription, error: null }))
      }
      if (table === 'stripe_entitlement_payments') {
        return maybeSingleQuery(() => ({ data: entitlementPayment, error: null }))
      }
      if (table === 'stripe_trial_entitlements') {
        return maybeSingleQuery(() => ({ data: trialEntitlement, error: null }))
      }
      throw new Error(`Unexpected table ${table}`)
    })
    mockGetAuthUser.mockResolvedValue({ id: 'user-123' })
    mockSessionRetrieve.mockResolvedValue(baseSession())
    mockSubscriptionRetrieve.mockResolvedValue(activeSubscription())
    mockPaymentIntentRetrieve.mockResolvedValue({
      latest_charge: { id: 'ch_test_123', refunded: false, amount_refunded: 0 },
    })
    mockActivateLifetimeCheckoutEntitlement.mockResolvedValue({ status: 'activated' })
    mockRpc.mockResolvedValue({ data: true, error: null })
  })

  it('constructs its verifier with the shared pinned Stripe API version', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(STRIPE_API_VERSION).toBe('2026-04-22.dahlia')
    expect(Stripe).toHaveBeenCalledWith('sk_test_123', {
      apiVersion: '2026-04-22.dahlia',
    })
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
    localSubscription = {
      ...localSubscription,
      status: 'trialing',
      entitlement_payment_id: null,
      entitlement_trial_id: 'trial-123',
    }
    trialEntitlement = {
      id: 'trial-123',
      user_id: 'user-123',
      stripe_customer_id: 'cus_test_123',
      stripe_subscription_id: 'sub_test_123',
      plan: 'monthly',
      period_start: PERIOD_START,
      period_end: PERIOD_END,
      revoked_at: null,
    }

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('sync_current_pro_projection_atomic', {
      p_user_id: 'user-123',
    })
    expect(mockRpc).not.toHaveBeenCalledWith('update_subscription_and_profile', expect.anything())
  })

  it('refuses to grant Pro for a Stripe price outside the configured whitelist', async () => {
    mockSubscriptionRetrieve.mockResolvedValue(activeSubscription('price_unknown'))

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when exact entitlement projection sync fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalledWith('update_subscription_and_profile', expect.anything())
  })

  it('does not revive recurring Pro when the exact payment was fully refunded', async () => {
    entitlementPayment = {
      ...entitlementPayment,
      refund_state: 'succeeded',
      refund_succeeded_amount: 999,
    }

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Payment confirmation is still processing or is no longer eligible.',
      code: 'RECURRING_ENTITLEMENT_NOT_READY',
    })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when a refund wins the race before exact projection sync', async () => {
    mockRpc.mockResolvedValue({ data: false, error: null })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(mockRpc).toHaveBeenCalledWith('sync_current_pro_projection_atomic', {
      p_user_id: 'user-123',
    })
    expect(mockRpc).not.toHaveBeenCalledWith('update_subscription_and_profile', expect.anything())
  })
})
