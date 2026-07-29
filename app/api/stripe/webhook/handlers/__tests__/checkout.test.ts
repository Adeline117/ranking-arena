const mockRetrieveSubscription = jest.fn()
const mockCancelSubscription = jest.fn()
const mockRetrieveCheckoutSession = jest.fn()
const mockListCheckoutLineItems = jest.fn()
const mockGetStripeClient = {
  checkout: {
    sessions: {
      retrieve: (...args: unknown[]) => mockRetrieveCheckoutSession(...args),
      listLineItems: (...args: unknown[]) => mockListCheckoutLineItems(...args),
    },
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
    metadata: { userId: 'user-123', plan: 'monthly' },
    ...overrides,
  } as Stripe.Checkout.Session
}

const lifetimeUserId = '21e34ce2-43c1-4bcc-8f19-79b36d56605c'
const apiUserId = '11e34ce2-43c1-4bcc-8f19-79b36d56605c'
const apiReservationId = '81e34ce2-43c1-4bcc-8f19-79b36d56605c'
const lifetimeReservationId = '9a8df3e8-e908-4f27-9cb4-8b892d748cc7'
const lifetimeRequestNonce = `lifetime:${lifetimeUserId}:123`
const expiredEvent = { id: 'evt_expired_123', created: 1_800_000_000, livemode: true }
const tipEvent = { id: 'evt_tip_123', created: 1_800_000_000, livemode: true }
const checkoutEvent = { id: 'evt_checkout_123', created: 1_800_000_000, livemode: true }
const recurringProUserId = '61e34ce2-43c1-4bcc-8f19-79b36d56605c'
const recurringProReservationId = '71e34ce2-43c1-4bcc-8f19-79b36d56605c'
const recurringProOperationId = '91e34ce2-43c1-4bcc-8f19-79b36d56605c'
const recurringProNonce = 'a1e34ce2-43c1-4bcc-8f19-79b36d56605c'
const recurringProCheckoutExpiresAt = 1_900_000_000
const tipCheckoutId = '31e34ce2-43c1-4bcc-8f19-79b36d56605c'
const tipPostId = '41e34ce2-43c1-4bcc-8f19-79b36d56605c'
const tipRecipientId = '51e34ce2-43c1-4bcc-8f19-79b36d56605c'
const tipCheckoutExpiresAt = 1_900_000_000

function recurringProMetadata(
  trialRequested = false,
  overrides: Record<string, string> = {}
): Stripe.Metadata {
  return {
    plan: 'monthly',
    pro_checkout_nonce: recurringProNonce,
    pro_checkout_operation_id: recurringProOperationId,
    pro_checkout_reservation_id: recurringProReservationId,
    stripe_customer_id: 'cus_test_123',
    stripe_price_id: 'price_pro_monthly',
    supabase_user_id: recurringProUserId,
    trial_requested: trialRequested ? 'true' : 'false',
    type: 'pro_subscription',
    userId: recurringProUserId,
    ...overrides,
  }
}

function recurringProCheckoutSession(
  trialRequested = false,
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  const amount = trialRequested ? 0 : 499
  return checkoutSession({
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    payment_status: trialRequested ? 'no_payment_required' : 'paid',
    livemode: true,
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    metadata: recurringProMetadata(trialRequested),
    client_reference_id: recurringProReservationId,
    expires_at: recurringProCheckoutExpiresAt,
    currency: 'usd',
    amount_subtotal: amount,
    amount_total: amount,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    discounts: [],
    allow_promotion_codes: false,
    automatic_tax: { enabled: false },
    adaptive_pricing: { enabled: false },
    after_expiration: null,
    recovered_from: null,
    url: null,
    ...overrides,
  })
}

function expiredRecurringProCheckoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return checkoutSession({
    object: 'checkout.session',
    mode: 'subscription',
    status: 'expired',
    payment_status: 'unpaid',
    livemode: true,
    customer: 'cus_test_123',
    subscription: null,
    metadata: recurringProMetadata(false),
    client_reference_id: recurringProReservationId,
    expires_at: recurringProCheckoutExpiresAt,
    ...overrides,
  })
}

function recurringProLine(trialRequested = false): Stripe.LineItem {
  const amount = trialRequested ? 0 : 499
  return {
    id: 'li_recurring_123',
    object: 'item',
    quantity: 1,
    currency: 'usd',
    amount_subtotal: amount,
    amount_total: amount,
    amount_discount: 0,
    amount_tax: 0,
    discounts: [],
    taxes: [],
    price: {
      id: 'price_pro_monthly',
      type: 'recurring',
      currency: 'usd',
      unit_amount: 499,
      recurring: { interval: 'month', interval_count: 1 },
    },
  } as Stripe.LineItem
}

function recurringProSubscription(
  trialRequested = false,
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return {
    id: 'sub_test_123',
    object: 'subscription',
    status: trialRequested ? 'trialing' : 'active',
    created: 1_700_000_000,
    livemode: true,
    customer: 'cus_test_123',
    metadata: recurringProMetadata(trialRequested),
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
    trial_start: trialRequested ? 1_800_000_000 : null,
    trial_end: trialRequested ? 1_800_604_800 : null,
    current_period_start: 1_800_000_000,
    current_period_end: 1_800_604_800,
    items: {
      data: [
        {
          id: 'si_recurring_123',
          object: 'subscription_item',
          quantity: 1,
          subscription: 'sub_test_123',
          current_period_start: 1_800_000_000,
          current_period_end: 1_800_604_800,
          discounts: [],
          tax_rates: [],
          price: {
            id: 'price_pro_monthly',
            type: 'recurring',
            currency: 'usd',
            unit_amount: 499,
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
      has_more: false,
    },
    ...overrides,
  } as Stripe.Subscription
}

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
    mockRetrieveSubscription.mockResolvedValue(recurringProSubscription())
    mockRetrieveCheckoutSession.mockResolvedValue(recurringProCheckoutSession())
    mockListCheckoutLineItems.mockResolvedValue({
      data: [recurringProLine()],
      has_more: false,
    })
    mockUpdateUserSubscription.mockResolvedValue(undefined)
    mockApplyApiTierStripeEvent.mockResolvedValue(undefined)
    mockGetProPlanFromPriceId.mockReturnValue('monthly')
    mockJoinProOfficialGroup.mockResolvedValue({ success: true, groupId: 'pro-group' })
    mockMintNFTForUser.mockResolvedValue(undefined)
    mockSendAlert.mockResolvedValue(undefined)
    mockActivateLifetimeCheckoutEntitlement.mockResolvedValue({ status: 'activated' })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
    mockRpc.mockImplementation((name: string) => {
      if (name === 'complete_recurring_pro_checkout_atomic') {
        return Promise.resolve({ data: 'completed', error: null, status: 200 })
      }
      if (name === 'activate_recurring_trial_entitlement_atomic') {
        return Promise.resolve({ data: 'activated', error: null, status: 200 })
      }
      return Promise.resolve({ data: null, error: null, status: 200 })
    })
  })

  it('rejects legacy paid Pro metadata, records review, and performs no external mutation', async () => {
    await expect(
      handleCheckoutComplete(
        checkoutSession({ metadata: { userId: 'user-123', plan: 'monthly' } }),
        checkoutEvent
      )
    ).rejects.toThrow('failed exact signed identity')

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'recurring_checkout_completion_identity_invalid',
      })
    )
    expect(mockRetrieveCheckoutSession).not.toHaveBeenCalled()
    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
    expect(mockMintNFTForUser).not.toHaveBeenCalled()
  })

  it('requires the signed event before reading Stripe or mutating durable state', async () => {
    await expect(handleCheckoutComplete(recurringProCheckoutSession())).rejects.toThrow(
      'missing signed event identity'
    )
    expect(mockRetrieveCheckoutSession).not.toHaveBeenCalled()
    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('completes an exact paid reservation without directly activating or canceling anything', async () => {
    await expect(
      handleCheckoutComplete(recurringProCheckoutSession(), checkoutEvent)
    ).resolves.toBeUndefined()

    expect(mockRetrieveCheckoutSession).toHaveBeenCalledWith('cs_test_123', {
      expand: ['line_items.data.price'],
    })
    expect(mockListCheckoutLineItems).toHaveBeenCalledWith('cs_test_123', { limit: 100 })
    expect(mockRetrieveSubscription).toHaveBeenCalledWith('sub_test_123')
    expect(mockRpc).toHaveBeenCalledWith('complete_recurring_pro_checkout_atomic', {
      p_user_id: recurringProUserId,
      p_livemode: true,
      p_stripe_customer_id: 'cus_test_123',
      p_stripe_subscription_id: 'sub_test_123',
      p_reservation_id: recurringProReservationId,
      p_operation_id: recurringProOperationId,
      p_reservation_nonce: recurringProNonce,
      p_plan: 'monthly',
      p_stripe_price_id: 'price_pro_monthly',
      p_trial_requested: false,
      p_checkout_session_id: 'cs_test_123',
      p_stripe_event_id: checkoutEvent.id,
      p_stripe_event_created: checkoutEvent.created,
    })
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
    expect(mockMintNFTForUser).not.toHaveBeenCalled()
    expect(mockSendAlert).not.toHaveBeenCalled()
  })

  it('keeps identity conflicts retryable and never cancels the payable subscription', async () => {
    mockRpc.mockResolvedValue({
      data: 'identity_conflict',
      error: null,
      status: 200,
    })

    await expect(
      handleCheckoutComplete(recurringProCheckoutSession(), checkoutEvent)
    ).rejects.toThrow('completion returned identity_conflict')

    expect(mockCancelSubscription).not.toHaveBeenCalled()
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
  })

  it('activates only the exact completed no-payment trial through the atomic trial authority', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(recurringProCheckoutSession(true))
    mockListCheckoutLineItems.mockResolvedValue({
      data: [recurringProLine(true)],
      has_more: false,
    })
    mockRetrieveSubscription.mockResolvedValue(recurringProSubscription(true))

    await expect(
      handleCheckoutComplete(recurringProCheckoutSession(true), checkoutEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenNthCalledWith(
      1,
      'complete_recurring_pro_checkout_atomic',
      expect.objectContaining({
        p_reservation_id: recurringProReservationId,
        p_trial_requested: true,
      })
    )
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'activate_recurring_trial_entitlement_atomic', {
      p_user_id: recurringProUserId,
      p_stripe_customer_id: 'cus_test_123',
      p_stripe_subscription_id: 'sub_test_123',
      p_plan: 'monthly',
      p_livemode: true,
      p_period_start: '2027-01-15T08:00:00.000Z',
      p_period_end: '2027-01-22T08:00:00.000Z',
      p_stripe_subscription_status: 'trialing',
    })
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
  })

  it('records fresh Stripe verification drift and performs no reservation transition', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(
      recurringProCheckoutSession(false, {
        total_details: { amount_discount: 1, amount_shipping: 0, amount_tax: 0 },
      })
    )

    await expect(
      handleCheckoutComplete(recurringProCheckoutSession(), checkoutEvent)
    ).rejects.toThrow('failed exact verification')

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'recurring_checkout_completion_verification_failed',
      })
    )
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('rethrows fresh Stripe lookup failures so the signed event remains retryable', async () => {
    mockRetrieveSubscription.mockRejectedValue(new Error('temporary Stripe outage'))

    await expect(
      handleCheckoutComplete(recurringProCheckoutSession(), checkoutEvent)
    ).rejects.toThrow('temporary Stripe outage')
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('rejects an exact metadata envelope when the subscription identity is absent', async () => {
    await expect(
      handleCheckoutComplete(
        recurringProCheckoutSession(false, { subscription: null }),
        checkoutEvent
      )
    ).rejects.toThrow('failed exact signed identity')

    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
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

  it('keeps completion DB failures retryable after exact Stripe verification', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'complete_recurring_pro_checkout_atomic') {
        return Promise.resolve({
          data: null,
          error: { message: 'temporary completion database failure' },
          status: 503,
        })
      }
      return Promise.resolve({ data: null, error: null, status: 200 })
    })

    await expect(
      handleCheckoutComplete(recurringProCheckoutSession(), checkoutEvent)
    ).rejects.toThrow(
      'Failed to complete recurring Pro Checkout: temporary completion database failure'
    )
    expect(mockCancelSubscription).not.toHaveBeenCalled()
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
      expectedLivemode: true,
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

describe('handleCheckoutExpired recurring Pro reservation release', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
    mockRpc.mockResolvedValue({ data: 'released', error: null, status: 200 })
  })

  it('releases only the exact bound reservation from the signed expired event', async () => {
    await expect(
      handleCheckoutExpired(expiredRecurringProCheckoutSession(), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith('release_recurring_pro_checkout_atomic', {
      p_user_id: recurringProUserId,
      p_livemode: true,
      p_stripe_customer_id: 'cus_test_123',
      p_reservation_id: recurringProReservationId,
      p_operation_id: recurringProOperationId,
      p_reservation_nonce: recurringProNonce,
      p_plan: 'monthly',
      p_stripe_price_id: 'price_pro_monthly',
      p_trial_requested: false,
      p_checkout_session_id: 'cs_test_123',
      p_stripe_event_id: expiredEvent.id,
      p_stripe_event_created: expiredEvent.created,
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each(['already_released', 'already_completed'])(
    'acknowledges the exact idempotent %s terminal state',
    async (status) => {
      mockRpc.mockResolvedValue({ data: status, error: null, status: 200 })

      await expect(
        handleCheckoutExpired(expiredRecurringProCheckoutSession(), expiredEvent)
      ).resolves.toBeUndefined()
    }
  )

  it('durably reviews signed expiry identity drift and throws for Stripe retry', async () => {
    await expect(
      handleCheckoutExpired(
        expiredRecurringProCheckoutSession({ customer: 'cus_wrong' }),
        expiredEvent
      )
    ).rejects.toThrow('expiry identity is invalid')

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: recurringProUserId,
        reasonKey: 'recurring_checkout_expiry_identity_invalid',
      })
    )
  })

  it('throws on a durable identity conflict and never reports generic abandonment', async () => {
    mockRpc.mockResolvedValue({ data: 'identity_conflict', error: null, status: 200 })

    await expect(
      handleCheckoutExpired(expiredRecurringProCheckoutSession(), expiredEvent)
    ).rejects.toThrow('release returned identity_conflict')

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('keeps release database failures retryable', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'release database unavailable' },
      status: 503,
    })

    await expect(
      handleCheckoutExpired(expiredRecurringProCheckoutSession(), expiredEvent)
    ).rejects.toThrow('Failed to release recurring Pro Checkout: release database unavailable')
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
