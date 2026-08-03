const mockRetrieveSubscription = jest.fn()
const mockCancelSubscription = jest.fn()
const mockListProSubscriptionItems = jest.fn()
const mockGetStripeClient = {
  subscriptions: {
    retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args),
  },
  subscriptionItems: {
    list: (...args: unknown[]) => mockListProSubscriptionItems(...args),
  },
}
jest.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args),
      cancel: (...args: unknown[]) => mockCancelSubscription(...args),
    },
  },
  getStripe: () => mockGetStripeClient,
  SUBSCRIPTION_STATUS_MAP: { active: 'active', canceled: 'canceled', trialing: 'trialing' },
  STRIPE_API_PRICE_IDS: { starter: 'price_api_starter', pro: 'price_api_pro' },
  API_TIER_LIMITS: { free: 100, starter: 10_000, pro: 0 },
  STRIPE_PRICE_IDS: {
    monthly: 'price_pro_monthly',
    yearly: 'price_pro_yearly',
    lifetime: 'price_pro_lifetime',
  },
}))
jest.mock('@/lib/env', () => ({
  env: { STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly' },
}))

const mockActivateLifetimeCheckoutEntitlement = jest.fn()
const mockRecordStripeCheckoutManualReview = jest.fn()
jest.mock('@/lib/stripe/lifetime-entitlement', () => ({
  activateLifetimeCheckoutEntitlement: (...args: unknown[]) =>
    mockActivateLifetimeCheckoutEntitlement(...args),
  recordStripeCheckoutManualReview: (...args: unknown[]) =>
    mockRecordStripeCheckoutManualReview(...args),
  lifetimeActivationGranted: (status: string) =>
    status === 'activated' || status === 'already_activated',
  LIFETIME_RESERVATION_ID_METADATA_KEY: 'lifetime_reservation_id',
  LIFETIME_RESERVATION_NONCE_METADATA_KEY: 'lifetime_reservation_nonce',
}))

const mockCompleteTipCheckout = jest.fn()
jest.mock('@/lib/stripe/tip-completion', () => ({
  completeTipCheckout: (...args: unknown[]) => mockCompleteTipCheckout(...args),
}))

const mockActivateExactRecurringCheckout = jest.fn()
jest.mock('@/lib/stripe/recurring-entitlement', () => ({
  activateExactRecurringCheckout: (...args: unknown[]) =>
    mockActivateExactRecurringCheckout(...args),
}))

const mockUpdateUserSubscription = jest.fn()
const mockGetProPlanFromPriceId = jest.fn()
const mockApplyApiTierStripeEvent = jest.fn()
jest.mock('../subscription', () => {
  const actual = jest.requireActual('../subscription')
  return {
    ...actual,
    applyApiTierStripeEvent: (...args: unknown[]) => mockApplyApiTierStripeEvent(...args),
    updateUserSubscription: (...args: unknown[]) => mockUpdateUserSubscription(...args),
    getProPlanFromPriceId: (...args: unknown[]) => mockGetProPlanFromPriceId(...args),
  }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockJoinProOfficialGroup = jest.fn()
const mockMintNFTForUser = jest.fn()
const mockSendAlert = jest.fn()
jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  withRetry: (operation: () => unknown) => operation(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))

jest.mock('@/app/api/pro-official-group/route', () => ({
  joinProOfficialGroup: (...args: unknown[]) => mockJoinProOfficialGroup(...args),
}))
jest.mock('../nft', () => ({
  mintNFTForUser: (...args: unknown[]) => mockMintNFTForUser(...args),
}))
jest.mock('@/lib/alerts/send-alert', () => ({
  sendAlert: (...args: unknown[]) => mockSendAlert(...args),
}))
jest.mock('@/lib/utils/logger', () => ({ fireAndForget: jest.fn() }))

import type Stripe from 'stripe'
import {
  handleCheckoutComplete,
  handleCheckoutExpired,
  handleTipPaymentCompleted,
} from '../checkout'

function checkoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return {
    id: 'cs_test_123',
    mode: 'subscription',
    payment_status: 'paid',
    livemode: true,
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    metadata: {
      currency: 'usd',
      userId: proUserId,
      supabase_user_id: proUserId,
      plan: 'monthly',
    },
    ...overrides,
  } as Stripe.Checkout.Session
}

const lifetimeUserId = '21e34ce2-43c1-4bcc-8f19-79b36d56605c'
const apiUserId = '11e34ce2-43c1-4bcc-8f19-79b36d56605c'
const apiReservationId = '81e34ce2-43c1-4bcc-8f19-79b36d56605c'
const proUserId = '61e34ce2-43c1-4bcc-8f19-79b36d56605c'
const proReservationId = '71e34ce2-43c1-4bcc-8f19-79b36d56605c'
const lifetimeReservationId = '9a8df3e8-e908-4f27-9cb4-8b892d748cc7'
const lifetimeRequestNonce = `lifetime:${lifetimeUserId}:123`
const expiredEvent = { id: 'evt_expired_123', created: 1_800_000_000, livemode: true }
const tipEvent = { id: 'evt_tip_123', created: 1_800_000_000, livemode: true }
const checkoutEvent = { id: 'evt_checkout_123', created: 1_800_000_000, livemode: true }
const tipCheckoutId = '31e34ce2-43c1-4bcc-8f19-79b36d56605c'
const tipPostId = '41e34ce2-43c1-4bcc-8f19-79b36d56605c'
const tipRecipientId = '51e34ce2-43c1-4bcc-8f19-79b36d56605c'
const tipCheckoutExpiresAt = 1_900_000_000

function expiredTipSession(
  metadataOverrides: Record<string, string> = {},
  sessionOverrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return checkoutSession({
    id: 'cs_tip_expired_123',
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'unpaid',
    status: 'expired',
    subscription: null,
    client_reference_id: tipCheckoutId,
    expires_at: tipCheckoutExpiresAt,
    livemode: true,
    metadata: {
      type: 'tip',
      tip_id: tipCheckoutId,
      user_id: lifetimeUserId,
      from_user_id: lifetimeUserId,
      post_id: tipPostId,
      to_user_id: tipRecipientId,
      amount_cents: '500',
      ...metadataOverrides,
    },
    ...sessionOverrides,
  })
}

function expiredLifetimeSession(
  metadataOverrides: Record<string, string> = {}
): Stripe.Checkout.Session {
  return checkoutSession({
    mode: 'payment',
    payment_status: 'unpaid',
    subscription: null,
    metadata: {
      userId: lifetimeUserId,
      supabase_user_id: lifetimeUserId,
      plan: 'lifetime',
      lifetime_reservation_id: lifetimeReservationId,
      lifetime_reservation_nonce: lifetimeRequestNonce,
      ...metadataOverrides,
    },
  })
}

function paidLifetimeSession(
  metadataOverrides: Record<string, string> = {}
): Stripe.Checkout.Session {
  return checkoutSession({
    mode: 'payment',
    payment_status: 'paid',
    subscription: null,
    metadata: {
      userId: lifetimeUserId,
      supabase_user_id: lifetimeUserId,
      plan: 'lifetime',
      lifetime_reservation_id: lifetimeReservationId,
      lifetime_reservation_nonce: lifetimeRequestNonce,
      ...metadataOverrides,
    },
  })
}

function apiCheckoutSession(
  plan: 'starter' | 'pro' = 'pro',
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return checkoutSession({
    object: 'checkout.session',
    created: 1_690_000_000,
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    client_reference_id: apiReservationId,
    metadata: {
      userId: apiUserId,
      supabase_user_id: apiUserId,
      type: 'api_tier',
      api_plan: plan,
      api_tier_reservation_id: apiReservationId,
    },
    ...overrides,
  })
}

function expiredApiSession(
  metadataOverrides: Record<string, string> = {},
  sessionOverrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return apiCheckoutSession('pro', {
    status: 'expired',
    payment_status: 'unpaid',
    subscription: null,
    expires_at: 1_790_000_000,
    metadata: {
      userId: apiUserId,
      supabase_user_id: apiUserId,
      type: 'api_tier',
      api_plan: 'pro',
      api_tier_reservation_id: apiReservationId,
      ...metadataOverrides,
    },
    ...sessionOverrides,
  })
}

function apiSubscription(
  plan: 'starter' | 'pro' = 'pro',
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return {
    id: 'sub_test_123',
    status: 'active',
    created: 1_700_000_000,
    livemode: true,
    customer: 'cus_test_123',
    metadata: {
      userId: apiUserId,
      supabase_user_id: apiUserId,
      type: 'api_tier',
      api_plan: plan,
      api_tier_reservation_id: apiReservationId,
    },
    items: {
      data: [
        {
          quantity: 1,
          price: { id: plan === 'starter' ? 'price_api_starter' : 'price_api_pro' },
        },
      ],
    },
    ...overrides,
  } as Stripe.Subscription
}

function proCheckoutSession(
  plan: 'monthly' | 'yearly' = 'monthly',
  overrides: Partial<Stripe.Checkout.Session> = {},
  trialDays: 0 | 7 = 0
): Stripe.Checkout.Session {
  const priceId = plan === 'monthly' ? 'price_pro_monthly' : 'price_pro_yearly'
  const unitAmount = plan === 'monthly' ? 499 : 2999
  const amount = trialDays === 7 ? 0 : unitAmount
  return checkoutSession({
    object: 'checkout.session',
    created: 1_690_000_000,
    mode: 'subscription',
    status: 'complete',
    payment_status: trialDays === 7 ? 'no_payment_required' : 'paid',
    livemode: true,
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    client_reference_id: proReservationId,
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
    after_expiration: null,
    recovered_from: null,
    metadata: {
      currency: 'usd',
      userId: proUserId,
      supabase_user_id: proUserId,
      type: 'pro_membership',
      plan,
      pro_membership_reservation_id: proReservationId,
      pro_price_id: priceId,
      trial_days: String(trialDays),
      unit_amount: String(unitAmount),
    },
    ...overrides,
  })
}

function proSubscription(
  plan: 'monthly' | 'yearly' = 'monthly',
  overrides: Partial<Stripe.Subscription> = {},
  trialDays: 0 | 7 = 0
): Stripe.Subscription {
  const priceId = plan === 'monthly' ? 'price_pro_monthly' : 'price_pro_yearly'
  const amount = plan === 'monthly' ? 499 : 2999
  const trialStart = trialDays === 7 ? 1_799_000_000 : null
  const trialEnd = trialDays === 7 ? trialStart + 604_800 : null
  return {
    id: 'sub_test_123',
    object: 'subscription',
    status: trialDays === 7 ? 'trialing' : 'active',
    created: 1_700_000_000,
    livemode: true,
    customer: 'cus_test_123',
    metadata: {
      currency: 'usd',
      userId: proUserId,
      supabase_user_id: proUserId,
      type: 'pro_membership',
      plan,
      pro_membership_reservation_id: proReservationId,
      pro_price_id: priceId,
      trial_days: String(trialDays),
      unit_amount: String(amount),
    },
    collection_method: 'charge_automatically',
    currency: 'usd',
    automatic_tax: { enabled: false },
    default_tax_rates: [],
    pause_collection: null,
    schedule: null,
    cancel_at_period_end: false,
    canceled_at: null,
    pending_update: null,
    discounts: [],
    trial_start: trialStart,
    trial_end: trialEnd,
    items: {
      data: [
        {
          id: 'si_pro_123',
          object: 'subscription_item',
          subscription: 'sub_test_123',
          quantity: 1,
          discounts: [],
          tax_rates: [],
          price: {
            id: priceId,
            object: 'price',
            type: 'recurring',
            active: true,
            livemode: true,
            billing_scheme: 'per_unit',
            currency: 'usd',
            unit_amount: amount,
            unit_amount_decimal: String(amount),
            custom_unit_amount: null,
            transform_quantity: null,
            tiers_mode: null,
            recurring: {
              interval: plan === 'monthly' ? 'month' : 'year',
              interval_count: 1,
              usage_type: 'licensed',
            },
          },
        },
      ],
      has_more: false,
    },
    ...overrides,
  } as Stripe.Subscription
}

function expiredProSession(
  metadataOverrides: Record<string, string> = {},
  sessionOverrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return proCheckoutSession('monthly', {
    status: 'expired',
    payment_status: 'unpaid',
    subscription: null,
    expires_at: 1_790_000_000,
    metadata: {
      currency: 'usd',
      userId: proUserId,
      supabase_user_id: proUserId,
      type: 'pro_membership',
      plan: 'monthly',
      pro_membership_reservation_id: proReservationId,
      pro_price_id: 'price_pro_monthly',
      trial_days: '0',
      unit_amount: '499',
      ...metadataOverrides,
    },
    ...sessionOverrides,
  })
}

function apiOwnerQuery(
  data: unknown = {
    id: apiUserId,
    api_stripe_subscription_id: null,
    api_tier: 'free',
    stripe_customer_id: 'cus_test_123',
  },
  error: { message: string } | null = null
) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(async () => ({ data, error })),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function noExistingSubscriptionQuery() {
  return {
    select: () => ({
      eq: () => ({
        in: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  }
}

describe('handleCheckoutComplete entitlement safety', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockFrom.mockReturnValue(noExistingSubscriptionQuery())
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_test_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
    })
    mockUpdateUserSubscription.mockResolvedValue(undefined)
    mockApplyApiTierStripeEvent.mockResolvedValue(undefined)
    mockListProSubscriptionItems.mockResolvedValue({ data: [], has_more: false })
    mockGetProPlanFromPriceId.mockReturnValue('monthly')
    mockJoinProOfficialGroup.mockResolvedValue({ success: true, groupId: 'pro-group' })
    mockMintNFTForUser.mockResolvedValue(undefined)
    mockSendAlert.mockResolvedValue(undefined)
    mockActivateLifetimeCheckoutEntitlement.mockResolvedValue({ status: 'activated' })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
    mockActivateExactRecurringCheckout.mockResolvedValue({ status: 'activated' })
    mockRpc.mockResolvedValue({ error: null })
  })

  it('keeps a paid checkout retryable when user metadata is missing', async () => {
    await expect(
      handleCheckoutComplete(checkoutSession({ metadata: { plan: 'monthly' } }))
    ).rejects.toThrow('Checkout cs_test_123 cannot be mapped to a user')
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('keeps a subscription checkout retryable when its subscription id is missing', async () => {
    await expect(handleCheckoutComplete(checkoutSession({ subscription: null }))).rejects.toThrow(
      'Checkout cs_test_123 is missing its subscription ID'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('rejects invalid API entitlement metadata instead of acknowledging it', async () => {
    await expect(
      handleCheckoutComplete(
        apiCheckoutSession('pro', {
          metadata: {
            userId: apiUserId,
            supabase_user_id: apiUserId,
            type: 'api_tier',
            api_plan: 'enterprise',
            api_tier_reservation_id: apiReservationId,
          },
        }),
        checkoutEvent
      )
    ).rejects.toThrow('API checkout cs_test_123 has invalid exact entitlement identity')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rethrows a Stripe lookup failure so the webhook remains retryable', async () => {
    mockActivateExactRecurringCheckout.mockRejectedValue(new Error('temporary Stripe outage'))

    await expect(handleCheckoutComplete(checkoutSession(), checkoutEvent)).rejects.toThrow(
      'temporary Stripe outage'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('does not consult the legacy subscription projection before atomic activation', async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          in: () => ({
            maybeSingle: async () => ({
              data: null,
              error: { message: 'temporary subscriptions read failure' },
            }),
          }),
        }),
      }),
    })

    await expect(handleCheckoutComplete(checkoutSession(), checkoutEvent)).resolves.toBeUndefined()
    expect(mockActivateExactRecurringCheckout).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('routes a legacy no-payment-required trial only through atomic authority', async () => {
    const trialSession = checkoutSession({ payment_status: 'no_payment_required' })

    await handleCheckoutComplete(trialSession, checkoutEvent)

    expect(mockActivateExactRecurringCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ session: trialSession, expectedUserId: proUserId })
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('converts an exact durable Pro reservation before ordinary entitlement projection', async () => {
    const subscription = proSubscription()
    mockRetrieveSubscription.mockResolvedValue(subscription)
    mockRpc.mockResolvedValue({
      data: {
        status: 'converted',
        effective_subscription_status: 'active',
        observation: 'recorded',
      },
      error: null,
    })

    await handleCheckoutComplete(proCheckoutSession(), checkoutEvent)

    expect(mockRpc).toHaveBeenCalledWith('convert_pro_membership_checkout_reservation_atomic', {
      p_reservation_id: proReservationId,
      p_user_id: proUserId,
      p_livemode: true,
      p_stripe_customer_id: 'cus_test_123',
      p_pro_plan: 'monthly',
      p_stripe_price_id: 'price_pro_monthly',
      p_unit_amount: 499,
      p_currency: 'usd',
      p_trial_days: 0,
      p_checkout_session_id: 'cs_test_123',
      p_stripe_subscription_id: 'sub_test_123',
      p_payment_status: 'paid',
      p_subscription_status: 'active',
      p_trial_start: null,
      p_trial_end: null,
      p_stripe_event_id: 'evt_checkout_123',
      p_stripe_event_created: 1_800_000_000,
    })
    expect(mockActivateExactRecurringCheckout).toHaveBeenCalledWith({
      stripe: mockGetStripeClient,
      supabase: expect.objectContaining({ rpc: expect.any(Function) }),
      session: expect.objectContaining({ id: 'cs_test_123' }),
      event: checkoutEvent,
      expectedUserId: proUserId,
    })
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
    expect(mockMintNFTForUser).not.toHaveBeenCalled()
    expect(mockRetrieveSubscription).toHaveBeenCalledTimes(1)
  })

  it('reports conversion to recovery only after both the financial marker and downstream disposition complete', async () => {
    mockRetrieveSubscription.mockResolvedValue(proSubscription())
    mockRpc.mockResolvedValue({
      data: {
        status: 'converted',
        effective_subscription_status: 'active',
        observation: 'recorded',
      },
      error: null,
    })
    mockActivateExactRecurringCheckout.mockResolvedValue({
      status: 'reviewed',
      reviewCode: 'account_inactive_no_grant',
    })

    await expect(
      handleCheckoutComplete(proCheckoutSession(), checkoutEvent, {
        reportProReservationConversion: true,
      })
    ).resolves.toEqual({ status: 'pro_reservation_converted' })

    expect(mockRpc).toHaveBeenCalledWith(
      'convert_pro_membership_checkout_reservation_atomic',
      expect.anything()
    )
    expect(mockActivateExactRecurringCheckout).toHaveBeenCalledTimes(1)
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
    expect(mockMintNFTForUser).not.toHaveBeenCalled()
  })

  it('accepts an idempotent exact Pro reservation conversion replay', async () => {
    mockRetrieveSubscription.mockResolvedValue(proSubscription())
    mockRpc.mockResolvedValue({
      data: {
        status: 'already_converted',
        effective_subscription_status: 'active',
        observation: 'replayed',
      },
      error: null,
    })

    await expect(
      handleCheckoutComplete(proCheckoutSession(), checkoutEvent)
    ).resolves.toBeUndefined()

    expect(mockActivateExactRecurringCheckout).toHaveBeenCalledTimes(1)
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('converts an exact seven-day no-payment-required trial reservation', async () => {
    const subscription = proSubscription('monthly', {}, 7)
    const session = proCheckoutSession('monthly', {}, 7)
    mockRetrieveSubscription.mockResolvedValue(subscription)
    mockRpc.mockResolvedValue({
      data: {
        status: 'converted',
        effective_subscription_status: 'trialing',
        observation: 'recorded',
      },
      error: null,
    })

    await handleCheckoutComplete(session, checkoutEvent)

    expect(mockRpc).toHaveBeenCalledWith(
      'convert_pro_membership_checkout_reservation_atomic',
      expect.objectContaining({
        p_trial_days: 7,
        p_payment_status: 'no_payment_required',
        p_subscription_status: 'trialing',
        p_trial_start: 1_799_000_000,
        p_trial_end: 1_799_604_800,
      })
    )
    expect(mockActivateExactRecurringCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ session, expectedUserId: proUserId })
    )
  })

  it.each([
    [
      'paid checkout canceled before completion handling',
      proCheckoutSession(),
      proSubscription('monthly', { status: 'canceled', canceled_at: 1_799_900_000 }),
      0,
    ],
    [
      'trial checkout canceled before completion handling',
      proCheckoutSession('monthly', {}, 7),
      proSubscription('monthly', { status: 'canceled', canceled_at: 1_799_900_000 }, 7),
      7,
    ],
    [
      'paid checkout expired incomplete before completion handling',
      proCheckoutSession(),
      proSubscription('monthly', { status: 'incomplete_expired' }),
      0,
    ],
    [
      'trial checkout expired incomplete before completion handling',
      proCheckoutSession('monthly', {}, 7),
      proSubscription('monthly', { status: 'incomplete_expired' }, 7),
      7,
    ],
  ])(
    'consumes the reservation for a %s without direct entitlement writes',
    async (_label, session, subscription, trialDays) => {
      mockRetrieveSubscription.mockResolvedValue(subscription)
      mockRpc.mockResolvedValue({
        data: {
          status: 'converted',
          effective_subscription_status: subscription.status,
          observation: 'recorded',
        },
        error: null,
      })

      await handleCheckoutComplete(session, checkoutEvent)

      expect(mockRpc).toHaveBeenCalledWith(
        'convert_pro_membership_checkout_reservation_atomic',
        expect.objectContaining({
          p_subscription_status: subscription.status,
          p_trial_days: trialDays,
        })
      )
      expect(mockActivateExactRecurringCheckout).toHaveBeenCalledTimes(1)
      expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['paid', 0, 'past_due'],
    ['paid', 0, 'unpaid'],
    ['paid', 0, 'paused'],
    ['trial', 7, 'active'],
    ['trial', 7, 'past_due'],
    ['trial', 7, 'unpaid'],
    ['trial', 7, 'paused'],
  ] as const)(
    'converts a delayed %s completion whose current Subscription is already %s days / %s',
    async (_kind, trialDays, subscriptionStatus) => {
      const session = proCheckoutSession('monthly', {}, trialDays)
      const subscription = proSubscription('monthly', { status: subscriptionStatus }, trialDays)
      mockRetrieveSubscription.mockResolvedValue(subscription)
      mockRpc.mockResolvedValue({
        data: {
          status: 'converted',
          effective_subscription_status: subscriptionStatus,
          observation: 'recorded',
        },
        error: null,
      })

      await expect(handleCheckoutComplete(session, checkoutEvent)).resolves.toBeUndefined()

      expect(mockRpc).toHaveBeenCalledWith(
        'convert_pro_membership_checkout_reservation_atomic',
        expect.objectContaining({
          p_subscription_status: subscriptionStatus,
          p_trial_days: trialDays,
        })
      )
      expect(mockActivateExactRecurringCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ session, event: checkoutEvent, expectedUserId: proUserId })
      )
      expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    }
  )

  it('re-enters atomic authority after conversion committed, the process crashed, and Stripe became terminal', async () => {
    const session = proCheckoutSession('monthly', {}, 7)
    mockRetrieveSubscription
      .mockResolvedValueOnce(proSubscription('monthly', {}, 7))
      .mockResolvedValueOnce(
        proSubscription('monthly', { status: 'canceled', canceled_at: 1_799_900_000 }, 7)
      )
    mockRpc
      .mockResolvedValueOnce({
        data: {
          status: 'converted',
          effective_subscription_status: 'trialing',
          observation: 'recorded',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          status: 'already_converted',
          effective_subscription_status: 'canceled',
          observation: 'tightened',
        },
        error: null,
      })
    mockActivateExactRecurringCheckout
      .mockRejectedValueOnce(new Error('simulated process crash after 073 conversion'))
      .mockResolvedValueOnce({ status: 'terminal_trial_recorded' })

    await expect(handleCheckoutComplete(session, checkoutEvent)).rejects.toThrow(
      'simulated process crash after 073 conversion'
    )
    await expect(handleCheckoutComplete(session, checkoutEvent)).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockActivateExactRecurringCheckout).toHaveBeenCalledTimes(2)
    expect(mockActivateExactRecurringCheckout).toHaveBeenLastCalledWith(
      expect.objectContaining({ session, event: checkoutEvent, expectedUserId: proUserId })
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
    expect(mockMintNFTForUser).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a zero-day reservation forged into a trial',
      proCheckoutSession('monthly', { payment_status: 'no_payment_required' }),
      proSubscription(
        'monthly',
        { status: 'trialing', trial_start: 1_799_000_000, trial_end: 1_799_604_800 },
        0
      ),
    ],
    [
      'a seven-day reservation forged into an immediate paid activation',
      proCheckoutSession('monthly', { payment_status: 'paid' }, 7),
      proSubscription('monthly', { status: 'active', trial_start: null, trial_end: null }, 7),
    ],
  ])('durably reviews %s before conversion', async (_label, session, subscription) => {
    mockRetrieveSubscription.mockResolvedValue(subscription)

    await expect(handleCheckoutComplete(session, checkoutEvent)).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalledWith(
      'convert_pro_membership_checkout_reservation_atomic',
      expect.anything()
    )
    expect(mockActivateExactRecurringCheckout).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ reasonKey: 'pro_checkout_completion_identity_invalid' })
    )
  })

  it.each([
    ['changed collection method', { collection_method: 'send_invoice' }],
    ['changed automatic tax', { automatic_tax: { enabled: true } }],
    ['cancel-at-period-end', { cancel_at_period_end: true }],
    ['changed product metadata', { metadata: { plan: 'changed-after-checkout' } }],
    ['changed current item', { items: { data: [], has_more: false } }],
  ])(
    'does not mistake mutable current Subscription %s for purchase identity',
    async (_label, overrides) => {
      mockRetrieveSubscription.mockResolvedValue(
        proSubscription('monthly', overrides as Partial<Stripe.Subscription>)
      )
      mockRpc.mockResolvedValue({
        data: {
          status: 'converted',
          effective_subscription_status: 'active',
          observation: 'recorded',
        },
        error: null,
      })

      await expect(
        handleCheckoutComplete(proCheckoutSession(), checkoutEvent)
      ).resolves.toBeUndefined()
      expect(mockRpc).toHaveBeenCalledWith(
        'convert_pro_membership_checkout_reservation_atomic',
        expect.objectContaining({ p_subscription_status: 'active' })
      )
      expect(mockActivateExactRecurringCheckout).toHaveBeenCalledTimes(1)
      expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    }
  )

  it('keeps exact Pro completion retryable when reservation conversion is unavailable', async () => {
    mockRetrieveSubscription.mockResolvedValue(proSubscription())
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'reservation database unavailable' },
    })

    await expect(handleCheckoutComplete(proCheckoutSession(), checkoutEvent)).rejects.toThrow(
      'Failed to convert Pro Checkout reservation: reservation database unavailable'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('keeps exact Pro completion retryable when fresh Subscription retrieval fails', async () => {
    mockRetrieveSubscription.mockRejectedValue(new Error('temporary Stripe retrieve failure'))

    await expect(handleCheckoutComplete(proCheckoutSession(), checkoutEvent)).rejects.toThrow(
      'temporary Stripe retrieve failure'
    )

    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    expect(mockActivateExactRecurringCheckout).not.toHaveBeenCalled()
  })

  it('durably reviews a deterministic reservation conversion conflict and acknowledges it', async () => {
    mockRetrieveSubscription.mockResolvedValue(proSubscription())
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '40001', message: 'reservation identity drifted' },
    })

    await expect(
      handleCheckoutComplete(proCheckoutSession(), checkoutEvent)
    ).resolves.toBeUndefined()

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ reasonKey: 'pro_checkout_completion_identity_invalid' })
    )
    expect(mockActivateExactRecurringCheckout).not.toHaveBeenCalled()
  })

  it('durably reviews a deterministic completed-Session amount mismatch', async () => {
    mockRetrieveSubscription.mockResolvedValue(proSubscription())

    await expect(
      handleCheckoutComplete(
        proCheckoutSession('monthly', { amount_total: 1, amount_subtotal: 1 }),
        checkoutEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalledWith(
      'convert_pro_membership_checkout_reservation_atomic',
      expect.anything()
    )
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ reasonKey: 'pro_checkout_completion_identity_invalid' })
    )
  })

  it.each([
    [
      'missing reservation marker',
      {
        currency: 'usd',
        userId: proUserId,
        supabase_user_id: proUserId,
        type: 'pro_membership',
        plan: 'monthly',
        pro_price_id: 'price_pro_monthly',
        trial_days: '0',
        unit_amount: '499',
      },
    ],
    [
      'changed price identity',
      {
        currency: 'usd',
        userId: proUserId,
        supabase_user_id: proUserId,
        type: 'pro_membership',
        plan: 'monthly',
        pro_membership_reservation_id: proReservationId,
        pro_price_id: 'price_attacker',
        trial_days: '0',
        unit_amount: '499',
      },
    ],
  ])('durably reviews reserved Pro completion with %s', async (label, metadata) => {
    mockRetrieveSubscription.mockResolvedValue(proSubscription())
    await expect(
      handleCheckoutComplete(proCheckoutSession('monthly', { metadata }), checkoutEvent)
    ).resolves.toBeUndefined()
    if (label === 'changed price identity') {
      expect(mockRpc).toHaveBeenCalledWith(
        'convert_pro_membership_checkout_reservation_atomic',
        expect.objectContaining({ p_stripe_price_id: 'price_attacker' })
      )
    } else {
      expect(mockRpc).not.toHaveBeenCalled()
    }
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ reasonKey: 'pro_checkout_completion_identity_invalid' })
    )
  })

  it('keeps the pre-cutover three-key signed completion path reachable', async () => {
    const legacySession = checkoutSession({
      object: 'checkout.session',
      status: 'complete',
      metadata: {
        userId: proUserId,
        supabase_user_id: proUserId,
        plan: 'monthly',
      },
    })

    await handleCheckoutComplete(legacySession, checkoutEvent)

    expect(mockRpc).not.toHaveBeenCalledWith(
      'convert_pro_membership_checkout_reservation_atomic',
      expect.anything()
    )
    expect(mockActivateExactRecurringCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUserId: proUserId, session: legacySession })
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('does not grant Pro for an unrecognized subscription price', async () => {
    mockActivateExactRecurringCheckout.mockRejectedValue(
      new Error('Cannot map Stripe price price_pro_monthly to a subscription plan')
    )

    await expect(handleCheckoutComplete(checkoutSession(), checkoutEvent)).rejects.toThrow(
      'Cannot map Stripe price price_pro_monthly to a subscription plan'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('does not trust plan metadata that disagrees with the Stripe price', async () => {
    mockActivateExactRecurringCheckout.mockRejectedValue(
      new Error('Checkout plan metadata monthly does not match Stripe price plan yearly')
    )

    await expect(handleCheckoutComplete(checkoutSession(), checkoutEvent)).rejects.toThrow(
      'Checkout plan metadata monthly does not match Stripe price plan yearly'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('never performs direct group or projection side effects after atomic activation', async () => {
    mockJoinProOfficialGroup.mockResolvedValue({
      success: false,
      message: 'group write unavailable',
    })

    await expect(handleCheckoutComplete(checkoutSession(), checkoutEvent)).resolves.toBeUndefined()
    expect(mockActivateExactRecurringCheckout).toHaveBeenCalledTimes(1)
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
    expect(mockMintNFTForUser).not.toHaveBeenCalled()
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('does not activate an unpaid API subscription', async () => {
    await handleCheckoutComplete(
      apiCheckoutSession('pro', {
        payment_status: 'unpaid',
      }),
      checkoutEvent
    )

    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockApplyApiTierStripeEvent).not.toHaveBeenCalled()
  })

  it('activates a paid API subscription with exact Checkout and event identity', async () => {
    const subscription = apiSubscription('pro')
    mockRetrieveSubscription.mockResolvedValue(subscription)
    mockFrom.mockReturnValue(apiOwnerQuery())

    await handleCheckoutComplete(apiCheckoutSession('pro'), checkoutEvent)

    expect(mockApplyApiTierStripeEvent).toHaveBeenCalledWith({
      authority: {
        userId: apiUserId,
        metadataUserId: apiUserId,
        metadataSupabaseUserId: apiUserId,
        stripeCustomerId: 'cus_test_123',
        checkoutReservationId: apiReservationId,
        stripePriceId: 'price_api_pro',
        plan: 'pro',
      },
      plan: 'pro',
      dailyLimit: 0,
      subscription,
      event: checkoutEvent,
      isActive: true,
      isTerminal: false,
    })
  })

  it('lets an exact paid API Checkout reach atomic authority after its profile was hard-deleted', async () => {
    const subscription = apiSubscription('pro')
    mockRetrieveSubscription.mockResolvedValue(subscription)
    mockFrom.mockReturnValue(apiOwnerQuery(null))

    await expect(
      handleCheckoutComplete(apiCheckoutSession('pro'), checkoutEvent)
    ).resolves.toBeUndefined()

    expect(mockApplyApiTierStripeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: expect.objectContaining({
          userId: apiUserId,
          stripeCustomerId: 'cus_test_123',
          checkoutReservationId: apiReservationId,
        }),
        subscription,
        event: checkoutEvent,
        isActive: true,
        isTerminal: false,
      })
    )
  })

  it.each([
    [
      'mismatched user aliases',
      {
        metadata: {
          userId: apiUserId,
          supabase_user_id: lifetimeUserId,
          type: 'api_tier',
          api_plan: 'pro',
          api_tier_reservation_id: apiReservationId,
        },
      },
    ],
    [
      'malformed reservation',
      {
        metadata: {
          userId: apiUserId,
          supabase_user_id: apiUserId,
          type: 'api_tier',
          api_plan: 'pro',
          api_tier_reservation_id: 'not-a-uuid',
        },
      },
    ],
    ['reservation/client-reference drift', { client_reference_id: lifetimeReservationId }],
  ])('rejects a paid API Checkout with %s', async (_case, overrides) => {
    await expect(
      handleCheckoutComplete(apiCheckoutSession('pro', overrides), checkoutEvent)
    ).rejects.toThrow('API checkout cs_test_123 has invalid exact entitlement identity')
    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockApplyApiTierStripeEvent).not.toHaveBeenCalled()
  })

  it.each([
    [
      'non-unit item quantity',
      apiSubscription('pro', {
        items: {
          data: [{ quantity: 2, price: { id: 'price_api_pro' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
    ],
    [
      'unknown price',
      apiSubscription('pro', {
        items: {
          data: [{ quantity: 1, price: { id: 'price_api_unknown' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
    ],
  ])('rejects API subscription authority with %s', async (_case, subscription) => {
    mockRetrieveSubscription.mockResolvedValue(subscription)
    mockFrom.mockReturnValue(apiOwnerQuery())

    await expect(handleCheckoutComplete(apiCheckoutSession('pro'), checkoutEvent)).rejects.toThrow(
      'API subscription sub_test_123 has invalid exact entitlement identity'
    )
    expect(mockApplyApiTierStripeEvent).not.toHaveBeenCalled()
  })

  it('rejects an API subscription Customer that does not match its owner profile', async () => {
    mockRetrieveSubscription.mockResolvedValue(apiSubscription('pro', { customer: 'cus_attacker' }))
    mockFrom.mockReturnValue(apiOwnerQuery())

    await expect(handleCheckoutComplete(apiCheckoutSession('pro'), checkoutEvent)).rejects.toThrow(
      'API subscription sub_test_123 customer ownership does not match'
    )
    expect(mockApplyApiTierStripeEvent).not.toHaveBeenCalled()
  })

  it('rejects an API Checkout whose signed mode disagrees with its snapshot', async () => {
    await expect(
      handleCheckoutComplete(
        apiCheckoutSession('starter', {
          livemode: false,
        }),
        checkoutEvent
      )
    ).rejects.toThrow('API checkout cs_test_123 has invalid exact entitlement identity')

    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockApplyApiTierStripeEvent).not.toHaveBeenCalled()
  })

  it('rejects an API subscription whose metadata disagrees with its Checkout', async () => {
    mockRetrieveSubscription.mockResolvedValue(
      apiSubscription('starter', {
        metadata: {
          userId: apiUserId,
          supabase_user_id: apiUserId,
          type: 'api_tier',
          api_plan: 'starter',
          api_tier_reservation_id: '71e34ce2-43c1-4bcc-8f19-79b36d56605c',
        },
      })
    )
    mockFrom.mockReturnValue(apiOwnerQuery())

    await expect(handleCheckoutComplete(apiCheckoutSession('pro'), checkoutEvent)).rejects.toThrow(
      'API subscription sub_test_123 identity does not match its checkout'
    )
    expect(mockApplyApiTierStripeEvent).not.toHaveBeenCalled()
  })

  it('does not grant lifetime access before the one-time payment is paid', async () => {
    await handleCheckoutComplete(
      checkoutSession({
        mode: 'payment',
        payment_status: 'unpaid',
        subscription: null,
        metadata: { userId: 'user-123', plan: 'lifetime' },
      })
    )

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('durably reviews and acknowledges an unsupported paid one-time checkout', async () => {
    await expect(
      handleCheckoutComplete(
        checkoutSession({
          mode: 'payment',
          payment_status: 'paid',
          subscription: null,
          metadata: { userId: 'not-a-uuid', plan: 'unknown' },
        })
      )
    ).resolves.toBeUndefined()

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cs_test_123',
        userId: null,
        reasonKey: 'paid_checkout_product_unsupported',
      })
    )
  })

  it('activates a paid lifetime membership through one atomic RPC', async () => {
    const session = paidLifetimeSession()

    await handleCheckoutComplete(session)

    expect(mockActivateLifetimeCheckoutEntitlement).toHaveBeenCalledWith({
      stripe: mockGetStripeClient,
      supabase: expect.anything(),
      session,
      expectedUserId: lifetimeUserId,
    })
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
    expect(mockMintNFTForUser).not.toHaveBeenCalled()
    expect(mockSendAlert).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('acknowledges a durable non-grant lifetime terminal state without direct side effects', async () => {
    mockActivateLifetimeCheckoutEntitlement.mockResolvedValue({
      status: 'reservation_refund_queued',
    })

    await expect(handleCheckoutComplete(paidLifetimeSession())).resolves.toBeUndefined()
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing alias',
      {
        supabase_user_id: '',
      },
    ],
    [
      'invalid alias',
      {
        userId: 'not-a-uuid',
      },
    ],
    [
      'conflicting aliases',
      {
        supabase_user_id: 'd77f7404-6045-48be-a78e-49a0e18f9db2',
      },
    ],
  ])(
    'durably reviews and acknowledges paid lifetime metadata with a %s',
    async (_label, metadata) => {
      await expect(handleCheckoutComplete(paidLifetimeSession(metadata))).resolves.toBeUndefined()

      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'cs_test_123',
          userId: null,
          reasonKey: 'lifetime_checkout_metadata_invalid',
        })
      )
      expect(mockActivateLifetimeCheckoutEntitlement).not.toHaveBeenCalled()
    }
  )

  it('keeps malformed paid lifetime completion retryable until manual review is durable', async () => {
    mockRecordStripeCheckoutManualReview.mockRejectedValue(
      new Error('manual review persistence unavailable')
    )

    await expect(
      handleCheckoutComplete(paidLifetimeSession({ userId: 'not-a-uuid' }))
    ).rejects.toThrow('manual review persistence unavailable')
    expect(mockActivateLifetimeCheckoutEntitlement).not.toHaveBeenCalled()
  })

  it.each([
    [
      'corrupted plan carried by the reservation marker',
      {
        plan: 'monthly',
      },
    ],
    [
      'invalid reservation id',
      {
        lifetime_reservation_id: 'not-a-uuid',
      },
    ],
    [
      'invalid reservation nonce',
      {
        lifetime_reservation_nonce: 'bad nonce',
      },
    ],
  ])(
    'durably reviews and acknowledges a paid lifetime Session with %s',
    async (_label, metadata) => {
      await expect(handleCheckoutComplete(paidLifetimeSession(metadata))).resolves.toBeUndefined()

      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'cs_test_123',
          userId: lifetimeUserId,
          reasonKey: 'lifetime_checkout_metadata_invalid',
        })
      )
      expect(mockActivateLifetimeCheckoutEntitlement).not.toHaveBeenCalled()
    }
  )
})

describe('handleCheckoutExpired Pro membership reservation release', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: { status: 'released' }, error: null })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
  })

  it('releases only the exact reservation from signed Session and event identity', async () => {
    await handleCheckoutExpired(expiredProSession(), expiredEvent)

    expect(mockRpc).toHaveBeenCalledWith('release_pro_membership_checkout_reservation_atomic', {
      p_reservation_id: proReservationId,
      p_user_id: proUserId,
      p_livemode: true,
      p_stripe_customer_id: 'cus_test_123',
      p_pro_plan: 'monthly',
      p_stripe_price_id: 'price_pro_monthly',
      p_unit_amount: 499,
      p_currency: 'usd',
      p_trial_days: 0,
      p_checkout_session_id: 'cs_test_123',
      p_checkout_expires_at: 1_790_000_000,
      p_stripe_event_id: 'evt_expired_123',
      p_stripe_event_created: 1_800_000_000,
    })
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('accepts an idempotent signed Pro expiration replay', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'already_released' }, error: null })

    await expect(handleCheckoutExpired(expiredProSession(), expiredEvent)).resolves.toBeUndefined()
  })

  it.each([
    ['missing reservation', { pro_membership_reservation_id: '' }, {}],
    ['changed Price', { pro_price_id: 'not-a-price' }, {}],
    ['wrong client reference', {}, { client_reference_id: apiReservationId }],
    ['unexpected subscription', {}, { subscription: 'sub_attacker' }],
  ])(
    'durably reviews %s without releasing or recording generic abandonment',
    async (_label, metadata, sessionOverrides) => {
      await handleCheckoutExpired(
        expiredProSession(metadata, sessionOverrides as Partial<Stripe.Checkout.Session>),
        expiredEvent
      )

      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({ reasonKey: 'pro_checkout_expiry_identity_invalid' })
      )
    }
  )

  it('throws so Stripe retries when exact signed release is unavailable', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    await expect(handleCheckoutExpired(expiredProSession(), expiredEvent)).rejects.toThrow(
      'Failed to release expired Pro Checkout reservation: database unavailable'
    )
  })

  it('fails closed on an unknown signed release result', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'identity_conflict' }, error: null })

    await expect(handleCheckoutExpired(expiredProSession(), expiredEvent)).rejects.toThrow(
      'Pro Checkout reservation release returned unexpected status identity_conflict'
    )
  })
})

describe('handleCheckoutExpired API tier reservation release', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockFrom.mockReturnValue(apiOwnerQuery())
    mockRpc.mockResolvedValue({ data: { status: 'released' }, error: null })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
  })

  it('releases the exact API reservation from signed Session and event identity', async () => {
    await handleCheckoutExpired(expiredApiSession(), expiredEvent)

    expect(mockRpc).toHaveBeenCalledWith('release_api_tier_checkout_reservation_atomic', {
      p_reservation_id: apiReservationId,
      p_user_id: apiUserId,
      p_livemode: true,
      p_stripe_customer_id: 'cus_test_123',
      p_checkout_session_id: 'cs_test_123',
      p_stripe_event_id: 'evt_expired_123',
      p_stripe_event_created: 1_800_000_000,
    })
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('releases an exact Session that the server manually expired before expires_at', async () => {
    await handleCheckoutExpired(
      expiredApiSession({}, { expires_at: expiredEvent.created + 600 }),
      expiredEvent
    )

    expect(mockRpc).toHaveBeenCalledWith(
      'release_api_tier_checkout_reservation_atomic',
      expect.objectContaining({
        p_reservation_id: apiReservationId,
        p_checkout_session_id: 'cs_test_123',
        p_stripe_event_id: 'evt_expired_123',
        p_stripe_event_created: expiredEvent.created,
      })
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('accepts an idempotent already-released reservation result', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'already_released' }, error: null })

    await expect(handleCheckoutExpired(expiredApiSession(), expiredEvent)).resolves.toBeUndefined()
  })

  it.each([
    ['mismatched aliases', { supabase_user_id: lifetimeUserId }, {}],
    ['malformed reservation', { api_tier_reservation_id: 'not-a-uuid' }, {}],
    ['wrong client reference', {}, { client_reference_id: lifetimeReservationId }],
    ['subscription unexpectedly present', {}, { subscription: 'sub_wrong' }],
  ])(
    'records %s for durable review and never reports generic abandonment',
    async (_case, metadata, sessionOverrides) => {
      await handleCheckoutExpired(
        expiredApiSession(metadata, sessionOverrides as Partial<Stripe.Checkout.Session>),
        expiredEvent
      )

      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonKey: 'api_tier_expiry_identity_invalid',
        })
      )
    }
  )

  it('records a persisted Stripe Customer mismatch without releasing another reservation', async () => {
    mockFrom.mockReturnValue(
      apiOwnerQuery({
        id: apiUserId,
        stripe_customer_id: 'cus_other',
      })
    )

    await handleCheckoutExpired(expiredApiSession(), expiredEvent)

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'api_tier_expiry_customer_mismatch',
      })
    )
  })

  it('throws so Stripe retries when the exact reservation release fails', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'reservation database unavailable' },
    })

    await expect(handleCheckoutExpired(expiredApiSession(), expiredEvent)).rejects.toThrow(
      'Failed to release expired API tier reservation: reservation database unavailable'
    )
  })

  it('fails closed on an unknown reservation release result', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'identity_conflict' }, error: null })

    await expect(handleCheckoutExpired(expiredApiSession(), expiredEvent)).rejects.toThrow(
      'API tier checkout reservation release returned unexpected status identity_conflict'
    )
  })
})

describe('handleCheckoutExpired Tip lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: { status: 'expired' }, error: null })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
  })

  it('uses exact signed Session identity to expire the pending Tip before generic abandonment', async () => {
    await handleCheckoutExpired(expiredTipSession(), expiredEvent)

    expect(mockRpc).toHaveBeenCalledWith('expire_pending_tip_checkout_atomic', {
      p_tip_id: tipCheckoutId,
      p_from_user_id: lifetimeUserId,
      p_post_id: tipPostId,
      p_to_user_id: tipRecipientId,
      p_amount_cents: 500,
      p_checkout_session_id: 'cs_tip_expired_123',
      p_checkout_expires_at: new Date(tipCheckoutExpiresAt * 1000).toISOString(),
      p_event_id: 'evt_expired_123',
      p_event_created_at: '2027-01-15T08:00:00.000Z',
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each(['already_expired', 'identity_conflict', 'already_terminal', 'not_found'])(
    'acknowledges durable Tip expiry status %s because the DB records conflicts',
    async (status) => {
      mockRpc.mockResolvedValue({ data: { status }, error: null })

      await expect(
        handleCheckoutExpired(expiredTipSession(), expiredEvent)
      ).resolves.toBeUndefined()

      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['metadata user conflict', { user_id: tipRecipientId }, {}],
    ['invalid amount', { amount_cents: '500.5' }, {}],
    ['snapshot drift', { post_id: 'not-a-uuid' }, {}],
    ['uppercase UUID', { tip_id: tipCheckoutId.toUpperCase() }, {}],
    ['whitespace-padded UUID', { tip_id: ` ${tipCheckoutId}` }, {}],
    ['client reference drift', {}, { client_reference_id: tipPostId }],
  ])('records %s durably and never falls through to analytics', async (_, metadataDrift, drift) => {
    await expect(
      handleCheckoutExpired(expiredTipSession(metadataDrift, drift), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cs_tip_expired_123',
        reasonKey: 'tip_checkout_expiry_metadata_invalid',
      })
    )
  })

  it.each([
    ['test-mode Session', expiredTipSession({}, { livemode: false }), expiredEvent],
    ['test-mode event', expiredTipSession(), { ...expiredEvent, livemode: false }],
    ['wrong Session mode', expiredTipSession({}, { mode: 'subscription' }), expiredEvent],
    ['wrong Session status', expiredTipSession({}, { status: 'open' }), expiredEvent],
    ['paid Session', expiredTipSession({}, { payment_status: 'paid' }), expiredEvent],
    ['subscription Session', expiredTipSession({}, { subscription: 'sub_wrong' }), expiredEvent],
  ])('durably reviews a %s and never expires the Tip', async (_, session, event) => {
    await expect(handleCheckoutExpired(session, event)).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cs_tip_expired_123',
        reasonKey: 'tip_checkout_expiry_metadata_invalid',
        context: expect.objectContaining({
          event_livemode: event.livemode,
          session_livemode: session.livemode,
        }),
      })
    )
  })

  it('throws so Stripe retries when the signed Tip expiry DB transition fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    await expect(handleCheckoutExpired(expiredTipSession(), expiredEvent)).rejects.toThrow(
      'Failed to expire pending Tip checkout: database unavailable'
    )
  })

  it('fails closed on an unknown Tip expiry result', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'unexpected' }, error: null })

    await expect(handleCheckoutExpired(expiredTipSession(), expiredEvent)).rejects.toThrow(
      'Tip checkout expiry returned unexpected status unexpected'
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })
})

describe('handleCheckoutExpired lifetime reservation release', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: { status: 'released' }, error: null })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
    mockFrom.mockReturnValue({
      insert: () => Promise.resolve({ error: null }),
    })
  })

  it('releases a bound lifetime seat from exact signed early-expiry identity', async () => {
    await handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)

    expect(mockRpc).toHaveBeenCalledWith('release_lifetime_membership_reservation_atomic', {
      p_user_id: lifetimeUserId,
      p_reservation_id: lifetimeReservationId,
      p_request_nonce: lifetimeRequestNonce,
      p_checkout_session_id: 'cs_test_123',
      p_release_reason: 'stripe_checkout_session_expired',
      p_event_id: 'evt_expired_123',
      p_event_created_at: '2027-01-15T08:00:00.000Z',
    })
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each(['already_released', 'already_expired'])(
    'acknowledges the idempotent %s release state',
    async (status) => {
      mockRpc.mockResolvedValue({ data: { status }, error: null })

      await expect(
        handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
      ).resolves.toBeUndefined()

      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    }
  )

  it('records malformed lifetime expiry metadata for review and acknowledges it', async () => {
    await expect(
      handleCheckoutExpired(
        expiredLifetimeSession({ lifetime_reservation_id: 'not-a-uuid' }),
        expiredEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cs_test_123',
        userId: lifetimeUserId,
        reasonKey: 'lifetime_expiry_metadata_invalid',
      })
    )
  })

  it('records a partial lifetime identity even when its plan marker is corrupted', async () => {
    await expect(
      handleCheckoutExpired(expiredLifetimeSession({ plan: 'monthly' }), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'lifetime_expiry_metadata_invalid',
        context: expect.objectContaining({ plan: 'monthly' }),
      })
    )
  })

  it('does not attribute an invalid expiry review from only one canonical user alias', async () => {
    await expect(
      handleCheckoutExpired(
        expiredLifetimeSession({ supabase_user_id: 'not-a-uuid' }),
        expiredEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        reasonKey: 'lifetime_expiry_metadata_invalid',
      })
    )
  })

  it('reviews an empty lifetime reservation marker even when the plan marker is corrupted', async () => {
    await expect(
      handleCheckoutExpired(
        expiredLifetimeSession({
          plan: 'monthly',
          lifetime_reservation_id: '',
          lifetime_reservation_nonce: '',
        }),
        expiredEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'lifetime_expiry_metadata_invalid',
      })
    )
  })

  it('uses signed expiry to release the reserved seat preserved by route-side expiration', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'released' }, error: null })

    await expect(
      handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenNthCalledWith(2, 'release_lifetime_membership_reservation_atomic', {
      p_user_id: lifetimeUserId,
      p_reservation_id: lifetimeReservationId,
      p_request_nonce: lifetimeRequestNonce,
      p_checkout_session_id: null,
      p_release_reason: 'stripe_checkout_abandoned',
      p_event_id: null,
      p_event_created_at: null,
    })
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('retries exact signed release after a reserved-to-bound remediation race', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'released' }, error: null })

    await expect(
      handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenNthCalledWith(3, 'release_lifetime_membership_reservation_atomic', {
      p_user_id: lifetimeUserId,
      p_reservation_id: lifetimeReservationId,
      p_request_nonce: lifetimeRequestNonce,
      p_checkout_session_id: 'cs_test_123',
      p_release_reason: 'stripe_checkout_session_expired',
      p_event_id: 'evt_expired_123',
      p_event_created_at: '2027-01-15T08:00:00.000Z',
    })
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each(['not_found', 'identity_conflict', 'already_converted'])(
    'records the terminal %s release conflict for durable review and acknowledges it',
    async (status) => {
      mockRpc.mockResolvedValue({ data: { status }, error: null })

      await expect(
        handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
      ).resolves.toBeUndefined()

      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'cs_test_123',
          userId: lifetimeUserId,
          reasonKey: 'lifetime_expiry_release_conflict',
          context: expect.objectContaining({
            release_status: status,
            remediation_status: null,
          }),
        })
      )
    }
  )

  it('records a remaining release_not_verified result after remediation', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })

    await expect(
      handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'lifetime_expiry_release_conflict',
        context: expect.objectContaining({
          release_status: 'release_not_verified',
          remediation_status: 'release_not_verified',
          retry_exact_status: 'release_not_verified',
        }),
      })
    )
  })

  it('throws when the abandoned-release remediation database write fails', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'remediation database unavailable' },
      })

    await expect(handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)).rejects.toThrow(
      'Failed to remediate an unbound expired lifetime reservation: remediation database unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('throws when the post-race exact release retry database write fails', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'exact retry database unavailable' },
      })

    await expect(handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)).rejects.toThrow(
      'Failed to retry exact expired lifetime reservation release: exact retry database unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('throws when the exact release database write fails', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'reservation database unavailable' },
    })

    await expect(handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)).rejects.toThrow(
      'Failed to release expired lifetime reservation: reservation database unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('throws when the exact release network call fails', async () => {
    mockRpc.mockRejectedValue(new Error('reservation network unavailable'))

    await expect(handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)).rejects.toThrow(
      'reservation network unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('throws when malformed metadata cannot be durably recorded for review', async () => {
    mockRecordStripeCheckoutManualReview.mockRejectedValue(
      new Error('manual review database unavailable')
    )

    await expect(
      handleCheckoutExpired(
        expiredLifetimeSession({ lifetime_reservation_nonce: 'bad nonce' }),
        expiredEvent
      )
    ).rejects.toThrow('manual review database unavailable')
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('handleTipPaymentCompleted persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockCompleteTipCheckout.mockResolvedValue({ status: 'completed' })
  })

  it('passes only the signed snapshot session id into fresh tip completion', async () => {
    const untrustedSnapshot = checkoutSession({
      mode: 'payment',
      subscription: null,
      customer: 'cus_untrusted',
      payment_intent: 'pi_untrusted',
      metadata: {
        type: 'tip',
        tip_id: 'untrusted-tip-id',
        from_user_id: 'untrusted-user-id',
        amount_cents: '999999',
      },
    })

    await expect(handleTipPaymentCompleted(untrustedSnapshot, tipEvent)).resolves.toEqual({
      status: 'completed',
    })

    expect(mockCompleteTipCheckout).toHaveBeenCalledWith({
      stripe: mockGetStripeClient,
      supabase: { rpc: mockRpc },
      sessionId: 'cs_test_123',
      eventId: 'evt_tip_123',
      eventLivemode: true,
      snapshotLivemode: true,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps technical completion failures retryable', async () => {
    mockCompleteTipCheckout.mockRejectedValue(new Error('tip authority unavailable'))

    await expect(handleTipPaymentCompleted(checkoutSession(), tipEvent)).rejects.toThrow(
      'tip authority unavailable'
    )
  })

  it('contains no direct tip-table or notification side effect', () => {
    const source = require('node:fs').readFileSync(require.resolve('../checkout'), 'utf8')
    const start = source.indexOf('export async function handleTipPaymentCompleted')
    const end = source.indexOf('export async function handleCheckoutExpired', start)
    const handler = source.slice(start, end)

    expect(handler).not.toMatch(/\.from\(['"]tips['"]\)/)
    expect(handler).not.toContain('sendNotification')
  })
})
