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
  createOneTimePaymentSession,
  createPortalSession,
  cancelSubscription,
  resumeSubscription,
  getSubscription,
  getCustomerSubscriptions,
  constructWebhookEvent,
  assertProPriceReady,
  assertApiPriceReady,
  assertStripePaymentRuntimeReady,
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
      update: jest.fn(),
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

describe('Stripe payment runtime readiness', () => {
  test('accepts test mode outside Production when signed webhooks are configured', () => {
    process.env.VERCEL_ENV = 'preview'
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123'

    expect(() => assertStripePaymentRuntimeReady()).not.toThrow()
  })

  test('requires a valid webhook signing secret before any paid action', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'invalid'

    expect(() => assertStripePaymentRuntimeReady()).toThrow('STRIPE_WEBHOOK_SECRET is invalid')
  })

  test('rejects test keys for Production payment actions even during a free promo', () => {
    process.env.VERCEL_ENV = 'production'
    process.env.NEXT_PUBLIC_PRO_FREE_PROMO = 'true'
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123'

    expect(() => assertStripePaymentRuntimeReady()).toThrow(
      'Stripe live mode is required for Production payment actions'
    )
  })

  test('accepts matching live keys for Production payment actions', () => {
    process.env.VERCEL_ENV = 'production'
    process.env.STRIPE_SECRET_KEY = 'sk_live_123'
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_live_123'

    expect(() => assertStripePaymentRuntimeReady()).not.toThrow()
  })
})

describe('getOrCreateStripeCustomer', () => {
  test('reuses an email-matched customer only when Stripe metadata names the same user', async () => {
    const mockCustomerId = 'cus_existing123'
    stripe.customers.list = jest.fn().mockResolvedValue({
      data: [{ id: mockCustomerId, metadata: { userId: 'user123' } }],
    })

    const result = await getOrCreateStripeCustomer('user123', 'test@example.com')
    expect(result).toBe(mockCustomerId)
    expect(stripe.customers.list).toHaveBeenCalledWith({
      email: 'test@example.com',
      limit: 100,
    })
  })

  test('continues email pagination until an owned customer after the first ten results is found', async () => {
    const firstTen = Array.from({ length: 10 }, (_, index) => ({
      id: `cus_other_${index + 1}`,
      metadata: { userId: `other-user-${index + 1}` },
    }))
    stripe.customers.list = jest
      .fn()
      .mockResolvedValueOnce({ data: firstTen, has_more: true })
      .mockResolvedValueOnce({
        data: [{ id: 'cus_owned_11', metadata: { userId: 'user123' } }],
        has_more: false,
      })

    await expect(getOrCreateStripeCustomer('user123', 'test@example.com')).resolves.toBe(
      'cus_owned_11'
    )
    expect(stripe.customers.list).toHaveBeenNthCalledWith(1, {
      email: 'test@example.com',
      limit: 100,
    })
    expect(stripe.customers.list).toHaveBeenNthCalledWith(2, {
      email: 'test@example.com',
      limit: 100,
      starting_after: 'cus_other_10',
    })
    expect(stripe.customers.create).not.toHaveBeenCalled()
  })

  test('fails closed when Stripe customer email pagination does not advance', async () => {
    stripe.customers.list = jest.fn().mockResolvedValue({ data: [], has_more: true })

    await expect(getOrCreateStripeCustomer('user123', 'test@example.com')).rejects.toThrow(
      'Stripe customer email lookup pagination did not advance'
    )
    expect(stripe.customers.create).not.toHaveBeenCalled()
  })

  test('does not claim an ownerless email-matched customer', async () => {
    stripe.customers.list = jest.fn().mockResolvedValue({
      data: [{ id: 'cus_ownerless', metadata: {} }],
    })
    stripe.customers.create = jest.fn().mockResolvedValue({ id: 'cus_new123' })

    await expect(getOrCreateStripeCustomer('user123', 'test@example.com')).resolves.toBe(
      'cus_new123'
    )
    expect(stripe.customers.create).toHaveBeenCalled()
  })

  test('does not reuse an email-matched customer owned by another user', async () => {
    stripe.customers.list = jest.fn().mockResolvedValue({
      data: [{ id: 'cus_other', metadata: { userId: 'other-user' } }],
    })
    stripe.customers.create = jest.fn().mockResolvedValue({ id: 'cus_new123' })

    await expect(getOrCreateStripeCustomer('user123', 'test@example.com')).resolves.toBe(
      'cus_new123'
    )
    expect(stripe.customers.create).toHaveBeenCalled()
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

  test.each(['userId', 'user_id', 'supabase_user_id'])(
    'rejects caller-supplied Stripe customer owner alias %s',
    async (ownerAlias) => {
      await expect(
        getOrCreateStripeCustomer('user123', 'test@example.com', {
          plan: 'pro',
          [ownerAlias]: 'attacker-user',
        })
      ).rejects.toThrow(`Stripe customer metadata must not include owner alias ${ownerAlias}`)
      expect(stripe.customers.list).not.toHaveBeenCalled()
      expect(stripe.customers.create).not.toHaveBeenCalled()
      expect(stripe.customers.retrieve).not.toHaveBeenCalled()
    }
  )

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

  test('repairs owner metadata before reusing a locally linked legacy customer', async () => {
    stripe.customers.retrieve = jest.fn().mockResolvedValue({
      id: 'cus_linked',
      deleted: false,
      metadata: {},
    })
    stripe.customers.update = jest.fn().mockResolvedValue({
      id: 'cus_linked',
      metadata: { userId: 'user123' },
    })

    await expect(
      getOrCreateStripeCustomer('user123', 'test@example.com', undefined, 'cus_linked')
    ).resolves.toBe('cus_linked')
    expect(stripe.customers.update).toHaveBeenCalledWith('cus_linked', {
      metadata: { userId: 'user123' },
    })
    expect(stripe.customers.list).not.toHaveBeenCalled()
  })

  test('blocks Checkout when linked-customer owner repair fails', async () => {
    stripe.customers.retrieve = jest.fn().mockResolvedValue({
      id: 'cus_linked',
      deleted: false,
      metadata: {},
    })
    stripe.customers.update = jest.fn().mockRejectedValue(new Error('Stripe metadata unavailable'))

    await expect(
      getOrCreateStripeCustomer('user123', 'test@example.com', undefined, 'cus_linked')
    ).rejects.toThrow('Stripe metadata unavailable')
    expect(stripe.customers.list).not.toHaveBeenCalled()
  })

  test('rejects conflicting identity metadata on a locally linked customer', async () => {
    stripe.customers.retrieve = jest.fn().mockResolvedValue({
      id: 'cus_linked',
      deleted: false,
      metadata: { userId: 'user123', supabase_user_id: 'other-user' },
    })

    await expect(
      getOrCreateStripeCustomer('user123', 'test@example.com', undefined, 'cus_linked')
    ).rejects.toThrow('Stored Stripe customer cus_linked has conflicting user identities')
    expect(stripe.customers.update).not.toHaveBeenCalled()
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
        allow_promotion_codes: true,
        automatic_tax: { enabled: false },
        adaptive_pricing: { enabled: false },
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    )
  })

  test('can explicitly remove the hosted promotion-code field without changing the default', async () => {
    stripe.checkout.sessions.create = jest.fn().mockResolvedValue({ id: 'cs_test123' })

    await createCheckoutSession({
      customerId: 'cus_123',
      priceId: 'price_123',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      allowPromotionCodes: false,
    })

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        allow_promotion_codes: false,
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

describe('createOneTimePaymentSession', () => {
  test('freezes dashboard-controlled price mutation for exact one-time payments', async () => {
    process.env.VERCEL_ENV = 'preview'
    const mockSession = {
      id: 'cs_tip123',
      url: 'https://checkout.stripe.com/...',
    }
    stripe.checkout.sessions.create = jest.fn().mockResolvedValue(mockSession)

    const result = await createOneTimePaymentSession({
      customerId: 'cus_123',
      userId: 'user-123',
      discriminator: 'tip_post-123_500',
      lineItems: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Tip' },
            unit_amount: 500,
          },
          quantity: 1,
        },
      ],
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: { type: 'tip', tip_id: 'tip-123' },
    })

    expect(result).toBe(mockSession)
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_123',
        mode: 'payment',
        allow_promotion_codes: false,
        automatic_tax: { enabled: false },
        adaptive_pricing: { enabled: false },
        metadata: {
          type: 'tip',
          tip_id: 'tip-123',
          user_id: 'user-123',
        },
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^payment_user-123_tip_post-123_500_/),
      })
    )
  })

  test('refuses a Production test-mode tip before creating Checkout', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123'
    stripe.checkout.sessions.create = jest.fn()

    await expect(
      createOneTimePaymentSession({
        customerId: 'cus_123',
        userId: 'user-123',
        discriminator: 'tip_post-123_500',
        lineItems: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'Tip' },
              unit_amount: 500,
            },
            quantity: 1,
          },
        ],
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
        metadata: { type: 'tip', tip_id: 'tip-123' },
      })
    ).rejects.toThrow('Stripe live mode is required for Production payment actions')

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  test('refuses a Production tip when signed webhook fulfillment is unavailable', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.STRIPE_SECRET_KEY = 'sk_live_123'
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_live_123'
    delete process.env.STRIPE_WEBHOOK_SECRET
    stripe.checkout.sessions.create = jest.fn()

    await expect(
      createOneTimePaymentSession({
        customerId: 'cus_123',
        userId: 'user-123',
        discriminator: 'tip_post-123_500',
        lineItems: [],
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
        metadata: { type: 'tip', tip_id: 'tip-123' },
      })
    ).rejects.toThrow('STRIPE_WEBHOOK_SECRET is not configured')

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
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
