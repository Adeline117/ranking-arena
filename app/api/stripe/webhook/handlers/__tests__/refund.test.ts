import type Stripe from 'stripe'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockRetrieveCharge = jest.fn()
const mockRetrieveRefund = jest.fn()
const mockListRefunds = jest.fn()
const mockRetrievePaymentIntent = jest.fn()
const mockRetrieveSubscription = jest.fn()
const mockLoggerInfo = jest.fn()
const mockLoggerWarn = jest.fn()

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  },
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    charges: {
      retrieve: (...args: unknown[]) => mockRetrieveCharge(...args),
    },
    refunds: {
      retrieve: (...args: unknown[]) => mockRetrieveRefund(...args),
      list: (...args: unknown[]) => mockListRefunds(...args),
    },
    paymentIntents: {
      retrieve: (...args: unknown[]) => mockRetrievePaymentIntent(...args),
    },
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args),
    },
  }),
}))

import {
  handleChargeRefunded,
  handleRefundLifecycle,
  type StripeRefundEventContext,
} from '../refund'

type DbError = { message: string }

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111'
const OWNERSHIP_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'

const refundEvent: StripeRefundEventContext = {
  eventId: 'evt_charge_refunded',
  eventCreatedAt: 1_700_000_000,
}

function paymentLookup(data: unknown, error: DbError | null = null) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(async () => ({ data, error })),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function refundedCharge(overrides: Partial<Stripe.Charge> = {}): Stripe.Charge {
  return {
    id: 'ch_refunded',
    object: 'charge',
    amount: 2500,
    amount_captured: 2500,
    amount_refunded: 2500,
    captured: true,
    created: 1_699_999_000,
    currency: 'usd',
    customer: 'cus_owner',
    paid: true,
    payment_intent: 'pi_refunded',
    refunded: true,
    status: 'succeeded',
    ...overrides,
  } as Stripe.Charge
}

function refundObject(overrides: Partial<Stripe.Refund> = {}): Stripe.Refund {
  return {
    id: 're_updated',
    object: 'refund',
    amount: 500,
    charge: 'ch_refunded',
    created: 1_699_999_500,
    currency: 'usd',
    metadata: {},
    payment_intent: 'pi_refunded',
    reason: null,
    receipt_number: null,
    source_transfer_reversal: null,
    status: 'pending',
    transfer_reversal: null,
    ...overrides,
  } as Stripe.Refund
}

function refundPage(data: Stripe.Refund[], hasMore = false) {
  return {
    object: 'list',
    url: '/v1/refunds',
    data,
    has_more: hasMore,
  }
}

function mockOneRefundPage(...refunds: Stripe.Refund[]) {
  mockListRefunds.mockResolvedValueOnce(refundPage(refunds))
}

function recurringPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    user_id: USER_ID,
    stripe_customer_id: 'cus_owner',
    payment_kind: 'recurring',
    plan: 'monthly',
    stripe_subscription_id: 'sub_owner',
    stripe_invoice_id: 'in_owner',
    stripe_payment_intent_id: null,
    stripe_charge_id: 'ch_refunded',
    checkout_session_id: null,
    amount_paid: 2500,
    currency: 'usd',
    period_start: '2026-07-01T00:00:00.000Z',
    period_end: '2026-08-01T00:00:00.000Z',
    payment_status: 'paid',
    ...overrides,
  }
}

function lifetimePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    user_id: USER_ID,
    stripe_customer_id: 'cus_owner',
    payment_kind: 'lifetime',
    plan: 'lifetime',
    stripe_subscription_id: null,
    stripe_invoice_id: null,
    stripe_payment_intent_id: 'pi_refunded',
    stripe_charge_id: 'ch_refunded',
    checkout_session_id: 'cs_lifetime',
    amount_paid: 2500,
    currency: 'usd',
    period_start: '2026-07-01T00:00:00.000Z',
    period_end: null,
    payment_status: 'succeeded',
    ...overrides,
  }
}

function proAcknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    status: 'payment_reconciliation_required',
    entitlement_payment_id: PAYMENT_ID,
    ownership_status: 'already_claimed',
    ownership_id: OWNERSHIP_ID,
    product_kind: 'pro_entitlement',
    projection_status: 'no_tombstone',
    ...overrides,
  }
}

function nonEntitlementAcknowledgement(
  kind: 'group_pass' | 'tip',
  overrides: Record<string, unknown> = {}
) {
  return {
    status: 'recorded',
    ownership_status: 'already_claimed',
    ownership_id: OWNERSHIP_ID,
    product_kind: kind,
    projection_status: 'resolved',
    ...overrides,
  }
}

function configureRpc(
  options: {
    reconciliationData?: unknown
    reconciliationError?: DbError | null
    tombstoneData?: unknown
    tombstoneError?: DbError | null
    manualReviewData?: unknown
    manualReviewError?: DbError | null
  } = {}
) {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'reconcile_stripe_entitlement_refund_atomic') {
      return Promise.resolve({
        data: options.reconciliationData ?? { status: 'revoked' },
        error: options.reconciliationError ?? null,
      })
    }
    if (name === 'record_charge_refund_tombstone_atomic') {
      return Promise.resolve({
        data:
          options.tombstoneData ??
          ({ status: 'recorded', ownership_status: 'unclassified' } as const),
        error: options.tombstoneError ?? null,
      })
    }
    if (name === 'record_stripe_manual_review_atomic') {
      return Promise.resolve({
        data: options.manualReviewData ?? { status: 'recorded' },
        error: options.manualReviewError ?? null,
      })
    }
    throw new Error('Unexpected RPC ' + name)
  })
}

function expectNoDatabaseWrite() {
  expect(mockRpc).not.toHaveBeenCalled()
  expect(mockFrom).not.toHaveBeenCalled()
}

describe('refund webhook product ownership routing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockFrom.mockImplementation((table: string) => {
      throw new Error('Unexpected broad refund lookup: ' + table)
    })
    mockRpc.mockReset()
    mockRetrieveCharge.mockReset()
    mockRetrieveRefund.mockReset()
    mockListRefunds.mockReset()
    mockRetrievePaymentIntent.mockReset()
    mockRetrieveSubscription.mockReset()

    mockRetrieveCharge.mockResolvedValue(refundedCharge())
    mockRetrieveRefund.mockResolvedValue(refundObject())
    mockListRefunds.mockResolvedValue(
      refundPage([
        refundObject({
          id: 're_legacy_authority',
          amount: 2500,
          status: 'succeeded',
        }),
      ])
    )
    mockRetrievePaymentIntent.mockResolvedValue({
      id: 'pi_refunded',
      latest_charge: 'ch_refunded',
    } as Stripe.PaymentIntent)
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_owner',
      customer: 'cus_owner',
      status: 'active',
    })
    configureRpc()
  })

  it('keeps legacy charge.refunded on the fresh succeeded-Refund authority chain', async () => {
    await handleChargeRefunded(refundedCharge(), refundEvent)

    expect(mockRetrieveCharge).toHaveBeenCalledWith('ch_refunded')
    expect(mockListRefunds).toHaveBeenCalledWith({ charge: 'ch_refunded', limit: 100 })
    expect(mockRpc).toHaveBeenCalledWith(
      'record_charge_refund_tombstone_atomic',
      expect.objectContaining({
        p_stripe_charge_id: 'ch_refunded',
        p_refund_succeeded_amount: 2500,
        p_refund_state: 'succeeded',
      })
    )
  })

  it('records first, finds Pro by exact payment id, and reconciles a PI-null recurring payment', async () => {
    const charge = refundedCharge({ payment_intent: null })
    const lookup = paymentLookup(recurringPayment())
    mockRetrieveCharge.mockResolvedValueOnce(charge)
    mockOneRefundPage(
      refundObject({
        id: 're_legacy_pi_null',
        amount: 2500,
        payment_intent: null,
        status: 'succeeded',
      })
    )
    mockFrom.mockReturnValueOnce(lookup)
    configureRpc({ tombstoneData: proAcknowledgement() })

    await handleChargeRefunded(charge, refundEvent)

    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'record_charge_refund_tombstone_atomic',
      'reconcile_stripe_entitlement_refund_atomic',
    ])
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockFrom.mock.invocationCallOrder[0])
    expect(mockFrom).toHaveBeenCalledWith('stripe_entitlement_payments')
    expect(lookup.eq).toHaveBeenCalledTimes(1)
    expect(lookup.eq).toHaveBeenCalledWith('id', PAYMENT_ID)
    expect(mockRetrieveSubscription).toHaveBeenCalledWith('sub_owner')
    expect(mockRpc).toHaveBeenLastCalledWith('reconcile_stripe_entitlement_refund_atomic', {
      p_user_id: USER_ID,
      p_stripe_customer_id: 'cus_owner',
      p_payment_kind: 'recurring',
      p_plan: 'monthly',
      p_stripe_subscription_id: 'sub_owner',
      p_stripe_invoice_id: 'in_owner',
      p_stripe_payment_intent_id: null,
      p_stripe_charge_id: 'ch_refunded',
      p_checkout_session_id: null,
      p_amount_paid: 2500,
      p_currency: 'usd',
      p_period_start: '2026-07-01T00:00:00.000Z',
      p_period_end: '2026-08-01T00:00:00.000Z',
      p_payment_status: 'paid',
      p_refund_succeeded_amount: 2500,
      p_refund_state: 'succeeded',
      p_stripe_subscription_status: 'active',
      p_refund_event_id: 'evt_charge_refunded',
      p_refund_event_created_at: '2023-11-14T22:13:20.000Z',
    })
  })

  it('accepts an exact Pro no_tombstone acknowledgement', async () => {
    const lookup = paymentLookup(lifetimePayment())
    mockFrom.mockReturnValueOnce(lookup)
    configureRpc({ tombstoneData: proAcknowledgement() })

    await expect(handleChargeRefunded(refundedCharge(), refundEvent)).resolves.toBeUndefined()

    expect(lookup.eq).toHaveBeenCalledWith('id', PAYMENT_ID)
    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenLastCalledWith(
      'reconcile_stripe_entitlement_refund_atomic',
      expect.objectContaining({
        p_payment_kind: 'lifetime',
        p_checkout_session_id: 'cs_lifetime',
        p_stripe_subscription_status: null,
      })
    )
  })

  it.each(['tip', 'group_pass'] as const)(
    'projects an exact %s acknowledgement without touching Pro',
    async (productKind) => {
      configureRpc({ tombstoneData: nonEntitlementAcknowledgement(productKind) })

      await handleChargeRefunded(refundedCharge(), refundEvent)

      expect(mockFrom).not.toHaveBeenCalled()
      expect(mockRetrieveSubscription).not.toHaveBeenCalled()
      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'Charge refund projected through exact non-entitlement ownership',
        expect.objectContaining({ productKind, projectionStatus: 'resolved' })
      )
    }
  )

  it('ACKs an exact durable group-pass revocation review', async () => {
    configureRpc({
      tombstoneData: {
        status: 'manual_review',
        record_status: 'recorded',
        ownership_id: OWNERSHIP_ID,
        product_kind: 'group_pass',
        reason_key: 'group_pass_full_refund_revocation_required',
      },
    })

    await expect(handleChargeRefunded(refundedCharge(), refundEvent)).resolves.toBeUndefined()

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Charge refund reached a durable review state',
      expect.objectContaining({ productKind: 'group_pass', status: 'manual_review' })
    )
  })

  it('accepts an opaque Refund id and a direct Charge when payment_intent is null', async () => {
    const opaqueRefund = refundObject({
      id: 'pyr_1234',
      payment_intent: null,
      status: 'failed',
    })
    mockRetrieveRefund.mockResolvedValueOnce(opaqueRefund)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 0, payment_intent: null, refunded: false })
    )
    mockOneRefundPage(opaqueRefund)

    await handleRefundLifecycle(
      refundObject({
        id: 'pyr_1234',
        amount: -1,
        charge: null,
        payment_intent: null,
      }),
      refundEvent
    )

    expect(mockRetrieveRefund).toHaveBeenCalledWith('pyr_1234')
    expect(mockRetrievePaymentIntent).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_charge_refund_tombstone_atomic',
      expect.objectContaining({ p_refund_succeeded_amount: 0, p_refund_state: 'failed' })
    )
  })

  it('resolves a charge-null Refund through the fresh PaymentIntent latest_charge', async () => {
    const freshRefund = refundObject({ charge: null, status: 'pending' })
    mockRetrieveRefund.mockResolvedValueOnce(freshRefund)
    mockRetrievePaymentIntent.mockResolvedValueOnce({
      id: 'pi_refunded',
      latest_charge: 'ch_refunded',
    } as Stripe.PaymentIntent)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 0, refunded: false })
    )
    mockOneRefundPage(freshRefund)

    await handleRefundLifecycle(refundObject(), refundEvent)

    expect(mockRetrievePaymentIntent).toHaveBeenCalledWith('pi_refunded')
    expect(mockRetrieveCharge).toHaveBeenCalledWith('ch_refunded')
    expect(mockRpc).toHaveBeenCalledWith(
      'record_charge_refund_tombstone_atomic',
      expect.objectContaining({ p_refund_succeeded_amount: 0, p_refund_state: 'pending' })
    )
  })

  it('durably reviews a fresh Refund with neither Charge nor PaymentIntent authority', async () => {
    mockRetrieveRefund.mockResolvedValueOnce(refundObject({ charge: null, payment_intent: null }))

    await expect(handleRefundLifecycle(refundObject(), refundEvent)).resolves.toBeUndefined()

    expect(mockRetrievePaymentIntent).not.toHaveBeenCalled()
    expect(mockRetrieveCharge).not.toHaveBeenCalled()
    expect(mockListRefunds).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith(
      'record_stripe_manual_review_atomic',
      expect.objectContaining({
        p_object_type: 'refund',
        p_object_id: 're_updated',
        p_reason_key: 'refund_without_charge_authority',
      })
    )
  })

  it('treats the signed Refund as a locator only and uses fresh Stripe authority', async () => {
    const signedStale = refundObject({
      amount: -999,
      charge: 'ch_stale',
      currency: 'ZZZ',
      payment_intent: 'pi_stale',
      status: 'failed',
    })
    const freshRefund = refundObject({ payment_intent: null, status: 'pending' })
    mockRetrieveRefund.mockResolvedValueOnce(freshRefund)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 0, payment_intent: null, refunded: false })
    )
    mockOneRefundPage(freshRefund)

    await handleRefundLifecycle(signedStale, refundEvent)

    expect(mockRetrieveRefund).toHaveBeenCalledWith('re_updated')
    expect(mockRetrieveCharge).toHaveBeenCalledWith('ch_refunded')
    expect(mockRpc).toHaveBeenCalledWith(
      'record_charge_refund_tombstone_atomic',
      expect.objectContaining({
        p_stripe_payment_intent_id: null,
        p_refund_succeeded_amount: 0,
        p_refund_state: 'pending',
      })
    )
  })

  it('paginates exactly and sums only succeeded Refunds', async () => {
    const trigger = refundObject({ id: 're_trigger', amount: 200, status: 'pending' })
    const succeededFirst = refundObject({
      id: 're_succeeded_first',
      amount: 300,
      status: 'succeeded',
    })
    const ignoredFailed = refundObject({
      id: 're_failed_cursor',
      amount: 900,
      status: 'failed',
    })
    const succeededSecond = refundObject({
      id: 're_succeeded_second',
      amount: 400,
      status: 'succeeded',
    })
    mockRetrieveRefund.mockResolvedValueOnce(trigger)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 700, refunded: false })
    )
    mockListRefunds
      .mockResolvedValueOnce(refundPage([succeededFirst, ignoredFailed], true))
      .mockResolvedValueOnce(refundPage([trigger, succeededSecond]))

    await handleRefundLifecycle(trigger, refundEvent)

    expect(mockListRefunds.mock.calls).toEqual([
      [{ charge: 'ch_refunded', limit: 100 }],
      [{ charge: 'ch_refunded', limit: 100, starting_after: 're_failed_cursor' }],
    ])
    expect(mockRpc).toHaveBeenCalledWith(
      'record_charge_refund_tombstone_atomic',
      expect.objectContaining({ p_refund_succeeded_amount: 700, p_refund_state: 'pending' })
    )
  })

  it('retries before DB when the triggering Refund is missing from pagination', async () => {
    const trigger = refundObject({ id: 're_trigger', status: 'failed' })
    mockRetrieveRefund.mockResolvedValueOnce(trigger)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 0, refunded: false })
    )
    mockOneRefundPage(refundObject({ id: 're_other', status: 'failed' }))

    await expect(handleRefundLifecycle(trigger, refundEvent)).rejects.toThrow('is not yet visible')
    expectNoDatabaseWrite()
  })

  it('retries before DB on an empty continuing Refund page', async () => {
    const trigger = refundObject({ id: 're_trigger', status: 'pending' })
    mockRetrieveRefund.mockResolvedValueOnce(trigger)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 0, refunded: false })
    )
    mockListRefunds.mockResolvedValueOnce(refundPage([], true))

    await expect(handleRefundLifecycle(trigger, refundEvent)).rejects.toThrow(
      'empty continuing Refund page'
    )
    expectNoDatabaseWrite()
  })

  it('retries before DB when pagination repeats a Refund id', async () => {
    const trigger = refundObject({ id: 're_trigger', status: 'pending' })
    const duplicate = refundObject({ id: 're_duplicate', amount: 500, status: 'succeeded' })
    mockRetrieveRefund.mockResolvedValueOnce(trigger)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 500, refunded: false })
    )
    mockListRefunds
      .mockResolvedValueOnce(refundPage([duplicate], true))
      .mockResolvedValueOnce(refundPage([duplicate, trigger]))

    await expect(handleRefundLifecycle(trigger, refundEvent)).rejects.toThrow(
      'repeated Refund re_duplicate'
    )
    expectNoDatabaseWrite()
  })

  it('retries before DB when Charge and succeeded Refund sums have not converged', async () => {
    const trigger = refundObject({ id: 're_trigger', status: 'failed' })
    mockRetrieveRefund.mockResolvedValueOnce(trigger)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 500, refunded: false })
    )
    mockOneRefundPage(
      trigger,
      refundObject({ id: 're_succeeded', amount: 400, status: 'succeeded' })
    )

    await expect(handleRefundLifecycle(trigger, refundEvent)).rejects.toThrow('have not converged')
    expectNoDatabaseWrite()
  })

  it('retries before DB when exact Refund retrieval and pagination have not converged', async () => {
    const freshTrigger = refundObject({ id: 're_trigger', status: 'succeeded' })
    const laggingTrigger = refundObject({ id: 're_trigger', status: 'pending' })
    mockRetrieveRefund.mockResolvedValueOnce(freshTrigger)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 0, refunded: false })
    )
    mockOneRefundPage(laggingTrigger)

    await expect(handleRefundLifecycle(freshTrigger, refundEvent)).rejects.toThrow(
      'retrieval and Charge pagination have not converged'
    )
    expectNoDatabaseWrite()
  })

  it('finishes every Refund, PaymentIntent, Charge, and list read before the first tombstone RPC', async () => {
    const trigger = refundObject({ charge: null, status: 'failed' })
    mockRetrieveRefund.mockResolvedValueOnce(trigger)
    mockRetrievePaymentIntent.mockResolvedValueOnce({
      id: 'pi_refunded',
      latest_charge: 'ch_refunded',
    } as Stripe.PaymentIntent)
    mockRetrieveCharge.mockResolvedValueOnce(
      refundedCharge({ amount_refunded: 0, refunded: false })
    )
    mockOneRefundPage(trigger)

    await handleRefundLifecycle(trigger, refundEvent)

    const firstDbOrder = mockRpc.mock.invocationCallOrder[0]
    for (const stripeRead of [
      mockRetrieveRefund,
      mockRetrievePaymentIntent,
      mockRetrieveCharge,
      mockListRefunds,
    ]) {
      expect(stripeRead).toHaveBeenCalledTimes(1)
      expect(stripeRead.mock.invocationCallOrder[0]).toBeLessThan(firstDbOrder)
    }
  })

  it('forces aggregate state to succeeded when succeeded Refunds equal the captured amount', async () => {
    const failedTrigger = refundObject({ id: 're_failed_trigger', status: 'failed' })
    mockRetrieveRefund.mockResolvedValueOnce(failedTrigger)
    mockRetrieveCharge.mockResolvedValueOnce(refundedCharge())
    mockOneRefundPage(
      failedTrigger,
      refundObject({ id: 're_full_success', amount: 2500, status: 'succeeded' })
    )

    await handleRefundLifecycle(failedTrigger, refundEvent)

    expect(mockRpc).toHaveBeenCalledWith(
      'record_charge_refund_tombstone_atomic',
      expect.objectContaining({
        p_refund_succeeded_amount: 2500,
        p_refund_state: 'succeeded',
      })
    )
  })

  it.each([
    ['Pro', proAcknowledgement({ unexpected: true })],
    ['non-entitlement', nonEntitlementAcknowledgement('tip', { unexpected: true })],
    ['unclassified', { status: 'recorded', ownership_status: 'unclassified', unexpected: true }],
    ['durable-attention', { status: 'manual_review', record_status: 'recorded', unexpected: true }],
  ])('rejects an otherwise valid %s acknowledgement with extra keys', async (_route, data) => {
    configureRpc({ tombstoneData: data })

    await expect(handleChargeRefunded(refundedCharge(), refundEvent)).rejects.toThrow(
      /acknowledgement|ownership/
    )

    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each(['tip', 'group_pass'] as const)(
    'rejects no_tombstone as a %s projection acknowledgement',
    async (productKind) => {
      configureRpc({
        tombstoneData: nonEntitlementAcknowledgement(productKind, {
          projection_status: 'no_tombstone',
        }),
      })

      await expect(handleChargeRefunded(refundedCharge(), refundEvent)).rejects.toThrow(
        'contradictory product ownership'
      )
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('rejects extra fields in an otherwise valid reconciliation acknowledgement', async () => {
    mockFrom.mockReturnValueOnce(paymentLookup(lifetimePayment()))
    configureRpc({
      tombstoneData: proAcknowledgement(),
      reconciliationData: { status: 'revoked', guessed_owner: true },
    })

    await expect(handleChargeRefunded(refundedCharge(), refundEvent)).rejects.toThrow(
      'unknown or non-exact acknowledgement'
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'record_stripe_manual_review_atomic'
    )
  })

  it('durably reviews a fresh invalid Refund shape rather than trusting signed fields', async () => {
    mockRetrieveRefund.mockResolvedValueOnce({
      ...refundObject(),
      status: 'future_state',
    } as Stripe.Refund)

    await expect(handleRefundLifecycle(refundObject(), refundEvent)).resolves.toBeUndefined()

    expect(mockRetrieveRefund).toHaveBeenCalledWith('re_updated')
    expect(mockRetrieveCharge).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_stripe_manual_review_atomic',
      expect.objectContaining({ p_reason_key: 'fresh_refund_invalid_shape' })
    )
  })

  it('durably reviews a fresh Refund retrieval identity conflict', async () => {
    mockRetrieveRefund.mockResolvedValueOnce(refundObject({ id: 're_other' }))

    await expect(handleRefundLifecycle(refundObject(), refundEvent)).resolves.toBeUndefined()

    expect(mockRetrieveCharge).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_stripe_manual_review_atomic',
      expect.objectContaining({
        p_object_id: 're_updated',
        p_reason_key: 'stripe_refund_retrieval_identity_conflict',
      })
    )
  })

  it('keeps transient Stripe and tombstone failures retryable', async () => {
    mockRetrieveCharge.mockRejectedValueOnce(new Error('Stripe Charge unavailable'))
    await expect(handleChargeRefunded(refundedCharge(), refundEvent)).rejects.toThrow(
      'Stripe Charge unavailable'
    )
    expectNoDatabaseWrite()

    configureRpc({ tombstoneError: { message: 'tombstone unavailable' } })
    await expect(handleChargeRefunded(refundedCharge(), refundEvent)).rejects.toThrow(
      'Failed to record Charge refund tombstone: tombstone unavailable'
    )
  })

  it('durably reviews resource_missing while retrying other Stripe failures', async () => {
    mockRetrieveRefund.mockRejectedValueOnce({
      name: 'StripeInvalidRequestError',
      type: 'StripeInvalidRequestError',
      code: 'resource_missing',
      statusCode: 404,
    })

    await expect(handleRefundLifecycle(refundObject(), refundEvent)).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_stripe_manual_review_atomic',
      expect.objectContaining({ p_reason_key: 'stripe_refund_resource_missing' })
    )

    jest.clearAllMocks()
    mockRetrieveRefund.mockRejectedValueOnce(new Error('Stripe authentication failed'))
    configureRpc()
    await expect(handleRefundLifecycle(refundObject(), refundEvent)).rejects.toThrow(
      'Stripe authentication failed'
    )
    expectNoDatabaseWrite()
  })

  it('durably reviews an invalid immutable event identity before Stripe access', async () => {
    await expect(
      handleRefundLifecycle(refundObject(), {
        eventId: 'not-an-event',
        eventCreatedAt: refundEvent.eventCreatedAt,
      })
    ).resolves.toBeUndefined()

    expect(mockRetrieveRefund).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'record_stripe_manual_review_atomic',
      expect.objectContaining({ p_reason_key: 'invalid_refund_event_identity' })
    )
  })
})
