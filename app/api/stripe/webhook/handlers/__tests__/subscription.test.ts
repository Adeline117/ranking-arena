import type Stripe from 'stripe'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockLeaveProOfficialGroup = jest.fn()
const mockListCheckoutSessions = jest.fn()
const mockRecordStripeCheckoutManualReview = jest.fn()
const mockRetrieveCustomer = jest.fn()

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  withRetry: (operation: () => unknown) => operation(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/lib/stripe', () => ({
  SUBSCRIPTION_STATUS_MAP: { active: 'active', canceled: 'canceled', trialing: 'trialing' },
  STRIPE_API_PRICE_IDS: { starter: 'price_api_starter', pro: 'price_api_pro' },
  API_TIER_LIMITS: { free: 100, starter: 10_000, pro: 0 },
  stripe: {
    checkout: {
      sessions: {
        list: (...args: unknown[]) => mockListCheckoutSessions(...args),
      },
    },
  },
  getStripe: () => ({
    customers: {
      retrieve: (...args: unknown[]) => mockRetrieveCustomer(...args),
    },
  }),
  STRIPE_PRICE_IDS: {
    monthly: 'price_pro_monthly',
    yearly: 'price_pro_yearly',
    lifetime: 'price_pro_lifetime',
  },
}))

jest.mock('@/lib/env', () => ({
  env: { STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly' },
}))

jest.mock('@/app/api/pro-official-group/route', () => ({
  leaveProOfficialGroup: (...args: unknown[]) => mockLeaveProOfficialGroup(...args),
}))

jest.mock('@/lib/data/notifications', () => ({ sendNotification: jest.fn() }))
jest.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))
jest.mock('@/lib/stripe/lifetime-entitlement', () => ({
  recordStripeCheckoutManualReview: (...args: unknown[]) =>
    mockRecordStripeCheckoutManualReview(...args),
}))

import {
  handleSubscriptionCanceled,
  handleSubscriptionUpdate,
  updateUserSubscription,
} from '../subscription'

type DbError = { message: string }
const stripeEvent = { id: 'evt_current', created: 1_800_000_000, livemode: true }
const proUserId = '10e34ce2-43c1-4bcc-8f19-79b36d56605c'
const apiUserId = '11e34ce2-43c1-4bcc-8f19-79b36d56605c'
const apiReservationId = '91e34ce2-43c1-4bcc-8f19-79b36d56605c'
const recurringUserId = '21e34ce2-43c1-4bcc-8f19-79b36d56605c'
const recurringReservationId = '31e34ce2-43c1-4bcc-8f19-79b36d56605c'
const recurringOperationId = '41e34ce2-43c1-4bcc-8f19-79b36d56605c'
const recurringNonce = '51e34ce2-43c1-4bcc-8f19-79b36d56605c'
const apiSubscriptions = new Map<string, Stripe.Subscription>()
let mockApplyRpcResult: { data: unknown; error: unknown }
let mockPersistedRpcResult: { data: unknown; error: unknown }

function lookupQuery(data: unknown, error: DbError | null = null) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(async () => ({ data, error })),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_current',
    customer: 'cus_owner',
    status: 'active',
    created: 1_700_000_000,
    livemode: true,
    metadata: {},
    start_date: 1_700_000_000,
    cancel_at_period_end: false,
    items: {
      data: [{ quantity: 1, price: { id: 'price_pro_monthly' } }],
    },
    ...overrides,
  } as Stripe.Subscription
}

function recurringSubscription(
  trialRequested = false,
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return subscription({
    id: 'sub_recurring_exact',
    customer: 'cus_recurring_exact',
    status: trialRequested ? 'trialing' : 'active',
    collection_method: 'charge_automatically',
    currency: 'usd',
    automatic_tax: { enabled: false },
    default_tax_rates: [],
    pause_collection: null,
    schedule: null,
    metadata: {
      plan: 'monthly',
      pro_checkout_nonce: recurringNonce,
      pro_checkout_operation_id: recurringOperationId,
      pro_checkout_reservation_id: recurringReservationId,
      stripe_customer_id: 'cus_recurring_exact',
      stripe_price_id: 'price_pro_monthly',
      supabase_user_id: recurringUserId,
      trial_requested: trialRequested ? 'true' : 'false',
      type: 'pro_subscription',
      userId: recurringUserId,
    },
    cancel_at_period_end: false,
    canceled_at: null,
    pending_update: null,
    discounts: [],
    trial_start: trialRequested ? 1_799_500_000 : null,
    trial_end: trialRequested ? 1_800_104_800 : null,
    current_period_start: 1_799_500_000,
    current_period_end: 1_800_104_800,
    items: {
      data: [
        {
          id: 'si_recurring_exact',
          quantity: 1,
          subscription: 'sub_recurring_exact',
          current_period_start: 1_799_500_000,
          current_period_end: 1_800_104_800,
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
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
    ...overrides,
  })
}

function apiSubscription(
  plan: 'starter' | 'pro' = 'starter',
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  const snapshot = subscription({
    customer: 'cus_owner',
    metadata: {
      type: 'api_tier',
      api_plan: plan,
      userId: apiUserId,
      supabase_user_id: apiUserId,
      api_tier_reservation_id: apiReservationId,
    },
    items: {
      data: [
        {
          quantity: 1,
          price: { id: plan === 'starter' ? 'price_api_starter' : 'price_api_pro' },
        },
      ],
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
    ...overrides,
  })
  apiSubscriptions.set(snapshot.id, snapshot)
  return snapshot
}

function apiProfile(
  overrides: Partial<{
    api_stripe_subscription_id: string | null
    api_tier: string
    stripe_customer_id: string | null
  }> = {}
) {
  return {
    id: apiUserId,
    api_stripe_subscription_id: null,
    api_tier: 'free',
    stripe_customer_id: 'cus_owner',
    ...overrides,
  }
}

function exactApiCheckoutList(
  snapshot: Stripe.Subscription,
  sessionOverrides: Record<string, unknown> = {}
) {
  const metadata = snapshot.metadata || {}
  const plan = metadata.api_plan === 'pro' ? 'pro' : 'starter'
  const amount = plan === 'pro' ? 19_900 : 4_900
  return {
    has_more: false,
    data: [
      {
        id: `cs_test_${snapshot.id}`,
        object: 'checkout.session',
        mode: 'subscription',
        status: 'complete',
        payment_status: 'paid',
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
        livemode: snapshot.livemode,
        customer: snapshot.customer,
        subscription: snapshot.id,
        client_reference_id: metadata.api_tier_reservation_id,
        metadata: {
          api_plan: metadata.api_plan,
          api_tier_reservation_id: metadata.api_tier_reservation_id,
          supabase_user_id: metadata.supabase_user_id,
          type: metadata.type,
          userId: metadata.userId,
        },
        line_items: {
          has_more: false,
          data: [
            {
              quantity: 1,
              price: {
                id: plan === 'pro' ? 'price_api_pro' : 'price_api_starter',
              },
            },
          ],
        },
        ...sessionOverrides,
      },
    ],
  }
}

describe('subscription webhook persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    apiSubscriptions.clear()
    mockApplyRpcResult = { data: 'applied', error: null }
    mockPersistedRpcResult = { data: 'not_api', error: null }
    mockRpc.mockImplementation((name: string) => {
      if (name === 'apply_user_api_tier_stripe_event') {
        return Promise.resolve(mockApplyRpcResult)
      }
      if (name === 'apply_user_api_tier_persisted_non_grant_event') {
        return Promise.resolve(mockPersistedRpcResult)
      }
      if (name === 'sync_recurring_pro_subscription_projection_atomic') {
        return Promise.resolve({ data: 'updated', error: null })
      }
      if (name === 'assert_recurring_pro_checkout_completed_atomic') {
        return Promise.resolve({ data: 'completed', error: null, status: 200 })
      }
      if (name === 'reconcile_recurring_subscription_state_atomic') {
        return Promise.resolve({ data: { status: 'revoked' }, error: null })
      }
      throw new Error(`Unexpected RPC: ${name}`)
    })
    mockListCheckoutSessions.mockImplementation(
      async ({ subscription: subscriptionId }: { subscription: string }) => {
        const snapshot = apiSubscriptions.get(subscriptionId)
        if (!snapshot) throw new Error(`Missing API subscription fixture ${subscriptionId}`)
        return exactApiCheckoutList(snapshot)
      }
    )
    mockLeaveProOfficialGroup.mockResolvedValue(true)
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
    mockRetrieveCustomer.mockResolvedValue({
      id: 'cus_recurring_exact',
      object: 'customer',
      livemode: true,
      metadata: { userId: recurringUserId },
    })
  })

  it.each([
    ['paid', recurringSubscription(false)],
    ['trial', recurringSubscription(true)],
  ])(
    'leaves an exact active %s subscription to Checkout/invoice authority after completion assertion',
    async (_label, snapshot) => {
      await expect(handleSubscriptionUpdate(snapshot, stripeEvent)).resolves.toBeUndefined()

      expect(mockRpc).toHaveBeenCalledWith('assert_recurring_pro_checkout_completed_atomic', {
        p_user_id: recurringUserId,
        p_livemode: true,
        p_stripe_customer_id: 'cus_recurring_exact',
        p_stripe_subscription_id: 'sub_recurring_exact',
        p_reservation_id: recurringReservationId,
        p_operation_id: recurringOperationId,
        p_reservation_nonce: recurringNonce,
        p_plan: 'monthly',
        p_stripe_price_id: 'price_pro_monthly',
        p_trial_requested: _label === 'trial',
      })
      expect(mockFrom).not.toHaveBeenCalled()
      expect(mockRpc.mock.calls.some(([name]) => name === 'update_subscription_and_profile')).toBe(
        false
      )
      expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
    }
  )

  it('accepts the active lifecycle event after an exact Checkout-created trial ends', async () => {
    const trialStart = 1_799_000_000
    const trialEnd = trialStart + 7 * 24 * 60 * 60
    const snapshot = recurringSubscription(true, {
      status: 'active',
      trial_start: trialStart,
      trial_end: trialEnd,
      current_period_start: trialEnd,
      current_period_end: trialEnd + 30 * 24 * 60 * 60,
    })

    await expect(handleSubscriptionUpdate(snapshot, stripeEvent)).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'assert_recurring_pro_checkout_completed_atomic',
      expect.objectContaining({
        p_stripe_subscription_id: 'sub_recurring_exact',
        p_trial_requested: true,
      })
    )
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('retries an active subscription event that arrives before durable Checkout completion', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'assert_recurring_pro_checkout_completed_atomic') {
        return Promise.resolve({
          data: null,
          error: { code: '40001', message: 'completion is not durable yet' },
          status: 409,
        })
      }
      throw new Error(`Unexpected RPC: ${name}`)
    })

    await expect(handleSubscriptionUpdate(recurringSubscription(), stripeEvent)).rejects.toThrow(
      'completion assertion failed: completion is not durable yet'
    )

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('durably reviews malformed recurring metadata and performs no entitlement mutation', async () => {
    const snapshot = recurringSubscription(false, {
      metadata: {
        ...recurringSubscription().metadata,
        supabase_user_id: apiUserId,
      },
    })

    await expect(handleSubscriptionUpdate(snapshot, stripeEvent)).rejects.toThrow(
      'has invalid metadata'
    )

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'subscription_event',
        sessionId: 'evt_current',
        reasonKey: 'recurring_subscription_metadata_invalid',
      })
    )
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('durably reviews exact-envelope Stripe identity drift before assertion', async () => {
    await expect(
      handleSubscriptionUpdate(
        recurringSubscription(false, { customer: 'cus_wrong_owner' }),
        stripeEvent
      )
    ).rejects.toThrow('failed exact verification')

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'subscription_event',
        sessionId: 'evt_current',
        userId: recurringUserId,
        reasonKey: 'recurring_subscription_state_authority_failed',
      })
    )
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('routes an exact past-due subscription snapshot through the atomic state ledger', async () => {
    const snapshot = recurringSubscription(false, {
      status: 'past_due',
      latest_invoice: 'in_failed',
    })

    await expect(handleSubscriptionUpdate(snapshot, stripeEvent)).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'reconcile_recurring_subscription_state_atomic',
      expect.objectContaining({
        p_user_id: recurringUserId,
        p_stripe_customer_id: 'cus_recurring_exact',
        p_stripe_subscription_id: 'sub_recurring_exact',
        p_current_invoice_id: 'in_failed',
        p_plan: 'monthly',
        p_stripe_status: 'past_due',
        p_event_id: 'evt_current',
        p_event_created_at: new Date(stripeEvent.created * 1000).toISOString(),
        p_grace_expires_at: new Date((stripeEvent.created + 7 * 24 * 60 * 60) * 1000).toISOString(),
      })
    )
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('keeps an unsafe atomic state outcome retryable after durable review', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'assert_recurring_pro_checkout_completed_atomic') {
        return Promise.resolve({ data: 'completed', error: null, status: 200 })
      }
      if (name === 'reconcile_recurring_subscription_state_atomic') {
        return Promise.resolve({ data: { status: 'manual_review' }, error: null })
      }
      throw new Error(`Unexpected RPC: ${name}`)
    })

    await expect(
      handleSubscriptionUpdate(
        recurringSubscription(false, { status: 'past_due', latest_invoice: 'in_failed' }),
        stripeEvent
      )
    ).rejects.toThrow(
      'reconcile_recurring_subscription_state_atomic returned unsafe status manual_review'
    )
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'subscription_event',
        sessionId: 'evt_current',
        reasonKey: 'recurring_subscription_state_manual_review',
      })
    )
  })

  it('keeps a projection RPC failure retryable and has no direct-table fallback', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'projection unavailable' },
    })

    await expect(updateUserSubscription(proUserId, subscription(), 'monthly')).rejects.toThrow(
      'Failed to sync recurring Pro subscription projection: projection unavailable'
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps an unknown paid price retryable after durable review', async () => {
    await expect(
      handleSubscriptionUpdate(
        subscription({
          items: {
            data: [{ price: { id: 'price_unconfigured' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).rejects.toThrow('requires durable manual review')
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'unclassified_recurring_subscription_state',
      })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('does not classify a missing price or mutate a projection', async () => {
    await expect(
      handleSubscriptionUpdate(
        subscription({
          items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).rejects.toThrow('requires durable manual review')
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('routes an exact deleted subscription through the atomic state ledger', async () => {
    await expect(
      handleSubscriptionCanceled(
        recurringSubscription(false, {
          status: 'canceled',
          latest_invoice: 'in_paid',
          canceled_at: stripeEvent.created - 10,
        }),
        stripeEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'reconcile_recurring_subscription_state_atomic',
      expect.objectContaining({
        p_user_id: recurringUserId,
        p_stripe_subscription_id: 'sub_recurring_exact',
        p_current_invoice_id: 'in_paid',
        p_stripe_status: 'canceled',
        p_grace_expires_at: null,
        p_event_id: 'evt_current',
      })
    )
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('projects an active API subscription through the ordered Stripe-event RPC', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await expect(
      handleSubscriptionUpdate(apiSubscription('starter'), stripeEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith('apply_user_api_tier_stripe_event', {
      p_user_id: apiUserId,
      p_metadata_user_id: apiUserId,
      p_metadata_supabase_user_id: apiUserId,
      p_stripe_customer_id: 'cus_owner',
      p_checkout_reservation_id: apiReservationId,
      p_stripe_price_id: 'price_api_starter',
      p_api_tier: 'starter',
      p_daily_limit: 10_000,
      p_stripe_subscription_id: 'sub_current',
      p_subscription_created: 1_700_000_000,
      p_stripe_event_id: 'evt_current',
      p_event_created: 1_800_000_000,
      p_is_active: true,
      p_is_terminal: false,
      p_livemode: true,
      p_checkout_session_id: 'cs_test_sub_current',
      p_checkout_api_plan: 'starter',
      p_checkout_price_id: 'price_api_starter',
      p_identity_source: 'signed_metadata',
    })
  })

  it.each([
    [
      'mismatched owner aliases',
      {
        metadata: {
          type: 'api_tier',
          api_plan: 'starter',
          userId: apiUserId,
          supabase_user_id: '21e34ce2-43c1-4bcc-8f19-79b36d56605c',
          api_tier_reservation_id: apiReservationId,
        },
      },
    ],
    [
      'malformed reservation identity',
      {
        metadata: {
          type: 'api_tier',
          api_plan: 'starter',
          userId: apiUserId,
          supabase_user_id: apiUserId,
          api_tier_reservation_id: 'not-a-uuid',
        },
      },
    ],
    [
      'non-unit subscription item quantity',
      {
        items: {
          data: [{ quantity: 2, price: { id: 'price_api_starter' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      },
    ],
  ])('rejects API entitlement authority with %s', async (_case, overrides) => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await expect(
      handleSubscriptionUpdate(apiSubscription('starter', overrides), stripeEvent)
    ).rejects.toThrow('API subscription sub_current has invalid exact entitlement identity')
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it('rejects a Stripe Customer that does not match the canonical owner profile', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await expect(
      handleSubscriptionUpdate(
        apiSubscription('starter', { customer: 'cus_attacker' }),
        stripeEvent
      )
    ).rejects.toThrow('API subscription sub_current customer ownership does not match')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('keeps an API owner lookup failure retryable instead of treating it as deletion', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(null, { message: 'API owner lookup temporarily unavailable' })
    )

    await expect(handleSubscriptionUpdate(apiSubscription('starter'), stripeEvent)).rejects.toThrow(
      'Failed to find API subscription owner: API owner lookup temporarily unavailable'
    )
    expect(mockListCheckoutSessions).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects a new API subscription before RPC when its reservation is missing', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    const snapshot = apiSubscription('starter')
    delete snapshot.metadata.api_tier_reservation_id

    await expect(handleSubscriptionUpdate(snapshot, stripeEvent)).rejects.toThrow(
      'API subscription sub_current has invalid exact entitlement identity'
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'apply_user_api_tier_persisted_non_grant_event',
    ])
  })

  it('rejects a reservation-less current legacy API subscription', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(apiProfile({ api_stripe_subscription_id: 'sub_current', api_tier: 'starter' }))
    )
    const snapshot = apiSubscription('starter')
    delete snapshot.metadata.api_tier_reservation_id

    await expect(handleSubscriptionUpdate(snapshot, stripeEvent)).rejects.toThrow(
      'API subscription sub_current has invalid exact entitlement identity'
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'apply_user_api_tier_persisted_non_grant_event',
    ])
  })

  it('confirms the one exact paid Checkout Session before applying paid quota', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await handleSubscriptionUpdate(apiSubscription('pro'), stripeEvent)

    expect(mockListCheckoutSessions).toHaveBeenCalledWith({
      subscription: 'sub_current',
      limit: 2,
      expand: ['data.line_items'],
    })
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['apply_user_api_tier_stripe_event'])
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_checkout_reservation_id: apiReservationId,
        p_checkout_session_id: 'cs_test_sub_current',
        p_checkout_api_plan: 'pro',
        p_checkout_price_id: 'price_api_pro',
        p_stripe_subscription_id: 'sub_current',
      })
    )
  })

  it('lets an exact signed update reach the atomic ledger after its profile was hard-deleted', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(null))
    mockApplyRpcResult = { data: 'subject_deleted', error: null }

    await expect(
      handleSubscriptionUpdate(apiSubscription('starter'), stripeEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_user_id: apiUserId,
        p_metadata_user_id: apiUserId,
        p_metadata_supabase_user_id: apiUserId,
        p_checkout_reservation_id: apiReservationId,
        p_stripe_subscription_id: 'sub_current',
        p_is_active: true,
        p_is_terminal: false,
      })
    )
  })

  it('accepts a durable block acknowledgement for a retired API subscription', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))
    mockApplyRpcResult = { data: 'blocked', error: null }

    await expect(
      handleSubscriptionUpdate(apiSubscription('starter'), stripeEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_stripe_subscription_id: 'sub_current',
        p_is_active: true,
        p_is_terminal: false,
      })
    )
  })

  it('rejects an ambiguous Checkout mapping before touching entitlement state', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))
    mockListCheckoutSessions.mockResolvedValueOnce({
      has_more: true,
      data: [],
    })

    await expect(handleSubscriptionUpdate(apiSubscription('starter'), stripeEvent)).rejects.toThrow(
      'does not map to one exact Checkout Session'
    )

    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects a truncated Checkout line-item expansion before confirmation', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))
    const snapshot = apiSubscription('starter')
    mockListCheckoutSessions.mockResolvedValueOnce({
      has_more: false,
      data: [
        {
          id: 'cs_test_sub_current',
          object: 'checkout.session',
          mode: 'subscription',
          status: 'complete',
          payment_status: 'paid',
          livemode: true,
          customer: 'cus_owner',
          subscription: snapshot.id,
          client_reference_id: apiReservationId,
          metadata: {
            api_plan: 'starter',
            api_tier_reservation_id: apiReservationId,
            supabase_user_id: apiUserId,
            type: 'api_tier',
            userId: apiUserId,
          },
          line_items: {
            has_more: true,
            data: [{ quantity: 1, price: { id: 'price_api_starter' } }],
          },
        },
      ],
    })

    await expect(handleSubscriptionUpdate(snapshot, stripeEvent)).rejects.toThrow(
      'has no exact paid Checkout Session authority'
    )
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['promotion-code field', { allow_promotion_codes: true }],
    ['discount object', { discounts: [{ promotion_code: 'promo_unsafe' }] }],
    ['discounted total', { amount_total: 4_000 }],
    ['wrong currency', { currency: 'eur' }],
    [
      'nonzero discount amount',
      {
        total_details: {
          amount_discount: 900,
          amount_shipping: 0,
          amount_tax: 0,
        },
      },
    ],
  ])('rejects paid API Checkout authority with %s', async (_case, sessionDrift) => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))
    const snapshot = apiSubscription('starter')
    mockListCheckoutSessions.mockResolvedValueOnce(exactApiCheckoutList(snapshot, sessionDrift))

    await expect(handleSubscriptionUpdate(snapshot, stripeEvent)).rejects.toThrow(
      'has no exact paid Checkout Session authority'
    )
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('keeps exact Checkout confirmation and quota application in one retryable RPC', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))
    mockApplyRpcResult = {
      data: null,
      error: { message: 'Checkout Session does not match reservation' },
    }

    await expect(handleSubscriptionUpdate(apiSubscription('starter'), stripeEvent)).rejects.toThrow(
      'Failed to apply API tier Stripe event: Checkout Session does not match reservation'
    )

    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_checkout_session_id: 'cs_test_sub_current',
        p_checkout_price_id: 'price_api_starter',
      })
    )
  })

  it('rejects a reservation-less historical cancellation before the sealed ledger', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(apiProfile({ api_stripe_subscription_id: 'sub_newer', api_tier: 'pro' }))
    )
    mockApplyRpcResult = { data: 'stale', error: null }
    const snapshot = apiSubscription('starter', { id: 'sub_older' })
    delete snapshot.metadata.api_tier_reservation_id

    await expect(handleSubscriptionCanceled(snapshot, stripeEvent)).rejects.toThrow(
      'API subscription sub_older has invalid exact entitlement identity'
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'apply_user_api_tier_persisted_non_grant_event',
    ])
  })

  it('lets an exact signed cancellation reach the atomic ledger after its profile was hard-deleted', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(null))
    mockApplyRpcResult = { data: 'subject_deleted', error: null }

    await expect(
      handleSubscriptionCanceled(apiSubscription('starter'), stripeEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_stripe_subscription_id: 'sub_current',
        p_is_terminal: true,
      })
    )
  })

  it.each(['canceled', 'incomplete_expired'] as const)(
    'records API status %s as terminal and revokes paid quota',
    async (status) => {
      mockFrom.mockReturnValueOnce(
        lookupQuery(
          apiProfile({
            api_stripe_subscription_id: 'sub_current',
            api_tier: 'starter',
          })
        )
      )

      await handleSubscriptionUpdate(
        apiSubscription('starter', {
          status,
        }),
        stripeEvent
      )

      expect(mockRpc).toHaveBeenCalledWith(
        'apply_user_api_tier_stripe_event',
        expect.objectContaining({
          p_api_tier: 'free',
          p_daily_limit: 100,
          p_is_active: false,
          p_is_terminal: true,
        })
      )
    }
  )

  it('revokes a terminal API subscription after its paid price was rotated out', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(
        apiProfile({
          api_stripe_subscription_id: 'sub_current',
          api_tier: 'pro',
        })
      )
    )

    await handleSubscriptionUpdate(
      apiSubscription('pro', {
        status: 'canceled',
        items: {
          data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      stripeEvent
    )

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_legacy_pro',
        p_api_tier: 'free',
        p_daily_limit: 100,
        p_is_active: false,
        p_is_terminal: true,
      })
    )
  })

  it.each(['incomplete', 'paused', 'unpaid'] as const)(
    'records API status %s as a recoverable suspension',
    async (status) => {
      mockFrom.mockReturnValueOnce(
        lookupQuery(
          apiProfile({
            api_stripe_subscription_id: 'sub_current',
            api_tier: 'starter',
          })
        )
      )

      await handleSubscriptionUpdate(
        apiSubscription('starter', {
          status,
        }),
        stripeEvent
      )

      expect(mockRpc).toHaveBeenCalledWith(
        'apply_user_api_tier_stripe_event',
        expect.objectContaining({
          p_api_tier: 'free',
          p_daily_limit: 100,
          p_is_active: false,
          p_is_terminal: false,
        })
      )
    }
  )

  it('records a suspended API subscription after its paid price was rotated out', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(
        apiProfile({
          api_stripe_subscription_id: 'sub_current',
          api_tier: 'pro',
        })
      )
    )

    await handleSubscriptionUpdate(
      apiSubscription('pro', {
        status: 'paused',
        items: {
          data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      stripeEvent
    )

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_legacy_pro',
        p_api_tier: 'free',
        p_is_active: false,
        p_is_terminal: false,
      })
    )
  })

  it('revokes a current-price API subscription whose metadata was erased', async () => {
    mockPersistedRpcResult = { data: 'applied', error: null }
    const snapshot = subscription({
      status: 'canceled',
      metadata: {},
      items: {
        data: [{ quantity: 1, price: { id: 'price_api_starter' } }],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    })

    await handleSubscriptionUpdate(snapshot, stripeEvent)

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith('apply_user_api_tier_persisted_non_grant_event', {
      p_stripe_customer_id: 'cus_owner',
      p_stripe_price_id: 'price_api_starter',
      p_stripe_subscription_id: 'sub_current',
      p_subscription_created: 1_700_000_000,
      p_stripe_event_id: 'evt_current',
      p_event_created: 1_800_000_000,
      p_is_terminal: true,
      p_livemode: true,
    })
  })

  it('revokes a metadata-free API subscription after its price was rotated out', async () => {
    mockPersistedRpcResult = { data: 'stale', error: null }
    const snapshot = subscription({
      id: 'sub_older',
      status: 'canceled',
      metadata: {},
      items: {
        data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    })

    await handleSubscriptionUpdate(snapshot, stripeEvent)

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_persisted_non_grant_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_legacy_pro',
        p_stripe_subscription_id: 'sub_older',
        p_is_terminal: true,
      })
    )
  })

  it('suspends a persisted API subscription when an active unknown price cannot grant', async () => {
    mockPersistedRpcResult = { data: 'applied', error: null }

    await handleSubscriptionUpdate(
      apiSubscription('pro', {
        items: {
          data: [{ quantity: 1, price: { id: 'price_api_unknown_portal' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      stripeEvent
    )

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockListCheckoutSessions).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_persisted_non_grant_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_unknown_portal',
        p_is_terminal: false,
      })
    )
  })

  it('suspends a metadata-free active API subscription with a rotated price', async () => {
    mockPersistedRpcResult = { data: 'applied', error: null }

    await handleSubscriptionUpdate(
      subscription({
        metadata: {},
        items: {
          data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      stripeEvent
    )

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_persisted_non_grant_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_legacy_pro',
        p_is_terminal: false,
      })
    )
  })

  it('routes a legacy ordinary subscription to durable review after API authority says not_api', async () => {
    await expect(
      handleSubscriptionUpdate(
        subscription({
          items: {
            data: [{ quantity: 1, price: { id: 'price_pro_monthly' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).rejects.toThrow('requires durable manual review')

    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'apply_user_api_tier_persisted_non_grant_event',
    ])
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ reasonKey: 'legacy_recurring_subscription_identity' })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps persisted non-grant failures retryable', async () => {
    mockPersistedRpcResult = {
      data: null,
      error: { message: 'persisted authority unavailable' },
    }

    await expect(
      handleSubscriptionUpdate(
        subscription({
          status: 'canceled',
          items: {
            data: [{ quantity: 1, price: { id: 'price_api_starter' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).rejects.toThrow(
      'Failed to apply persisted API tier non-grant event: persisted authority unavailable'
    )
  })

  it('allows an unpaid API subscription to recover after its suspended event', async () => {
    mockFrom
      .mockReturnValueOnce(
        lookupQuery(
          apiProfile({
            api_stripe_subscription_id: 'sub_current',
            api_tier: 'starter',
          })
        )
      )
      .mockReturnValueOnce(
        lookupQuery(
          apiProfile({
            api_stripe_subscription_id: 'sub_current',
            api_tier: 'free',
          })
        )
      )

    await handleSubscriptionUpdate(apiSubscription('starter', { status: 'unpaid' }), stripeEvent)
    await handleSubscriptionUpdate(apiSubscription('starter', { status: 'active' }), {
      ...stripeEvent,
      id: 'evt_recovered',
      created: stripeEvent.created + 1,
    })

    const applyCalls = mockRpc.mock.calls.filter(
      ([name]) => name === 'apply_user_api_tier_stripe_event'
    )
    expect(applyCalls).toHaveLength(2)
    expect(applyCalls[0][1]).toEqual(
      expect.objectContaining({
        p_is_active: false,
        p_is_terminal: false,
      })
    )
    expect(applyCalls[1][1]).toEqual(
      expect.objectContaining({
        p_is_active: true,
        p_is_terminal: false,
      })
    )
  })

  it('keeps an API subscription during explicit past-due retry grace', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(
        apiProfile({
          api_stripe_subscription_id: 'sub_current',
          api_tier: 'starter',
        })
      )
    )

    await handleSubscriptionUpdate(
      apiSubscription('starter', {
        status: 'past_due',
      }),
      stripeEvent
    )

    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['event predates subscription', { created: 1_900_000_000 }, stripeEvent],
    [
      'subscription timestamp exceeds PostgreSQL timestamp range',
      { created: 253_402_300_800 },
      { ...stripeEvent, created: 253_402_300_800 },
    ],
    [
      'event timestamp exceeds PostgreSQL timestamp range',
      {},
      { ...stripeEvent, created: 253_402_300_800 },
    ],
  ])('rejects API identity when %s', async (_case, subscriptionOverrides, event) => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await expect(
      handleSubscriptionUpdate(
        apiSubscription('starter', {
          ...subscriptionOverrides,
        }),
        event
      )
    ).rejects.toThrow('API subscription sub_current has invalid Stripe event identity')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects a rotated or unknown API price instead of trusting metadata', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await expect(
      handleSubscriptionUpdate(
        apiSubscription('pro', {
          items: {
            data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).rejects.toThrow('API subscription sub_current has invalid exact entitlement identity')
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_persisted_non_grant_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_legacy_pro',
        p_is_terminal: false,
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it('suspends an unpaid Portal plan change instead of granting the new tier', async () => {
    mockPersistedRpcResult = { data: 'applied', error: null }

    await expect(
      handleSubscriptionUpdate(
        apiSubscription('starter', {
          items: {
            data: [{ quantity: 1, price: { id: 'price_api_pro' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_persisted_non_grant_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_pro',
        p_is_terminal: false,
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it('suspends a same-plan price rotation without separate paid authority', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))
    mockPersistedRpcResult = { data: 'applied', error: null }
    const snapshot = apiSubscription('pro')
    mockListCheckoutSessions.mockResolvedValueOnce(
      exactApiCheckoutList(snapshot, {
        line_items: {
          has_more: false,
          data: [{ quantity: 1, price: { id: 'price_api_pro_original' } }],
        },
      })
    )

    await handleSubscriptionUpdate(snapshot, stripeEvent)

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_persisted_non_grant_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_pro',
        p_is_terminal: false,
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it('rejects a subscription snapshot whose livemode disagrees with its signed event', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await expect(
      handleSubscriptionUpdate(
        apiSubscription('starter', {
          livemode: false,
        }),
        stripeEvent
      )
    ).rejects.toThrow('API subscription sub_current has invalid Stripe event identity')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('atomically records an API subscription cancellation', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(
        apiProfile({
          api_stripe_subscription_id: 'sub_current',
          api_tier: 'pro',
        })
      )
    )

    await expect(
      handleSubscriptionCanceled(apiSubscription('pro'), stripeEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith('apply_user_api_tier_stripe_event', {
      p_user_id: apiUserId,
      p_metadata_user_id: apiUserId,
      p_metadata_supabase_user_id: apiUserId,
      p_stripe_customer_id: 'cus_owner',
      p_checkout_reservation_id: apiReservationId,
      p_stripe_price_id: 'price_api_pro',
      p_api_tier: 'free',
      p_daily_limit: 100,
      p_stripe_subscription_id: 'sub_current',
      p_subscription_created: 1_700_000_000,
      p_stripe_event_id: 'evt_current',
      p_event_created: 1_800_000_000,
      p_is_active: false,
      p_is_terminal: true,
      p_livemode: true,
      p_checkout_session_id: 'cs_test_sub_current',
      p_checkout_api_plan: 'pro',
      p_checkout_price_id: 'price_api_pro',
      p_identity_source: 'signed_metadata',
    })
  })

  it('records a deleted API subscription after its paid price was rotated out', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(
        apiProfile({
          api_stripe_subscription_id: 'sub_current',
          api_tier: 'pro',
        })
      )
    )

    await handleSubscriptionCanceled(
      apiSubscription('pro', {
        status: 'canceled',
        items: {
          data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      stripeEvent
    )

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_legacy_pro',
        p_api_tier: 'free',
        p_is_active: false,
        p_is_terminal: true,
      })
    )
  })

  it('revokes a metadata-free deleted API subscription through persisted identity', async () => {
    mockPersistedRpcResult = { data: 'not_current', error: null }

    await handleSubscriptionCanceled(
      subscription({
        status: 'canceled',
        metadata: {},
        items: {
          data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      stripeEvent
    )

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_persisted_non_grant_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_legacy_pro',
        p_stripe_subscription_id: 'sub_current',
        p_is_terminal: true,
      })
    )
  })

  it('routes legacy cancellation to durable review instead of direct projection writes', async () => {
    await expect(
      handleSubscriptionCanceled(
        subscription({
          status: 'canceled',
          items: {
            data: [{ quantity: 1, price: { id: 'price_pro_monthly' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).rejects.toThrow('requires durable manual review')

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'legacy_recurring_subscription_identity',
      })
    )
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('preserves a replacement API subscription when an older cancellation arrives late', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(
        apiProfile({
          api_stripe_subscription_id: 'sub_newer',
          api_tier: 'pro',
        })
      )
    )
    mockApplyRpcResult = { data: 'stale', error: null }

    await expect(
      handleSubscriptionCanceled(
        apiSubscription('starter', {
          id: 'sub_older',
        }),
        stripeEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_stripe_subscription_id: 'sub_older',
        p_is_active: false,
        p_is_terminal: true,
      })
    )
  })

  it('fails closed when a legacy cancellation has no exact metadata', async () => {
    await expect(
      handleSubscriptionCanceled(
        subscription({
          metadata: {},
          items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).rejects.toThrow('requires durable manual review')
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps an API cancellation retryable when the atomic downgrade fails', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(
        apiProfile({
          api_stripe_subscription_id: 'sub_current',
          api_tier: 'pro',
        })
      )
    )
    mockApplyRpcResult = {
      data: null,
      error: { message: 'atomic API downgrade unavailable' },
    }

    await expect(handleSubscriptionCanceled(apiSubscription('pro'), stripeEvent)).rejects.toThrow(
      'Failed to apply API tier Stripe event: atomic API downgrade unavailable'
    )
  })

  it('fails closed instead of routing an unclassified cancellation into Pro mutation', async () => {
    await expect(
      handleSubscriptionCanceled(
        subscription({
          metadata: {},
          items: {
            data: [{ price: { id: 'price_unknown' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).rejects.toThrow('requires durable manual review')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })
})
