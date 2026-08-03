import type Stripe from 'stripe'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockLeaveProOfficialGroup = jest.fn()
const mockListCheckoutSessions = jest.fn()
const mockResolveSubscriptionEventStateAuthority = jest.fn()

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  withRetry: (operation: () => unknown) => operation(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
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
  STRIPE_PRICE_IDS: {
    monthly: 'price_pro_monthly',
    yearly: 'price_pro_yearly',
    lifetime: 'price_pro_lifetime',
  },
}))

jest.mock('@/lib/stripe/entitlement-authority', () => {
  const actual = jest.requireActual('@/lib/stripe/entitlement-authority')
  return {
    ...actual,
    resolveSubscriptionEventStateAuthority: (...args: unknown[]) =>
      mockResolveSubscriptionEventStateAuthority(...args),
  }
})

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

import { handleSubscriptionCanceled, handleSubscriptionUpdate } from '../subscription'
import { StripeAuthorityError } from '@/lib/stripe/entitlement-authority'

type DbError = { message: string }
const stripeEvent = { id: 'evt_current', created: 1_800_000_000, livemode: true }
const apiUserId = '11e34ce2-43c1-4bcc-8f19-79b36d56605c'
const apiReservationId = '91e34ce2-43c1-4bcc-8f19-79b36d56605c'
const apiSubscriptions = new Map<string, Stripe.Subscription>()
let mockApplyRpcResult: { data: unknown; error: unknown }
let mockPersistedRpcResult: { data: unknown; error: unknown }
let mockRecurringPriceRpcResult: { data: unknown; error: unknown }
let mockRecurringReconcileRpcResult: { data: unknown; error: unknown }
let mockRecurringReviewRpcResult: { data: unknown; error: unknown }

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

function mutationQuery(error: DbError | null = null) {
  const result = { error }
  const query: {
    update: jest.Mock
    eq: jest.Mock
    then: Promise<typeof result>['then']
  } = {
    update: jest.fn(),
    eq: jest.fn(),
    then: Promise.resolve(result).then.bind(Promise.resolve(result)),
  }
  query.update.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  const subscriptionId = overrides.id ?? 'sub_current'
  const overrideItems = overrides.items
  const rawItems = overrideItems?.data ?? [
    {
      quantity: 1,
      price: { id: 'price_pro_monthly' },
    } as Stripe.SubscriptionItem,
  ]
  const items = {
    object: overrideItems?.object ?? ('list' as const),
    has_more: overrideItems?.has_more ?? false,
    data: rawItems.map((item, index) => ({
      id: item.id ?? `si_${index || 'current'}`,
      object: item.object ?? ('subscription_item' as const),
      subscription: item.subscription ?? subscriptionId,
      ...item,
    })),
  } as Stripe.ApiList<Stripe.SubscriptionItem>
  const { items: _ignoredItems, ...restOverrides } = overrides
  return {
    id: subscriptionId,
    object: 'subscription',
    customer: 'cus_owner',
    status: 'active',
    created: 1_700_000_000,
    livemode: true,
    metadata: {},
    start_date: 1_700_000_000,
    cancel_at_period_end: false,
    items,
    ...restOverrides,
  } as Stripe.Subscription
}

function apiSubscription(
  plan: 'starter' | 'pro' = 'starter',
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  const subscriptionId = overrides.id ?? 'sub_current'
  const { items: overrideItems, ...restOverrides } = overrides
  const snapshot = subscription({
    id: subscriptionId,
    customer: 'cus_owner',
    metadata: {
      type: 'api_tier',
      api_plan: plan,
      userId: apiUserId,
      supabase_user_id: apiUserId,
      api_tier_reservation_id: apiReservationId,
    },
    items: {
      object: overrideItems?.object ?? 'list',
      has_more: overrideItems?.has_more ?? false,
      data: overrideItems?.data ?? [
        {
          quantity: 1,
          price: { id: plan === 'starter' ? 'price_api_starter' : 'price_api_pro' },
        } as Stripe.SubscriptionItem,
      ],
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
    ...restOverrides,
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
        created: snapshot.created - 60,
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

function recurringAuthorityError(message: string, priceId: string | null) {
  return new StripeAuthorityError({
    code: 'unsupported_product',
    stage: 'product',
    message,
    objectIds: { subscriptionId: 'sub_current' },
    details: { priceId },
  })
}

function arrangeRegularCancellation(
  options: {
    subscriptionUpdateError?: DbError
    currentSubscriptionError?: DbError
    currentProfileError?: DbError
    profileDowngradeError?: DbError
  } = {}
) {
  mockFrom
    .mockImplementationOnce(() => lookupQuery({ id: 'user-1' }))
    .mockImplementationOnce(() => mutationQuery(options.subscriptionUpdateError))
    .mockImplementationOnce(() =>
      lookupQuery(
        { stripe_subscription_id: 'sub_current', status: 'canceled' },
        options.currentSubscriptionError
      )
    )
    .mockImplementationOnce(() => lookupQuery({ pro_plan: 'monthly' }, options.currentProfileError))
    .mockImplementationOnce(() => mutationQuery(options.profileDowngradeError))
}

describe('subscription webhook persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockRpc.mockReset()
    mockListCheckoutSessions.mockReset()
    mockResolveSubscriptionEventStateAuthority.mockReset()
    apiSubscriptions.clear()
    mockApplyRpcResult = { data: 'applied', error: null }
    mockPersistedRpcResult = { data: 'not_api', error: null }
    mockRecurringPriceRpcResult = { data: { status: 'not_found' }, error: null }
    mockRecurringReconcileRpcResult = { data: { status: 'reconciled' }, error: null }
    mockRecurringReviewRpcResult = { data: { status: 'recorded' }, error: null }
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'classify_recurring_subscription_product_authority_atomic') {
        const priceId = args.p_stripe_price_id
        const subscriptionId = String(args.p_stripe_subscription_id ?? '')
        if (
          apiSubscriptions.has(subscriptionId) ||
          priceId === 'price_api_starter' ||
          priceId === 'price_api_pro'
        ) {
          return Promise.resolve({ data: { status: 'api_tier' }, error: null })
        }
        if (priceId === 'price_pro_monthly' || priceId === 'price_pro_yearly') {
          return Promise.resolve({ data: { status: 'b2c_pro' }, error: null })
        }
        return Promise.resolve({ data: { status: 'not_found' }, error: null })
      }
      if (name === 'apply_user_api_tier_stripe_event') {
        return Promise.resolve(mockApplyRpcResult)
      }
      if (name === 'apply_user_api_tier_persisted_non_grant_event') {
        return Promise.resolve(mockPersistedRpcResult)
      }
      if (name === 'update_subscription_and_profile') {
        return Promise.resolve({ data: null, error: null })
      }
      if (name === 'resolve_b2c_recurring_price_authority') {
        return Promise.resolve(mockRecurringPriceRpcResult)
      }
      if (
        name === 'reconcile_b2c_subscription_event_atomic' ||
        name === 'activate_and_reconcile_b2c_recurring_trial_event_atomic'
      ) {
        return Promise.resolve(mockRecurringReconcileRpcResult)
      }
      if (name === 'record_b2c_recurring_manual_review_atomic') {
        return Promise.resolve(mockRecurringReviewRpcResult)
      }
      throw new Error(`Unexpected RPC: ${name}`)
    })
    mockResolveSubscriptionEventStateAuthority.mockImplementation(
      async (_stripe: unknown, snapshot: Stripe.Subscription) => {
        const priceId = snapshot.items.data[0]?.price.id || 'price_pro_monthly'
        return {
          kind: 'subscription_state',
          userId: '11e34ce2-43c1-4bcc-8f19-79b36d56605d',
          customerId:
            typeof snapshot.customer === 'string' ? snapshot.customer : snapshot.customer.id,
          subscriptionId: snapshot.id,
          currentInvoiceId: null,
          priceId,
          plan: priceId === 'price_pro_yearly' ? 'yearly' : 'monthly',
          expectedAmount: priceId === 'price_pro_yearly' ? 15_000 : 2_500,
          currency: 'usd',
          periodStart: snapshot.start_date,
          periodEnd: snapshot.start_date + 30 * 24 * 60 * 60,
          subscriptionStatus: snapshot.status,
          cancelAtPeriodEnd: snapshot.cancel_at_period_end,
          canceledAt: snapshot.canceled_at || null,
        }
      }
    )
    mockListCheckoutSessions.mockImplementation(
      async ({ subscription: subscriptionId }: { subscription: string }) => {
        const snapshot = apiSubscriptions.get(subscriptionId)
        if (!snapshot) throw new Error(`Missing API subscription fixture ${subscriptionId}`)
        return exactApiCheckoutList(snapshot)
      }
    )
    mockLeaveProOfficialGroup.mockResolvedValue(true)
  })

  it('throws when the subscription owner lookup fails', async () => {
    mockRecurringPriceRpcResult = {
      data: null,
      error: { message: 'user_profiles temporarily unavailable' },
    }

    await expect(handleSubscriptionUpdate(subscription(), stripeEvent)).rejects.toThrow(
      'Historical recurring price authority failed: user_profiles temporarily unavailable'
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'reconcile_b2c_subscription_event_atomic'
    )
  })

  it('keeps the successful subscription update path intact', async () => {
    await expect(handleSubscriptionUpdate(subscription(), stripeEvent)).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'reconcile_b2c_subscription_event_atomic',
      expect.objectContaining({
        p_user_id: '11e34ce2-43c1-4bcc-8f19-79b36d56605d',
        p_stripe_subscription_id: 'sub_current',
        p_stripe_price_id: 'price_pro_monthly',
        p_plan: 'monthly',
        p_event_id: 'evt_current',
        p_livemode: true,
      })
    )
  })

  it('keeps an unknown paid price retryable without granting Pro', async () => {
    mockResolveSubscriptionEventStateAuthority.mockRejectedValueOnce(
      recurringAuthorityError(
        'Cannot map Stripe price price_unconfigured to an ordinary Pro plan',
        'price_unconfigured'
      )
    )
    mockRecurringReviewRpcResult = {
      data: null,
      error: { message: 'manual review persistence unavailable' },
    }

    await expect(
      handleSubscriptionUpdate(
        subscription({
          items: {
            data: [{ price: { id: 'price_unconfigured' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).rejects.toThrow(
      'Failed to persist recurring Stripe authority review: manual review persistence unavailable'
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'reconcile_b2c_subscription_event_atomic'
    )
  })

  it('does not classify a missing price as a configured yearly plan', async () => {
    mockResolveSubscriptionEventStateAuthority.mockRejectedValueOnce(
      recurringAuthorityError('Cannot map a missing Stripe price to an ordinary Pro plan', null)
    )

    await expect(
      handleSubscriptionUpdate(
        subscription({
          items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_b2c_recurring_manual_review_atomic',
      expect.objectContaining({
        p_object_type: 'subscription_event',
        p_object_id: 'evt_current',
        p_reason_key: 'b2c_recurring_authority:ambiguous_product',
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'reconcile_b2c_subscription_event_atomic'
    )
  })

  it.each([
    ['subscription cancellation record', 'subscriptions update failed'],
    ['current-subscription safety lookup', 'current subscription lookup failed'],
    ['lifetime entitlement safety lookup', 'lifetime lookup failed'],
    ['profile downgrade', 'profile downgrade failed'],
  ])('throws when the %s fails', async (_stage, failureMessage) => {
    mockRecurringReconcileRpcResult = {
      data: null,
      error: { message: failureMessage },
    }

    await expect(
      handleSubscriptionCanceled(
        subscription({ status: 'canceled', canceled_at: 1_799_999_000 }),
        stripeEvent
      )
    ).rejects.toThrow(`Recurring subscription reconciliation failed: ${failureMessage}`)
  })

  it('throws when the canceled-subscription owner lookup fails', async () => {
    mockRecurringPriceRpcResult = {
      data: null,
      error: { message: 'canceled owner lookup temporarily failed' },
    }

    await expect(
      handleSubscriptionCanceled(
        subscription({ status: 'canceled', canceled_at: 1_799_999_000 }),
        stripeEvent
      )
    ).rejects.toThrow(
      'Historical recurring price authority failed: canceled owner lookup temporarily failed'
    )
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
  ])('rejects API entitlement authority with %s', async (_case, overrides) => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await expect(
      handleSubscriptionUpdate(apiSubscription('starter', overrides), stripeEvent)
    ).rejects.toThrow('API subscription sub_current has invalid exact entitlement identity')
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it('durably reviews a non-unit API Subscription item before quota mutation', async () => {
    await expect(
      handleSubscriptionUpdate(
        apiSubscription('starter', {
          items: {
            data: [{ quantity: 2, price: { id: 'price_api_starter' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_b2c_recurring_manual_review_atomic',
      expect.objectContaining({
        p_object_type: 'subscription_event',
        p_reason_key: 'b2c_recurring_authority:ambiguous_product',
      })
    )
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
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it('keeps an API owner lookup failure retryable instead of treating it as deletion', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(null, { message: 'API owner lookup temporarily unavailable' })
    )

    await expect(handleSubscriptionUpdate(apiSubscription('starter'), stripeEvent)).rejects.toThrow(
      'Failed to find API subscription owner: API owner lookup temporarily unavailable'
    )
    expect(mockListCheckoutSessions).not.toHaveBeenCalled()
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it('passes a missing reservation as null so the atomic RPC rejects a new subscription', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))
    mockApplyRpcResult = {
      data: null,
      error: { message: 'new API subscription is missing its checkout reservation identity' },
    }

    const snapshot = apiSubscription('starter')
    delete snapshot.metadata.api_tier_reservation_id

    await expect(handleSubscriptionUpdate(snapshot, stripeEvent)).rejects.toThrow(
      'Failed to apply API tier Stripe event: new API subscription is missing its checkout reservation identity'
    )
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({ p_checkout_reservation_id: null })
    )
  })

  it('accepts a reservation-less current legacy API subscription without inventing identity', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(apiProfile({ api_stripe_subscription_id: 'sub_current', api_tier: 'starter' }))
    )
    const snapshot = apiSubscription('starter')
    delete snapshot.metadata.api_tier_reservation_id

    await handleSubscriptionUpdate(snapshot, stripeEvent)

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({ p_checkout_reservation_id: null })
    )
  })

  it('confirms the one exact paid Checkout Session before applying paid quota', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await handleSubscriptionUpdate(apiSubscription('pro'), stripeEvent)

    expect(mockListCheckoutSessions).toHaveBeenCalledWith({
      subscription: 'sub_current',
      limit: 2,
      expand: ['data.line_items'],
    })
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'classify_recurring_subscription_product_authority_atomic',
      'apply_user_api_tier_stripe_event',
    ])
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

    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
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
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it.each([
    ['promotion-code field', { allow_promotion_codes: true }],
    ['discount object', { discounts: [{ promotion_code: 'promo_unsafe' }] }],
    ['discounted total', { amount_total: 4_000 }],
    ['wrong currency', { currency: 'eur' }],
    ['missing created timestamp', { created: null }],
    ['fractional created timestamp', { created: 1_699_999_940.5 }],
    ['created after Subscription', { created: 1_700_000_001 }],
    ['out-of-range created timestamp', { created: 253_402_300_800 }],
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
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
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

    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_checkout_session_id: 'cs_test_sub_current',
        p_checkout_price_id: 'price_api_starter',
      })
    )
  })

  it('passes a reservation-less historical cancellation to the sealed ledger authority', async () => {
    mockFrom.mockReturnValueOnce(
      lookupQuery(apiProfile({ api_stripe_subscription_id: 'sub_newer', api_tier: 'pro' }))
    )
    mockApplyRpcResult = { data: 'stale', error: null }
    const snapshot = apiSubscription('starter', { id: 'sub_older' })
    delete snapshot.metadata.api_tier_reservation_id

    await handleSubscriptionCanceled(snapshot, stripeEvent)

    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_stripe_subscription_id: 'sub_older',
        p_checkout_reservation_id: null,
        p_is_terminal: true,
      })
    )
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
    apiSubscriptions.set(snapshot.id, snapshot)

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
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

    await handleSubscriptionUpdate(
      apiSubscription('pro', {
        items: {
          data: [{ quantity: 1, price: { id: 'price_api_unknown_portal' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      stripeEvent
    )

    expect(mockFrom).toHaveBeenCalledWith('user_profiles')
    expect(mockListCheckoutSessions).toHaveBeenCalledWith({
      subscription: 'sub_current',
      limit: 2,
      expand: ['data.line_items'],
    })
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
    const snapshot = subscription({
      metadata: {},
      items: {
        data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    })
    apiSubscriptions.set(snapshot.id, snapshot)

    await handleSubscriptionUpdate(snapshot, stripeEvent)

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_persisted_non_grant_event',
      expect.objectContaining({
        p_stripe_price_id: 'price_api_legacy_pro',
        p_is_terminal: false,
      })
    )
  })

  it('routes a durably classified ordinary subscription directly to B2C reconciliation', async () => {
    await handleSubscriptionUpdate(
      subscription({
        items: {
          data: [{ quantity: 1, price: { id: 'price_pro_monthly' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      stripeEvent
    )

    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'classify_recurring_subscription_product_authority_atomic',
      'resolve_b2c_recurring_price_authority',
      'reconcile_b2c_subscription_event_atomic',
    ])
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

    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it.each([
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
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
  })

  it('durably reviews an event that predates its Subscription snapshot', async () => {
    await expect(
      handleSubscriptionUpdate(
        apiSubscription('starter', {
          created: 1_900_000_000,
        }),
        stripeEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'record_b2c_recurring_manual_review_atomic',
      expect.objectContaining({
        p_reason_key: 'b2c_recurring_authority:ambiguous_product',
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
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
    ).rejects.toThrow('API subscription sub_current changed plan or price without paid authority')
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
    mockFrom.mockReturnValueOnce(lookupQuery(apiProfile()))

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

  it('durably reviews a subscription whose livemode disagrees with its signed event', async () => {
    await expect(
      handleSubscriptionUpdate(
        apiSubscription('starter', {
          livemode: false,
        }),
        stripeEvent
      )
    ).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_b2c_recurring_manual_review_atomic',
      expect.objectContaining({
        p_reason_key: 'b2c_recurring_authority:ambiguous_product',
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_stripe_event'
    )
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
    const snapshot = subscription({
      status: 'canceled',
      metadata: {},
      items: {
        data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    })
    apiSubscriptions.set(snapshot.id, snapshot)

    await handleSubscriptionCanceled(snapshot, stripeEvent)

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

  it('routes a durably classified ordinary cancellation directly to B2C reconciliation', async () => {
    await handleSubscriptionCanceled(
      subscription({
        status: 'canceled',
        canceled_at: 1_799_999_000,
        items: {
          data: [{ quantity: 1, price: { id: 'price_pro_monthly' } }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      stripeEvent
    )

    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_user_api_tier_persisted_non_grant_event'
    )
    expect(mockRpc).toHaveBeenCalledWith(
      'reconcile_b2c_subscription_event_atomic',
      expect.objectContaining({
        p_stripe_subscription_id: 'sub_current',
        p_stripe_status: 'canceled',
        p_event_id: 'evt_current',
      })
    )
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

    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_user_api_tier_stripe_event',
      expect.objectContaining({
        p_stripe_subscription_id: 'sub_older',
        p_is_active: false,
        p_is_terminal: true,
      })
    )
  })

  it('fails closed when a legacy cancellation has no current API price or exact metadata', async () => {
    mockResolveSubscriptionEventStateAuthority.mockRejectedValueOnce(
      recurringAuthorityError('Canceled subscription has no exact recurring price', null)
    )

    await expect(
      handleSubscriptionCanceled(
        subscription({
          status: 'canceled',
          canceled_at: 1_799_999_000,
          metadata: {},
          items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_b2c_recurring_manual_review_atomic',
      expect.objectContaining({
        p_object_type: 'subscription_event',
        p_object_id: 'evt_current',
        p_reason_key: 'b2c_recurring_authority:ambiguous_product',
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'reconcile_b2c_subscription_event_atomic'
    )
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
    mockResolveSubscriptionEventStateAuthority.mockRejectedValueOnce(
      recurringAuthorityError(
        'Canceled subscription price is not an exact ordinary Pro price',
        'price_unknown'
      )
    )

    await expect(
      handleSubscriptionCanceled(
        subscription({
          status: 'canceled',
          canceled_at: 1_799_999_000,
          metadata: {},
          items: {
            data: [{ price: { id: 'price_unknown' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        }),
        stripeEvent
      )
    ).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_b2c_recurring_manual_review_atomic',
      expect.objectContaining({
        p_object_type: 'subscription_event',
        p_object_id: 'evt_current',
        p_reason_key: 'b2c_recurring_authority:ambiguous_product',
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'reconcile_b2c_subscription_event_atomic'
    )
  })

  it('propagates official-group persistence failure so cancellation is retried', async () => {
    mockRecurringReconcileRpcResult = {
      data: null,
      error: { message: 'atomic_leave_failed' },
    }

    await expect(
      handleSubscriptionCanceled(
        subscription({ status: 'canceled', canceled_at: 1_799_999_000 }),
        stripeEvent
      )
    ).rejects.toThrow('Recurring subscription reconciliation failed: atomic_leave_failed')
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('does not remove official-group access for a late cancellation of an older subscription', async () => {
    mockRecurringReconcileRpcResult = { data: { status: 'not_current' }, error: null }

    await expect(
      handleSubscriptionCanceled(
        subscription({ status: 'canceled', canceled_at: 1_799_999_000 }),
        stripeEvent
      )
    ).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'reconcile_b2c_subscription_event_atomic',
      expect.objectContaining({ p_stripe_subscription_id: 'sub_current' })
    )
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('does not remove lifetime official-group access when a subscription is canceled', async () => {
    mockRecurringReconcileRpcResult = {
      data: { status: 'current_entitlement_protected' },
      error: null,
    }

    await expect(
      handleSubscriptionCanceled(
        subscription({ status: 'canceled', canceled_at: 1_799_999_000 }),
        stripeEvent
      )
    ).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'reconcile_b2c_subscription_event_atomic',
      expect.objectContaining({ p_stripe_subscription_id: 'sub_current' })
    )
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('keeps the successful cancellation path intact', async () => {
    mockRecurringReconcileRpcResult = { data: { status: 'revoked' }, error: null }

    await expect(
      handleSubscriptionCanceled(
        subscription({ status: 'canceled', canceled_at: 1_799_999_000 }),
        stripeEvent
      )
    ).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'reconcile_b2c_subscription_event_atomic',
      expect.objectContaining({
        p_stripe_subscription_id: 'sub_current',
        p_stripe_status: 'canceled',
        p_event_id: 'evt_current',
      })
    )
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })
})
