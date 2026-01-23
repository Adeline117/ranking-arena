/**
 * Stripe Integration Tests
 * 测试 Stripe 支付集成
 */

import {
  getStripe,
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
} from './index'

// Mock server-only (no-op in test environment)
jest.mock('server-only', () => ({}))

// Mock Stripe
jest.mock('stripe', () => {
  const mockStripe = {
    customers: {
      list: jest.fn(),
      create: jest.fn(),
    },
    subscriptions: {
      list: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
      cancel: jest.fn(),
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
      limit: 1,
    })
  })

  test('should create new customer when not found', async () => {
    const mockNewCustomerId = 'cus_new123'
    stripe.customers.list = jest.fn().mockResolvedValue({ data: [] })
    stripe.customers.create = jest.fn().mockResolvedValue({ id: mockNewCustomerId })

    const result = await getOrCreateStripeCustomer('user123', 'test@example.com')
    expect(result).toBe(mockNewCustomerId)
    expect(stripe.customers.create).toHaveBeenCalledWith({
      email: 'test@example.com',
      metadata: { userId: 'user123' },
    })
  })

  test('should include metadata when creating customer', async () => {
    stripe.customers.list = jest.fn().mockResolvedValue({ data: [] })
    stripe.customers.create = jest.fn().mockResolvedValue({ id: 'cus_new123' })

    await getOrCreateStripeCustomer('user123', 'test@example.com', { plan: 'pro' })
    expect(stripe.customers.create).toHaveBeenCalledWith({
      email: 'test@example.com',
      metadata: { userId: 'user123', plan: 'pro' },
    })
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
      })
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
      })
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
