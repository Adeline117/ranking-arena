import type Stripe from 'stripe'
import {
  assertRecurringProCheckoutCompleted,
  buildRecurringProCheckoutMetadata,
  parseRecurringProCheckoutMetadata,
  parseRecurringProReservation,
  verifyRecurringProCheckoutSession,
  verifyRecurringProSubscription,
  type RecurringProCheckoutIdentity,
} from './recurring-pro-checkout'

const identity: RecurringProCheckoutIdentity = {
  userId: '11aa1111-1111-4111-8111-111111111111',
  customerId: 'cus_exact_123',
  plan: 'monthly',
  priceId: 'price_exact_monthly',
  reservationId: '22222222-2222-4222-8222-222222222222',
  operationId: '33333333-3333-4333-8333-333333333333',
  nonce: '44444444-4444-4444-8444-444444444444',
  trialRequested: false,
}
const checkoutExpiresAt = 4_070_908_800

function exactSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_exact_123',
    object: 'checkout.session',
    mode: 'subscription',
    status: 'open',
    payment_status: 'unpaid',
    livemode: false,
    customer: identity.customerId,
    subscription: null,
    metadata: buildRecurringProCheckoutMetadata(identity),
    client_reference_id: identity.reservationId,
    expires_at: checkoutExpiresAt,
    currency: 'usd',
    amount_subtotal: 499,
    amount_total: 499,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    discounts: [],
    allow_promotion_codes: false,
    automatic_tax: { enabled: false },
    adaptive_pricing: { enabled: false },
    after_expiration: null,
    recovered_from: null,
    url: 'https://checkout.stripe.com/c/pay/cs_exact_123',
    ...overrides,
  } as Stripe.Checkout.Session
}

function exactLine(id = 'li_exact_123'): Stripe.LineItem {
  return {
    id,
    object: 'item',
    quantity: 1,
    currency: 'usd',
    amount_subtotal: 499,
    amount_total: 499,
    amount_discount: 0,
    amount_tax: 0,
    discounts: [],
    taxes: [],
    price: {
      id: identity.priceId,
      type: 'recurring',
      currency: 'usd',
      unit_amount: 499,
      recurring: { interval: 'month', interval_count: 1 },
    },
  } as Stripe.LineItem
}

function exactSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_exact_123',
    object: 'subscription',
    status: 'active',
    created: 1_800_000_000,
    livemode: false,
    customer: identity.customerId,
    metadata: buildRecurringProCheckoutMetadata(identity),
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
    trial_start: null,
    trial_end: null,
    current_period_start: 1_800_000_000,
    current_period_end: 1_802_592_000,
    items: {
      data: [
        {
          id: 'si_exact_123',
          object: 'subscription_item',
          quantity: 1,
          subscription: 'sub_exact_123',
          discounts: [],
          tax_rates: [],
          price: {
            id: identity.priceId,
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

function stripeWithPages(
  session: Stripe.Checkout.Session,
  pages: Array<{ data: Stripe.LineItem[]; has_more: boolean }>
) {
  const retrieve = jest.fn().mockResolvedValue(session)
  const listLineItems = jest.fn()
  for (const page of pages) listLineItems.mockResolvedValueOnce(page)
  return {
    stripe: {
      checkout: { sessions: { retrieve, listLineItems } },
    } as unknown as Stripe,
    retrieve,
    listLineItems,
  }
}

describe('recurring Pro Checkout exact authority', () => {
  it('builds and parses only the exact ten-key immutable metadata envelope', () => {
    const metadata = buildRecurringProCheckoutMetadata(identity)

    expect(Object.keys(metadata).sort()).toEqual([
      'plan',
      'pro_checkout_nonce',
      'pro_checkout_operation_id',
      'pro_checkout_reservation_id',
      'stripe_customer_id',
      'stripe_price_id',
      'supabase_user_id',
      'trial_requested',
      'type',
      'userId',
    ])
    expect(parseRecurringProCheckoutMetadata(metadata)).toEqual(identity)
    expect(parseRecurringProCheckoutMetadata({ ...metadata, unexpected: 'value' })).toBeNull()
    expect(
      parseRecurringProCheckoutMetadata({
        ...metadata,
        supabase_user_id: identity.userId.toUpperCase(),
      })
    ).toBeNull()
    expect(
      parseRecurringProCheckoutMetadata({
        ...metadata,
        stripe_customer_id: 'cus_other',
      })
    ).toEqual({ ...identity, customerId: 'cus_other' })
  })

  it('accepts only a complete, future, exact reservation response', () => {
    const reservation = {
      status: 'reserved',
      reservation_id: identity.reservationId,
      operation_id: identity.operationId,
      nonce: identity.nonce,
      user_id: identity.userId,
      livemode: false,
      stripe_customer_id: identity.customerId,
      plan: identity.plan,
      stripe_price_id: identity.priceId,
      trial_requested: false,
      checkout_expires_at: checkoutExpiresAt,
      checkout_session_id: null,
    }

    expect(parseRecurringProReservation(reservation)).toEqual({
      status: 'reserved',
      reservationId: identity.reservationId,
      operationId: identity.operationId,
      nonce: identity.nonce,
      userId: identity.userId,
      livemode: false,
      customerId: identity.customerId,
      plan: identity.plan,
      priceId: identity.priceId,
      trialRequested: false,
      checkoutExpiresAtSeconds: checkoutExpiresAt,
      checkoutSessionId: null,
    })
    expect(parseRecurringProReservation({ ...reservation, extra: true })).toBeNull()
    expect(
      parseRecurringProReservation({
        ...reservation,
        checkout_expires_at: Math.floor(Date.now() / 1000) - 1,
      })
    ).toBeNull()
  })

  it('retrieves Stripe fresh and accepts one exact fully paginated line item', async () => {
    const { stripe, retrieve, listLineItems } = stripeWithPages(exactSession(), [
      { data: [exactLine()], has_more: false },
    ])

    await expect(
      verifyRecurringProCheckoutSession({
        stripe,
        sessionId: 'cs_exact_123',
        identity,
        livemode: false,
        checkoutExpiresAtSeconds: checkoutExpiresAt,
        phase: 'open',
      })
    ).resolves.toEqual(exactSession())

    expect(retrieve).toHaveBeenCalledWith('cs_exact_123', {
      expand: ['line_items.data.price'],
    })
    expect(listLineItems).toHaveBeenCalledWith('cs_exact_123', { limit: 100 })
  })

  it('continues pagination and rejects a hidden second payable line', async () => {
    const { stripe, listLineItems } = stripeWithPages(exactSession(), [
      { data: [exactLine('li_first')], has_more: true },
      { data: [exactLine('li_hidden')], has_more: false },
    ])

    await expect(
      verifyRecurringProCheckoutSession({
        stripe,
        sessionId: 'cs_exact_123',
        identity,
        livemode: false,
        checkoutExpiresAtSeconds: checkoutExpiresAt,
        phase: 'open',
      })
    ).rejects.toThrow('failed exact verification')
    expect(listLineItems).toHaveBeenNthCalledWith(2, 'cs_exact_123', {
      limit: 100,
      starting_after: 'li_first',
    })
  })

  it.each([
    ['discount', { total_details: { amount_discount: 1, amount_shipping: 0, amount_tax: 0 } }],
    ['tax', { total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 1 } }],
    ['recovery', { recovered_from: 'cs_previous' }],
    ['promotion', { allow_promotion_codes: true }],
  ])('rejects a Session with unsafe %s state', async (_label, overrides) => {
    const { stripe } = stripeWithPages(exactSession(overrides), [
      { data: [exactLine()], has_more: false },
    ])

    await expect(
      verifyRecurringProCheckoutSession({
        stripe,
        sessionId: 'cs_exact_123',
        identity,
        livemode: false,
        checkoutExpiresAtSeconds: checkoutExpiresAt,
        phase: 'open',
      })
    ).rejects.toThrow('failed exact verification')
  })

  it('verifies exact Subscription price, ownership, status, period, and metadata', () => {
    expect(
      verifyRecurringProSubscription({
        subscription: exactSubscription(),
        subscriptionId: 'sub_exact_123',
        identity,
        livemode: false,
        eventCreated: 1_800_000_001,
      })
    ).toEqual({
      subscription: exactSubscription(),
      periodStart: '2027-01-15T08:00:00.000Z',
      periodEnd: '2027-02-14T08:00:00.000Z',
    })

    expect(() =>
      verifyRecurringProSubscription({
        subscription: exactSubscription({ customer: 'cus_other' }),
        subscriptionId: 'sub_exact_123',
        identity,
        livemode: false,
        eventCreated: 1_800_000_001,
      })
    ).toThrow('failed exact verification')
  })

  it('accepts an activated exact trial only for lifecycle verification after its full window', () => {
    const trialIdentity = { ...identity, trialRequested: true }
    const trialStart = 1_800_000_000
    const trialEnd = trialStart + 7 * 24 * 60 * 60
    const activatedTrial = exactSubscription({
      status: 'active',
      metadata: buildRecurringProCheckoutMetadata(trialIdentity),
      trial_start: trialStart,
      trial_end: trialEnd,
    })

    expect(() =>
      verifyRecurringProSubscription({
        subscription: activatedTrial,
        subscriptionId: 'sub_exact_123',
        identity: trialIdentity,
        livemode: false,
        eventCreated: trialEnd,
      })
    ).toThrow('failed exact verification')

    expect(
      verifyRecurringProSubscription({
        subscription: activatedTrial,
        subscriptionId: 'sub_exact_123',
        identity: trialIdentity,
        livemode: false,
        eventCreated: trialEnd,
        phase: 'subscription_lifecycle',
      })
    ).toEqual(
      expect.objectContaining({
        subscription: activatedTrial,
      })
    )
  })

  it.each([
    ['automatic tax', { automatic_tax: { enabled: true } }],
    ['default tax', { default_tax_rates: [{ id: 'txr_unsafe' }] }],
    ['manual invoice collection', { collection_method: 'send_invoice' }],
    ['paused collection', { pause_collection: { behavior: 'void' } }],
    ['subscription schedule', { schedule: 'sub_sched_unsafe' }],
  ])('rejects unsafe Subscription-level %s configuration', (_label, overrides) => {
    expect(() =>
      verifyRecurringProSubscription({
        subscription: exactSubscription(overrides as Partial<Stripe.Subscription>),
        subscriptionId: 'sub_exact_123',
        identity,
        livemode: false,
        eventCreated: 1_800_000_001,
      })
    ).toThrow('failed exact verification')
  })

  it('passes the locked assertion interface and accepts only scalar completed', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: 'completed', error: null, status: 200 })

    await expect(
      assertRecurringProCheckoutCompleted({
        supabase: { rpc },
        identity,
        livemode: false,
        subscriptionId: 'sub_exact_123',
      })
    ).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledWith('assert_recurring_pro_checkout_completed_atomic', {
      p_user_id: identity.userId,
      p_livemode: false,
      p_stripe_customer_id: identity.customerId,
      p_stripe_subscription_id: 'sub_exact_123',
      p_reservation_id: identity.reservationId,
      p_operation_id: identity.operationId,
      p_reservation_nonce: identity.nonce,
      p_plan: identity.plan,
      p_stripe_price_id: identity.priceId,
      p_trial_requested: false,
    })

    rpc.mockResolvedValueOnce({ data: 'identity_conflict', error: null, status: 200 })
    await expect(
      assertRecurringProCheckoutCompleted({
        supabase: { rpc },
        identity,
        livemode: false,
        subscriptionId: 'sub_exact_123',
      })
    ).rejects.toThrow('returned identity_conflict')
  })
})
