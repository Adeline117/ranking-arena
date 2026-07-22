const mockRecordStripeCheckoutManualReview = jest.fn()

jest.mock('@/lib/stripe/lifetime-entitlement', () => ({
  recordStripeCheckoutManualReview: (...args: unknown[]) =>
    mockRecordStripeCheckoutManualReview(...args),
}))

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import {
  completeTipCheckout as completeTipCheckoutImpl,
  type TipCompletionStatus,
} from '@/lib/stripe/tip-completion'

const TIP_ID = '21e34ce2-43c1-4bcc-8f19-79b36d56605c'
const SESSION_ID = 'cs_tip_123'
const CUSTOMER_ID = 'cus_tip_123'
const PAYMENT_INTENT_ID = 'pi_tip_123'
const CHARGE_ID = 'ch_tip_123'
const EVENT_ID = 'evt_tip_123'
const AMOUNT = 500
const CHARGE_CREATED = 1_800_000_000
const CHECKOUT_EXPIRES_AT = 1_800_003_600
const FROM_USER_ID = '4d97d4ef-8ff0-432c-a638-dc15959575a1'
const TO_USER_ID = '1126f050-b745-4a3f-8603-cd52473e7cd7'
const POST_ID = '3126f050-b745-4a3f-8603-cd52473e7cd7'

type Scenario = {
  session: Stripe.Checkout.Session
  paymentIntent: Stripe.PaymentIntent
  charge: Stripe.Charge
}

type CompleteTipCheckoutParams = Parameters<typeof completeTipCheckoutImpl>[0]

function completeTipCheckout(
  params: Omit<CompleteTipCheckoutParams, 'eventLivemode' | 'snapshotLivemode'> &
    Partial<Pick<CompleteTipCheckoutParams, 'eventLivemode' | 'snapshotLivemode'>>
) {
  return completeTipCheckoutImpl({
    eventLivemode: true,
    snapshotLivemode: true,
    ...params,
  })
}

function tipMetadata(overrides: Record<string, string> = {}) {
  return {
    type: 'tip',
    tip_id: TIP_ID,
    user_id: FROM_USER_ID,
    from_user_id: FROM_USER_ID,
    post_id: POST_ID,
    to_user_id: TO_USER_ID,
    amount_cents: String(AMOUNT),
    ...overrides,
  }
}

function checkoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return {
    id: SESSION_ID,
    object: 'checkout.session',
    amount_subtotal: AMOUNT,
    amount_total: AMOUNT,
    currency: 'usd',
    customer: CUSTOMER_ID,
    client_reference_id: TIP_ID,
    expires_at: CHECKOUT_EXPIRES_AT,
    livemode: true,
    metadata: tipMetadata(),
    mode: 'payment',
    invoice: null,
    payment_intent: PAYMENT_INTENT_ID,
    payment_status: 'paid',
    status: 'complete',
    subscription: null,
    after_expiration: null,
    allow_promotion_codes: false,
    automatic_tax: { enabled: false },
    adaptive_pricing: { enabled: false },
    discounts: [],
    shipping_cost: null,
    total_details: {
      amount_discount: 0,
      amount_shipping: 0,
      amount_tax: 0,
    },
    ...overrides,
  } as unknown as Stripe.Checkout.Session
}

function paymentIntent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return {
    id: PAYMENT_INTENT_ID,
    object: 'payment_intent',
    amount: AMOUNT,
    amount_received: AMOUNT,
    currency: 'usd',
    customer: CUSTOMER_ID,
    latest_charge: { id: CHARGE_ID, object: 'charge' },
    livemode: true,
    status: 'succeeded',
    ...overrides,
  } as unknown as Stripe.PaymentIntent
}

function charge(overrides: Partial<Stripe.Charge> = {}): Stripe.Charge {
  return {
    id: CHARGE_ID,
    object: 'charge',
    amount: AMOUNT,
    amount_captured: AMOUNT,
    amount_refunded: 0,
    captured: true,
    created: CHARGE_CREATED,
    currency: 'usd',
    customer: CUSTOMER_ID,
    livemode: true,
    paid: true,
    payment_intent: PAYMENT_INTENT_ID,
    refunded: false,
    status: 'succeeded',
    ...overrides,
  } as unknown as Stripe.Charge
}

function baseScenario(): Scenario {
  return {
    session: checkoutSession(),
    paymentIntent: paymentIntent(),
    charge: charge(),
  }
}

function exactRefundTombstone(refundSucceededAmount: number) {
  return {
    stripe_charge_id: CHARGE_ID,
    stripe_customer_id: CUSTOMER_ID,
    stripe_payment_intent_id: PAYMENT_INTENT_ID,
    captured: true,
    amount_paid: AMOUNT,
    currency: 'usd',
    refund_succeeded_amount: refundSucceededAmount,
  }
}

function stripeFor(scenario: Scenario): {
  stripe: Stripe
  retrieveSession: jest.Mock
  retrievePaymentIntent: jest.Mock
  retrieveCharge: jest.Mock
} {
  const retrieveSession = jest.fn(async () => scenario.session)
  const retrievePaymentIntent = jest.fn(async () => scenario.paymentIntent)
  const retrieveCharge = jest.fn(async () => scenario.charge)
  return {
    stripe: {
      checkout: { sessions: { retrieve: retrieveSession } },
      paymentIntents: { retrieve: retrievePaymentIntent },
      charges: { retrieve: retrieveCharge },
    } as unknown as Stripe,
    retrieveSession,
    retrievePaymentIntent,
    retrieveCharge,
  }
}

describe('completeTipCheckout', () => {
  const rpc = jest.fn()
  const maybeSingleTombstone = jest.fn()
  const eqTombstone = jest.fn(() => ({ maybeSingle: maybeSingleTombstone }))
  const selectTombstone = jest.fn(() => ({ eq: eqTombstone }))
  const from = jest.fn(() => ({ select: selectTombstone }))
  const supabase = { rpc, from } as unknown as SupabaseClient<Database>

  beforeEach(() => {
    jest.clearAllMocks()
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
    rpc.mockResolvedValue({ data: { status: 'completed', tip_id: TIP_ID }, error: null })
    maybeSingleTombstone.mockResolvedValue({ data: null, error: null })
  })

  it.each([
    ['test-mode signed event', false, true],
    ['test-mode signed snapshot', true, false],
    ['consistent test mode', false, false],
  ])(
    'durably reviews %s before Stripe retrieval or the completion RPC',
    async (_, eventLivemode, snapshotLivemode) => {
      const { stripe, retrieveSession, retrievePaymentIntent, retrieveCharge } =
        stripeFor(baseScenario())

      await expect(
        completeTipCheckout({
          stripe,
          supabase,
          sessionId: SESSION_ID,
          eventId: EVENT_ID,
          eventLivemode,
          snapshotLivemode,
        })
      ).resolves.toEqual({ status: 'manual_review', reviewCode: 'object_mismatch' })

      expect(retrieveSession).not.toHaveBeenCalled()
      expect(retrievePaymentIntent).not.toHaveBeenCalled()
      expect(retrieveCharge).not.toHaveBeenCalled()
      expect(rpc).not.toHaveBeenCalled()
      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          objectType: 'tip_checkout',
          sessionId: SESSION_ID,
          reasonKey: 'tip_checkout_authority:signed_mode:object_mismatch',
          context: {
            event_id: EVENT_ID,
            event_livemode: eventLivemode,
            snapshot_livemode: snapshotLivemode,
          },
        })
      )
    }
  )

  it('resolves a fresh Session -> PaymentIntent -> Charge chain and performs one atomic write', async () => {
    const scenario = baseScenario()
    const { stripe, retrieveSession, retrievePaymentIntent, retrieveCharge } = stripeFor(scenario)

    const outcome = await completeTipCheckout({
      stripe,
      supabase,
      sessionId: SESSION_ID,
      eventId: EVENT_ID,
    })

    expect(retrieveSession).toHaveBeenCalledWith(SESSION_ID)
    expect(retrievePaymentIntent).toHaveBeenCalledWith(PAYMENT_INTENT_ID, {
      expand: ['latest_charge'],
    })
    expect(retrieveCharge).toHaveBeenCalledWith(CHARGE_ID)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('complete_tip_with_stripe_ownership_atomic', {
      p_tip_id: TIP_ID,
      p_stripe_customer_id: CUSTOMER_ID,
      p_stripe_payment_intent_id: PAYMENT_INTENT_ID,
      p_stripe_charge_id: CHARGE_ID,
      p_checkout_session_id: SESSION_ID,
      p_amount_paid: AMOUNT,
      p_currency: 'usd',
      p_completed_at: '2027-01-15T08:00:00.000Z',
      p_client_reference_id: TIP_ID,
      p_metadata_user_id: FROM_USER_ID,
      p_metadata_from_user_id: FROM_USER_ID,
      p_metadata_post_id: POST_ID,
      p_metadata_to_user_id: TO_USER_ID,
      p_metadata_amount_cents: AMOUNT,
      p_checkout_expires_at: new Date(CHECKOUT_EXPIRES_AT * 1000).toISOString(),
      p_event_id: EVENT_ID,
    })
    expect(outcome).toEqual({
      status: 'completed',
      authority: {
        tipId: TIP_ID,
        clientReferenceId: TIP_ID,
        metadataUserId: FROM_USER_ID,
        metadataFromUserId: FROM_USER_ID,
        metadataPostId: POST_ID,
        metadataToUserId: TO_USER_ID,
        metadataAmountCents: AMOUNT,
        sessionId: SESSION_ID,
        checkoutExpiresAt: new Date(CHECKOUT_EXPIRES_AT * 1000).toISOString(),
        customerId: CUSTOMER_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
        chargeId: CHARGE_ID,
        amount: AMOUNT,
        currency: 'usd',
        completedAt: '2027-01-15T08:00:00.000Z',
        refundSucceededAmount: 0,
        fullyRefunded: false,
      },
      result: { status: 'completed', tip_id: TIP_ID },
    })
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
  })

  it.each<TipCompletionStatus>([
    'completed',
    'already_completed',
    'refunded',
    'identity_conflict',
    'manual_review',
    'notification_suppressed',
  ])('accepts the durable terminal RPC status %s', async (status) => {
    const scenario = baseScenario()
    const data =
      status === 'completed' || status === 'already_completed'
        ? { status, tip_id: TIP_ID }
        : status === 'refunded'
          ? { status, tip_id: TIP_ID }
          : status === 'notification_suppressed'
            ? {
                status,
                completion_status: 'completed',
                tip_status: 'completed',
                notification_status: 'suppressed',
                reason_key: 'tip_notification_recipient_deleted',
              }
            : { status }
    if (status === 'refunded') {
      scenario.charge = charge({ amount_refunded: AMOUNT, refunded: true })
      maybeSingleTombstone.mockResolvedValue({
        data: exactRefundTombstone(AMOUNT),
        error: null,
      })
    }
    rpc.mockResolvedValue({ data, error: null })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toMatchObject({
      status,
      authority: { tipId: TIP_ID },
      result: data,
    })
  })

  it('durably reviews a fresh Checkout Session id mismatch without following stale references', async () => {
    const scenario = baseScenario()
    scenario.session = checkoutSession({ id: 'cs_different' })
    const { stripe, retrievePaymentIntent } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toEqual({
      status: 'manual_review',
      reviewCode: 'object_mismatch',
    })
    expect(retrievePaymentIntent).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'tip_checkout',
        sessionId: SESSION_ID,
        userId: null,
        reasonKey: 'tip_checkout_authority:checkout_session:object_mismatch',
      })
    )
  })

  it.each(['session', 'payment_intent', 'charge'])(
    'durably reviews an exact %s resource_missing response',
    async (stage) => {
      const scenario = baseScenario()
      const { stripe, retrieveSession, retrievePaymentIntent, retrieveCharge } = stripeFor(scenario)
      const missing = {
        name: 'StripeInvalidRequestError',
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        statusCode: 404,
      }
      if (stage === 'session') retrieveSession.mockRejectedValue(missing)
      if (stage === 'payment_intent') retrievePaymentIntent.mockRejectedValue(missing)
      if (stage === 'charge') retrieveCharge.mockRejectedValue(missing)

      await expect(
        completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
      ).resolves.toEqual({ status: 'manual_review', reviewCode: 'resource_missing' })
      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          objectType: 'tip_checkout',
          sessionId: SESSION_ID,
          userId: null,
          reasonKey: expect.stringMatching(
            /^tip_checkout_authority:(checkout_session|payment_intent|charge):resource_missing$/
          ),
        })
      )
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['rate limit', { code: 'rate_limit', statusCode: 429 }],
    ['server failure', { code: 'api_error', statusCode: 503 }],
    [
      'resource_missing-shaped 5xx',
      {
        code: 'resource_missing',
        statusCode: 503,
        type: 'StripeInvalidRequestError',
      },
    ],
    ['timeout', new Error('Stripe request timed out')],
  ])('rethrows a technical Stripe %s for webhook retry', async (_label, failure) => {
    const { stripe, retrieveSession } = stripeFor(baseScenario())
    retrieveSession.mockRejectedValue(failure)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toBe(failure)
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('uses the immutable signed event id when the Checkout Session id is malformed', async () => {
    const { stripe, retrieveSession } = stripeFor(baseScenario())

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: 'bad-session-id', eventId: EVENT_ID })
    ).resolves.toEqual({ status: 'manual_review', reviewCode: 'invalid_object' })
    expect(retrieveSession).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'tip_checkout',
        sessionId: EVENT_ID,
        userId: null,
      })
    )
  })

  it.each([undefined, null])(
    'uses the immutable signed event id when the Checkout Session id is %s',
    async (sessionId) => {
      const { stripe, retrieveSession } = stripeFor(baseScenario())

      await expect(
        completeTipCheckout({
          stripe,
          supabase,
          sessionId: sessionId as unknown as string,
          eventId: EVENT_ID,
        })
      ).resolves.toEqual({ status: 'manual_review', reviewCode: 'invalid_object' })
      expect(retrieveSession).not.toHaveBeenCalled()
      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          objectType: 'tip_checkout',
          sessionId: EVENT_ID,
          userId: null,
        })
      )
    }
  )

  it('retries instead of colliding on a constant when no immutable review id exists', async () => {
    const { stripe } = stripeFor(baseScenario())

    await expect(
      completeTipCheckout({
        stripe,
        supabase,
        sessionId: 'bad-session-id',
        eventId: 'bad-event-id',
      })
    ).rejects.toThrow('Tip checkout has no immutable Stripe identity for durable review')
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each([
    ['mode', { mode: 'subscription' }],
    ['completion status', { status: 'open' }],
    ['payment status', { payment_status: 'unpaid' }],
    ['product type', { metadata: tipMetadata({ type: 'group' }) }],
    ['subscription presence', { subscription: 'sub_wrong' }],
  ] as Array<[string, Partial<Stripe.Checkout.Session>]>)(
    'durably reviews an invalid tip Checkout Session %s',
    async (_label, overrides) => {
      const scenario = baseScenario()
      scenario.session = checkoutSession(overrides)
      const { stripe } = stripeFor(scenario)

      await expect(
        completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
      ).resolves.toEqual({ status: 'manual_review', reviewCode: 'invalid_session_state' })
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['missing', undefined, 'identity_missing'],
    ['non-UUID', 'tip-123', 'identity_invalid'],
    ['non-canonical uppercase', TIP_ID.toUpperCase(), 'identity_invalid'],
  ])('durably reviews a %s tip_id', async (_label, tipId, reviewCode) => {
    const scenario = baseScenario()
    const invalidMetadata: Record<string, string> = tipMetadata(tipId ? { tip_id: tipId } : {})
    if (!tipId) delete invalidMetadata.tip_id
    scenario.session = checkoutSession({
      metadata: invalidMetadata,
    })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toEqual({
      status: 'manual_review',
      reviewCode,
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['user/from conflict', { metadata: tipMetadata({ user_id: TO_USER_ID }) }, 'identity_conflict'],
    [
      'post snapshot identity',
      { metadata: tipMetadata({ post_id: 'not-a-uuid' }) },
      'identity_invalid',
    ],
    [
      'extra mutable metadata',
      { metadata: tipMetadata({ creator_handle: 'mutable' }) },
      'identity_invalid',
    ],
    ['client reference', { client_reference_id: TO_USER_ID }, 'object_mismatch'],
    ['unsafe expiry', { expires_at: Number.MAX_SAFE_INTEGER }, 'invalid_object'],
  ] as Array<[string, Partial<Stripe.Checkout.Session>, string]>)(
    'durably reviews Checkout %s drift before the DB transition',
    async (_label, overrides, reviewCode) => {
      const scenario = baseScenario()
      scenario.session = checkoutSession(overrides)
      const { stripe } = stripeFor(scenario)

      await expect(
        completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
      ).resolves.toEqual({ status: 'manual_review', reviewCode })
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it('passes a null client reference only as an exact legacy compatibility candidate', async () => {
    const scenario = baseScenario()
    scenario.session = checkoutSession({ client_reference_id: null })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toMatchObject({
      status: 'completed',
      authority: { clientReferenceId: null },
    })
    expect(rpc).toHaveBeenCalledWith(
      'complete_tip_with_stripe_ownership_atomic',
      expect.objectContaining({
        p_client_reference_id: null,
        p_checkout_expires_at: new Date(CHECKOUT_EXPIRES_AT * 1000).toISOString(),
      })
    )
  })

  it('durably reviews a non-succeeded PaymentIntent', async () => {
    const scenario = baseScenario()
    scenario.paymentIntent = paymentIntent({ status: 'processing' })
    const { stripe, retrieveCharge } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toEqual({
      status: 'manual_review',
      reviewCode: 'invalid_payment_state',
    })
    expect(retrieveCharge).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['unpaid', { paid: false }],
    ['uncaptured', { captured: false }],
    ['non-succeeded', { status: 'failed' }],
  ] as Array<[string, Partial<Stripe.Charge>]>)(
    'durably reviews a %s Charge',
    async (_label, overrides) => {
      const scenario = baseScenario()
      scenario.charge = charge(overrides)
      const { stripe } = stripeFor(scenario)

      await expect(
        completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
      ).resolves.toEqual({ status: 'manual_review', reviewCode: 'invalid_payment_state' })
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['PaymentIntent customer', () => paymentIntent({ customer: 'cus_other' })],
    ['PaymentIntent id', () => paymentIntent({ id: 'pi_other' })],
    ['Charge customer', () => charge({ customer: 'cus_other' })],
    ['Charge PaymentIntent', () => charge({ payment_intent: 'pi_other' })],
    ['Charge id', () => charge({ id: 'ch_other' })],
  ])('durably reviews a mismatched %s relationship', async (label, mismatched) => {
    const scenario = baseScenario()
    if (label.startsWith('PaymentIntent'))
      scenario.paymentIntent = mismatched() as Stripe.PaymentIntent
    else scenario.charge = mismatched() as Stripe.Charge
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toEqual({
      status: 'manual_review',
      reviewCode: 'object_mismatch',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('durably reviews an internally consistent test-mode payment chain', async () => {
    const scenario = baseScenario()
    scenario.session = checkoutSession({ livemode: false })
    scenario.paymentIntent = paymentIntent({ livemode: false })
    scenario.charge = charge({ livemode: false })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toEqual({
      status: 'manual_review',
      reviewCode: 'object_mismatch',
    })
    expect(rpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'tip_checkout_authority:charge:object_mismatch',
      })
    )
  })

  it.each([
    [
      'session subtotal',
      (scenario: Scenario) => (scenario.session = checkoutSession({ amount_subtotal: 499 })),
    ],
    [
      'PaymentIntent received',
      (scenario: Scenario) => (scenario.paymentIntent = paymentIntent({ amount_received: 499 })),
    ],
    [
      'Charge captured',
      (scenario: Scenario) => (scenario.charge = charge({ amount_captured: 499 })),
    ],
    [
      'metadata amount',
      (scenario: Scenario) =>
        (scenario.session = checkoutSession({
          metadata: tipMetadata({ amount_cents: '499' }),
        })),
    ],
    [
      'unsafe amount',
      (scenario: Scenario) => (scenario.charge = charge({ amount: Number.MAX_SAFE_INTEGER + 1 })),
    ],
    [
      'discount adjustment',
      (scenario: Scenario) =>
        (scenario.session = checkoutSession({
          total_details: { amount_discount: 1, amount_shipping: 0, amount_tax: 0 },
        })),
    ],
  ] as Array<[string, (scenario: Scenario) => unknown]>)(
    'durably reviews a mismatched or unsafe %s',
    async (_label, mutate) => {
      const scenario = baseScenario()
      mutate(scenario)
      const { stripe } = stripeFor(scenario)

      await expect(
        completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
      ).resolves.toEqual({ status: 'manual_review', reviewCode: 'amount_mismatch' })
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['currency mismatch', () => paymentIntent({ currency: 'eur' })],
    ['malformed currency', () => paymentIntent({ currency: 'USd' })],
  ])('durably reviews a %s', async (_label, changedPaymentIntent) => {
    const scenario = baseScenario()
    scenario.paymentIntent = changedPaymentIntent()
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toEqual({
      status: 'manual_review',
      reviewCode: 'currency_mismatch',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('durably reviews a consistently non-USD Tip payment', async () => {
    const scenario = baseScenario()
    scenario.session = checkoutSession({ currency: 'eur' })
    scenario.paymentIntent = paymentIntent({ currency: 'eur' })
    scenario.charge = charge({ currency: 'eur' })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toEqual({ status: 'manual_review', reviewCode: 'currency_mismatch' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['negative amount', { amount_refunded: -1, refunded: false }],
    ['unsafe amount', { amount_refunded: Number.MAX_SAFE_INTEGER + 1, refunded: false }],
    ['partial marked fully refunded', { amount_refunded: 100, refunded: true }],
    ['full amount not marked refunded', { amount_refunded: AMOUNT, refunded: false }],
  ] as Array<[string, Partial<Stripe.Charge>]>)(
    'durably reviews an inconsistent Charge refund shape: %s',
    async (_label, overrides) => {
      const scenario = baseScenario()
      scenario.charge = charge(overrides)
      const { stripe } = stripeFor(scenario)

      await expect(
        completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
      ).resolves.toEqual({ status: 'manual_review', reviewCode: 'amount_mismatch' })
      expect(from).not.toHaveBeenCalled()
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it('requires an exact durable tombstone before completing a partially refunded Charge', async () => {
    const scenario = baseScenario()
    scenario.charge = charge({ amount_refunded: 100, refunded: false })
    maybeSingleTombstone.mockResolvedValue({ data: exactRefundTombstone(100), error: null })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toMatchObject({
      status: 'completed',
      authority: { refundSucceededAmount: 100, fullyRefunded: false },
    })
    expect(from).toHaveBeenCalledWith('stripe_charge_refund_tombstones')
    expect(selectTombstone).toHaveBeenCalledWith(
      'stripe_charge_id,stripe_customer_id,stripe_payment_intent_id,captured,amount_paid,currency,refund_succeeded_amount'
    )
    expect(eqTombstone).toHaveBeenCalledWith('stripe_charge_id', CHARGE_ID)
    expect(rpc).toHaveBeenCalledWith(
      'complete_tip_with_stripe_ownership_atomic',
      expect.objectContaining({ p_stripe_charge_id: CHARGE_ID })
    )
  })

  it('absorbs an exactly converged full-refund tombstone and requires refunded completion', async () => {
    const scenario = baseScenario()
    scenario.charge = charge({ amount_refunded: AMOUNT, refunded: true })
    maybeSingleTombstone.mockResolvedValue({ data: exactRefundTombstone(AMOUNT), error: null })
    rpc.mockResolvedValue({ data: { status: 'refunded', tip_id: TIP_ID }, error: null })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toMatchObject({
      status: 'refunded',
      authority: { refundSucceededAmount: AMOUNT, fullyRefunded: true },
    })
  })

  it('retries while a fresh refund has no durable tombstone yet', async () => {
    const scenario = baseScenario()
    scenario.charge = charge({ amount_refunded: 100, refunded: false })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow(`Fresh Charge ${CHARGE_ID} refund authority has not durably converged`)
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('retries when the refund tombstone read fails', async () => {
    const scenario = baseScenario()
    scenario.charge = charge({ amount_refunded: 100, refunded: false })
    maybeSingleTombstone.mockResolvedValue({
      data: null,
      error: { message: 'tombstone database unavailable' },
    })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow(
      'Failed to verify durable Charge refund convergence: tombstone database unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['customer', { stripe_customer_id: 'cus_other' }],
    ['PaymentIntent', { stripe_payment_intent_id: 'pi_other' }],
    ['captured flag', { captured: false }],
    ['amount paid', { amount_paid: AMOUNT - 1 }],
    ['currency', { currency: 'eur' }],
    ['refund aggregate', { refund_succeeded_amount: 99 }],
  ])('retries when the durable refund tombstone mismatches %s', async (_label, mismatch) => {
    const scenario = baseScenario()
    scenario.charge = charge({ amount_refunded: 100, refunded: false })
    maybeSingleTombstone.mockResolvedValue({
      data: { ...exactRefundTombstone(100), ...mismatch },
      error: null,
    })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow(`Fresh Charge ${CHARGE_ID} refund authority has not durably converged`)
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('durably reviews an unsafe Charge timestamp instead of inventing completion time', async () => {
    const scenario = baseScenario()
    scenario.charge = charge({ created: Number.MAX_SAFE_INTEGER })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).resolves.toEqual({
      status: 'manual_review',
      reviewCode: 'invalid_object',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each(['session', 'payment_intent', 'charge'])(
    'rethrows a transient %s retrieval failure without acknowledging or reviewing',
    async (stage) => {
      const scenario = baseScenario()
      const { stripe, retrieveSession, retrievePaymentIntent, retrieveCharge } = stripeFor(scenario)
      const failure = new Error(`temporary ${stage} outage`)
      if (stage === 'session') retrieveSession.mockRejectedValue(failure)
      if (stage === 'payment_intent') retrievePaymentIntent.mockRejectedValue(failure)
      if (stage === 'charge') retrieveCharge.mockRejectedValue(failure)

      await expect(
        completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
      ).rejects.toBe(failure)
      expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it('rethrows when a deterministic conflict cannot be durably recorded', async () => {
    const scenario = baseScenario()
    scenario.paymentIntent = paymentIntent({ status: 'processing' })
    const { stripe } = stripeFor(scenario)
    mockRecordStripeCheckoutManualReview.mockRejectedValue(
      new Error('manual review database unavailable')
    )

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow('manual review database unavailable')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rethrows an atomic RPC response error so Stripe retries', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })
    const { stripe } = stripeFor(baseScenario())

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow('Failed to complete tip atomically: database unavailable')
  })

  it('rethrows an atomic RPC network failure unchanged', async () => {
    const failure = new Error('RPC network unavailable')
    rpc.mockRejectedValue(failure)
    const { stripe } = stripeFor(baseScenario())

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toBe(failure)
  })

  it.each([
    ['null', null],
    ['array', [{ status: 'completed' }]],
    ['missing status', { tip_id: TIP_ID }],
  ])('rejects the unknown RPC result shape %s', async (_label, data) => {
    rpc.mockResolvedValue({ data, error: null })
    const { stripe } = stripeFor(baseScenario())

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow('complete_tip_with_stripe_ownership_atomic returned an invalid result')
  })

  it('rejects an unknown RPC status', async () => {
    rpc.mockResolvedValue({ data: { status: 'not_found' }, error: null })
    const { stripe } = stripeFor(baseScenario())

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow(
      'complete_tip_with_stripe_ownership_atomic returned unexpected status not_found'
    )
  })

  it.each(['completed', 'already_completed', 'refunded'])(
    'rejects %s without the exact canonical tip identity',
    async (status) => {
      const scenario = baseScenario()
      if (status === 'refunded') {
        scenario.charge = charge({ amount_refunded: AMOUNT, refunded: true })
        maybeSingleTombstone.mockResolvedValue({
          data: exactRefundTombstone(AMOUNT),
          error: null,
        })
      }
      rpc.mockResolvedValue({ data: { status, tip_id: 'wrong-tip-id' }, error: null })
      const { stripe } = stripeFor(scenario)

      await expect(
        completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
      ).rejects.toThrow(
        `complete_tip_with_stripe_ownership_atomic returned ${status} without exact tip identity`
      )
    }
  )

  it('rejects a malformed deleted-authority notification suppression result', async () => {
    rpc.mockResolvedValue({
      data: {
        status: 'notification_suppressed',
        completion_status: 'completed',
        notification_status: 'suppressed',
      },
      error: null,
    })
    const { stripe } = stripeFor(baseScenario())

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow(
      'complete_tip_with_stripe_ownership_atomic returned an invalid notification suppression result'
    )
  })

  it('rejects a completed acknowledgement after exact full-refund convergence', async () => {
    const scenario = baseScenario()
    scenario.charge = charge({ amount_refunded: AMOUNT, refunded: true })
    maybeSingleTombstone.mockResolvedValue({ data: exactRefundTombstone(AMOUNT), error: null })
    rpc.mockResolvedValue({ data: { status: 'completed', tip_id: TIP_ID }, error: null })
    const { stripe } = stripeFor(scenario)

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow(
      'complete_tip_with_stripe_ownership_atomic did not preserve the fully refunded Charge state'
    )
  })

  it('rejects refunded without fresh Charge refund authority', async () => {
    rpc.mockResolvedValue({ data: { status: 'refunded', tip_id: TIP_ID }, error: null })
    const { stripe } = stripeFor(baseScenario())

    await expect(
      completeTipCheckout({ stripe, supabase, sessionId: SESSION_ID, eventId: EVENT_ID })
    ).rejects.toThrow(
      'complete_tip_with_stripe_ownership_atomic returned refunded without fresh Charge authority'
    )
  })
})
