/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Stripe Integration Tests
 * 测试 Stripe 支付集成
 */

import {
  stripe,
  STRIPE_PRICE_IDS,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS_MAP,
  getOrCreateStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  cancelSubscription,
  resumeSubscription,
  getSubscription,
  getCustomerSubscriptions,
  constructWebhookEvent,
  assertProPriceReady,
  assertApiPriceReady,
} from './index'

// Mock server-only (no-op in test environment)
jest.mock('server-only', () => ({}))

// Mock Stripe
jest.mock('stripe', () => {
  const mockStripe = {
    customers: {
      list: jest.fn(),
      create: jest.fn(),
      retrieve: jest.fn(),
    },
    subscriptions: {
      list: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
      cancel: jest.fn(),
    },
    prices: {
      retrieve: jest.fn(),
    },
    checkout: {
      sessions: {
        create: jest.fn(),
      },
    },
    billingPortal: {
      sessions: {
        create: jest.fn(),
      },
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  }
  return jest.fn(() => mockStripe)
})

// Mock environment variables
const originalEnv = process.env

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...originalEnv,
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
    STRIPE_PRO_MONTHLY_PRICE_ID: 'price_monthly_123',
    STRIPE_PRO_YEARLY_PRICE_ID: 'price_yearly_123',
  }
})

afterAll(() => {
  process.env = originalEnv
})

describe('Constants', () => {
  test('STRIPE_PRICE_IDS should have monthly and yearly', () => {
    expect(STRIPE_PRICE_IDS.monthly).toBeDefined()
    expect(STRIPE_PRICE_IDS.yearly).toBeDefined()
  })

  test('Stripe price IDs ignore accidental environment whitespace', () => {
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = ' price_monthly_trimmed\n'
    process.env.STRIPE_PRO_YEARLY_PRICE_ID = '\tprice_yearly_trimmed '
    process.env.STRIPE_PRO_LIFETIME_PRICE_ID = ' price_lifetime_trimmed\n'
    process.env.STRIPE_API_STARTER_PRICE_ID = ' price_api_starter_trimmed\n'
    process.env.STRIPE_API_PRO_PRICE_ID = '\tprice_api_pro_trimmed '

    jest.isolateModules(() => {
      const { STRIPE_PRICE_IDS: priceIds, STRIPE_API_PRICE_IDS: apiPriceIds } = require('./index')
      expect(priceIds).toEqual({
        monthly: 'price_monthly_trimmed',
        yearly: 'price_yearly_trimmed',
        lifetime: 'price_lifetime_trimmed',
      })
      expect(apiPriceIds).toEqual({
        starter: 'price_api_starter_trimmed',
        pro: 'price_api_pro_trimmed',
      })
    })
  })

  test('SUBSCRIPTION_PLANS should have monthly plan', () => {
    expect(SUBSCRIPTION_PLANS.monthly).toBeDefined()
    expect(SUBSCRIPTION_PLANS.monthly.name).toBe('Pro Monthly')
    expect(SUBSCRIPTION_PLANS.monthly.interval).toBe('month')
    expect(SUBSCRIPTION_PLANS.monthly.features.length).toBeGreaterThan(0)
  })

  test('SUBSCRIPTION_PLANS should have yearly plan', () => {
    expect(SUBSCRIPTION_PLANS.yearly).toBeDefined()
    expect(SUBSCRIPTION_PLANS.yearly.name).toBe('Pro Yearly')
    expect(SUBSCRIPTION_PLANS.yearly.interval).toBe('year')
  })

  test('SUBSCRIPTION_STATUS_MAP should map all Stripe statuses', () => {
    expect(SUBSCRIPTION_STATUS_MAP.active).toBe('active')
    expect(SUBSCRIPTION_STATUS_MAP.canceled).toBe('canceled')
    expect(SUBSCRIPTION_STATUS_MAP.incomplete).toBe('incomplete')
    expect(SUBSCRIPTION_STATUS_MAP.incomplete_expired).toBe('expired')
    expect(SUBSCRIPTION_STATUS_MAP.past_due).toBe('past_due')
    expect(SUBSCRIPTION_STATUS_MAP.paused).toBe('paused')
    expect(SUBSCRIPTION_STATUS_MAP.trialing).toBe('trialing')
    expect(SUBSCRIPTION_STATUS_MAP.unpaid).toBe('unpaid')
  })
})

describe('getStripe', () => {
  test('should throw error when STRIPE_SECRET_KEY is not defined', () => {
    delete process.env.STRIPE_SECRET_KEY
    // Clear the cached instance
    jest.resetModules()
    expect(() => {
      const { getStripe: getStripeNew } = require('./index')
      getStripeNew()
    }).toThrow('STRIPE_SECRET_KEY is not configured')
  })
})

describe('stripe proxy', () => {
  test('should expose customers', () => {
    expect(stripe.customers).toBeDefined()
  })

  test('should expose subscriptions', () => {
    expect(stripe.subscriptions).toBeDefined()
  })

  test('should expose prices', () => {
    expect(stripe.prices).toBeDefined()
  })

  test('should expose checkout', () => {
    expect(stripe.checkout).toBeDefined()
  })

  test('should expose billingPortal', () => {
    expect(stripe.billingPortal).toBeDefined()
  })

  test('should expose webhooks', () => {
    expect(stripe.webhooks).toBeDefined()
  })
})

describe('Stripe price readiness', () => {
  test('accepts a test monthly price that matches the visible B2C contract', async () => {
    stripe.prices.retrieve = jest.fn().mockResolvedValue({
      active: true,
      livemode: false,
      currency: 'usd',
      unit_amount: 499,
      recurring: { interval: 'month' },
      product: { active: true },
    })

    await expect(assertProPriceReady('monthly', 'price_monthly')).resolves.toBeUndefined()
  })

  test('rejects a price amount that differs from the visible product price', async () => {
    stripe.prices.retrieve = jest.fn().mockResolvedValue({
      active: true,
      livemode: false,
      currency: 'usd',
      unit_amount: 999,
      recurring: { interval: 'month' },
      product: { active: true },
    })

    await expect(assertProPriceReady('monthly', 'price_monthly')).rejects.toThrow('does not match')
  })

  test('requires live keys and live prices when the production paywall is enabled', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.NEXT_PUBLIC_PRO_FREE_PROMO = 'false'
    stripe.prices.retrieve = jest.fn().mockResolvedValue({
      active: true,
      livemode: false,
      currency: 'usd',
      unit_amount: 499,
      recurring: { interval: 'month' },
      product: { active: true },
    })

    await expect(assertProPriceReady('monthly', 'price_monthly')).rejects.toThrow(
      'live mode is required'
    )
  })

  test('validates the separate API product contract', async () => {
    stripe.prices.retrieve = jest.fn().mockResolvedValue({
      active: true,
      livemode: false,
      currency: 'usd',
      unit_amount: 4900,
      recurring: { interval: 'month' },
      product: { active: true },
    })

    await expect(assertApiPriceReady('starter', 'price_api_starter')).resolves.toBeUndefined()
  })
})

describe('getOrCreateStripeCustomer', () => {
  test('should return existing customer ID', async () => {
    const mockCustomerId = 'cus_existing123'
    stripe.customers.list = jest.fn().mockResolvedValue({
      data: [{ id: mockCustomerId }],
    })

    const result = await getOrCreateStripeCustomer('user123', 'test@example.com')
    expect(result).toBe(mockCustomerId)
    expect(stripe.customers.list).toHaveBeenCalledWith({
      email: 'test@example.com',
      limit: 10,
    })
  })

  test('should create new customer when not found', async () => {
    const mockNewCustomerId = 'cus_new123'
    stripe.customers.list = jest.fn().mockResolvedValue({ data: [] })
    stripe.customers.create = jest.fn().mockResolvedValue({ id: mockNewCustomerId })

    const result = await getOrCreateStripeCustomer('user123', 'test@example.com')
    expect(result).toBe(mockNewCustomerId)
    expect(stripe.customers.create).toHaveBeenCalledWith(
      {
        email: 'test@example.com',
        metadata: { userId: 'user123' },
      },
      { idempotencyKey: 'arena_customer_test_user123' }
    )
  })

  test('should include metadata when creating customer', async () => {
    stripe.customers.list = jest.fn().mockResolvedValue({ data: [] })
    stripe.customers.create = jest.fn().mockResolvedValue({ id: 'cus_new123' })

    await getOrCreateStripeCustomer('user123', 'test@example.com', { plan: 'pro' })
    expect(stripe.customers.create).toHaveBeenCalledWith(
      {
        email: 'test@example.com',
        metadata: { userId: 'user123', plan: 'pro' },
      },
      { idempotencyKey: 'arena_customer_test_user123' }
    )
  })

  test('reuses the customer already linked to the user profile', async () => {
    stripe.customers.retrieve = jest.fn().mockResolvedValue({
      id: 'cus_linked',
      deleted: false,
      metadata: { userId: 'user123' },
    })

    await expect(
      getOrCreateStripeCustomer('user123', 'test@example.com', undefined, 'cus_linked')
    ).resolves.toBe('cus_linked')
    expect(stripe.customers.list).not.toHaveBeenCalled()
  })
})

describe('createCheckoutSession', () => {
  test('should create checkout session', async () => {
    const mockSession = {
      id: 'cs_test123',
      url: 'https://checkout.stripe.com/...',
    }
    stripe.checkout.sessions.create = jest.fn().mockResolvedValue(mockSession)

    const result = await createCheckoutSession({
      customerId: 'cus_123',
      priceId: 'price_123',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    })

    expect(result).toBe(mockSession)
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_123',
        mode: 'subscription',
        success_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel',
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    )
  })

  test('should include metadata', async () => {
    stripe.checkout.sessions.create = jest.fn().mockResolvedValue({ id: 'cs_test123' })

    await createCheckoutSession({
      customerId: 'cus_123',
      priceId: 'price_123',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: { source: 'homepage' },
    })

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { source: 'homepage' },
        subscription_data: {
          metadata: { source: 'homepage' },
        },
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    )
  })
})

describe('createPortalSession', () => {
  test('should create portal session', async () => {
    const mockSession = {
      id: 'bps_test123',
      url: 'https://billing.stripe.com/...',
    }
    stripe.billingPortal.sessions.create = jest.fn().mockResolvedValue(mockSession)

    const result = await createPortalSession('cus_123', 'https://example.com/account')

    expect(result).toBe(mockSession)
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'https://example.com/account',
    })
  })
})

describe('cancelSubscription', () => {
  test('should cancel subscription immediately', async () => {
    const mockSubscription = { id: 'sub_123', status: 'canceled' }
    stripe.subscriptions.cancel = jest.fn().mockResolvedValue(mockSubscription)

    const result = await cancelSubscription('sub_123', true)

    expect(result).toBe(mockSubscription)
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_123')
  })

  test('should cancel subscription at period end', async () => {
    const mockSubscription = { id: 'sub_123', cancel_at_period_end: true }
    stripe.subscriptions.update = jest.fn().mockResolvedValue(mockSubscription)

    const result = await cancelSubscription('sub_123', false)

    expect(result).toBe(mockSubscription)
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_123', {
      cancel_at_period_end: true,
    })
  })

  test('should default to cancel at period end', async () => {
    stripe.subscriptions.update = jest.fn().mockResolvedValue({ id: 'sub_123' })

    await cancelSubscription('sub_123')

    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_123', {
      cancel_at_period_end: true,
    })
  })
})

describe('resumeSubscription', () => {
  test('should resume subscription', async () => {
    const mockSubscription = { id: 'sub_123', cancel_at_period_end: false }
    stripe.subscriptions.update = jest.fn().mockResolvedValue(mockSubscription)

    const result = await resumeSubscription('sub_123')

    expect(result).toBe(mockSubscription)
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_123', {
      cancel_at_period_end: false,
    })
  })
})

describe('getSubscription', () => {
  test('should retrieve subscription', async () => {
    const mockSubscription = { id: 'sub_123', status: 'active' }
    stripe.subscriptions.retrieve = jest.fn().mockResolvedValue(mockSubscription)

    const result = await getSubscription('sub_123')

    expect(result).toBe(mockSubscription)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123')
  })
})

describe('getCustomerSubscriptions', () => {
  test('should list customer subscriptions', async () => {
    const mockSubscriptions = [
      { id: 'sub_1', status: 'active' },
      { id: 'sub_2', status: 'canceled' },
    ]
    stripe.subscriptions.list = jest.fn().mockResolvedValue({ data: mockSubscriptions })

    const result = await getCustomerSubscriptions('cus_123')

    expect(result).toEqual(mockSubscriptions)
    expect(stripe.subscriptions.list).toHaveBeenCalledWith({
      customer: 'cus_123',
      status: 'all',
    })
  })
})

describe('constructWebhookEvent', () => {
  test('should construct webhook event', () => {
    const mockEvent = { id: 'evt_123', type: 'customer.subscription.created' }
    stripe.webhooks.constructEvent = jest.fn().mockReturnValue(mockEvent)

    const result = constructWebhookEvent('payload', 'signature')

    expect(result).toBe(mockEvent)
    expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
      'payload',
      'signature',
      'whsec_test_123'
    )
  })
})
