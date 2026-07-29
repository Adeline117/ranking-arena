import type Stripe from 'stripe'
import { StripeAuthorityError } from '@/lib/stripe/entitlement-authority'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockRetrieveSubscription = jest.fn()
const mockRetrieveCustomer = jest.fn()
const mockActivateRecurringInvoiceEntitlement = jest.fn()
const mockResolveApiTierInvoicePaymentAuthority = jest.fn()
const mockRecordApiTierInvoicePayment = jest.fn()
const mockRecordStripeCheckoutManualReview = jest.fn()
const mockDrainApiTierReversalActions = jest.fn()

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/lib/stripe', () => ({
  STRIPE_API_PRICE_IDS: {
    starter: 'price_api_starter',
    pro: 'price_api_pro',
  },
  STRIPE_PRICE_IDS: {
    monthly: 'price_pro_monthly',
    yearly: 'price_pro_yearly',
    lifetime: 'price_pro_lifetime',
  },
  getStripe: () => ({
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args),
    },
    customers: {
      retrieve: (...args: unknown[]) => mockRetrieveCustomer(...args),
    },
  }),
  stripe: {
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args),
    },
  },
}))

jest.mock('@/lib/stripe/recurring-entitlement', () => ({
  activateRecurringInvoiceEntitlement: (...args: unknown[]) =>
    mockActivateRecurringInvoiceEntitlement(...args),
}))

jest.mock('@/lib/stripe/api-tier-payment', () => ({
  resolveApiTierInvoicePaymentAuthority: (...args: unknown[]) =>
    mockResolveApiTierInvoicePaymentAuthority(...args),
  recordApiTierInvoicePayment: (...args: unknown[]) => mockRecordApiTierInvoicePayment(...args),
}))

jest.mock('@/lib/stripe/lifetime-entitlement', () => ({
  recordStripeCheckoutManualReview: (...args: unknown[]) =>
    mockRecordStripeCheckoutManualReview(...args),
}))

jest.mock('@/lib/stripe/api-tier-reversal-actions', () => ({
  drainApiTierReversalActions: (...args: unknown[]) => mockDrainApiTierReversalActions(...args),
}))

jest.mock('@/lib/data/notifications', () => ({ sendNotification: jest.fn() }))

import { handlePaymentFailed, handlePaymentSucceeded } from '../invoice'

type DbError = { message: string }

const USER_ID = '11111111-1111-4111-8111-111111111111'
const EVENT = {
  id: 'evt_invoice_paid',
  type: 'invoice.paid' as const,
  created: 1_800_000_100,
  livemode: true,
}
const FAILED_EVENT = {
  id: 'evt_invoice_failed',
  type: 'invoice.payment_failed' as const,
  created: 1_800_000_100,
  livemode: true,
}
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222'
const OPERATION_ID = '33333333-3333-4333-8333-333333333333'
const NONCE = '44444444-4444-4444-8444-444444444444'
const RECURRING_AUTHORITY = {
  kind: 'recurring_payment' as const,
  userId: USER_ID,
  customerId: 'cus_owner',
  subscriptionId: 'sub_current',
  invoiceId: 'in_test',
  invoicePaymentId: 'ipmt_test',
  paymentIntentId: 'pi_test',
  chargeId: 'ch_test',
  paymentSource: 'payment_intent' as const,
  priceId: 'price_pro_monthly',
  plan: 'monthly' as const,
  amount: 499,
  currency: 'usd',
  periodStart: 1_800_000_000,
  periodEnd: 1_802_592_000,
  invoiceCreatedAt: 1_800_000_000,
  paidAt: 1_800_000_050,
  subscriptionStatus: 'active' as const,
  refundReference: {
    invoicePaymentId: 'ipmt_test',
    invoiceId: 'in_test',
    paymentIntentId: 'pi_test',
    chargeId: 'ch_test',
    originalAmount: 499,
  },
}

function authorityError(stage: 'invoice' | 'subscription' = 'invoice') {
  return new StripeAuthorityError({
    code: 'identity_conflict',
    stage,
    message: 'exact Stripe identity does not match',
    objectIds: { invoiceId: 'in_test', subscriptionId: 'sub_current' },
    details: {},
  })
}

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
    insert: jest.Mock
    upsert: jest.Mock
    update: jest.Mock
    eq: jest.Mock
    then: Promise<typeof result>['then']
  } = {
    insert: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    eq: jest.fn(),
    then: Promise.resolve(result).then.bind(Promise.resolve(result)),
  }
  query.insert.mockReturnValue(query)
  query.upsert.mockReturnValue(query)
  query.update.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function invoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_test',
    created: 1_800_000_000,
    livemode: true,
    customer: 'cus_owner',
    status: 'paid',
    amount_paid: 499,
    amount_due: 499,
    amount_remaining: 0,
    currency: 'usd',
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_current',
        metadata: {
          userId: USER_ID,
          supabase_user_id: USER_ID,
        },
      },
    },
    ...overrides,
  } as Stripe.Invoice
}

function ordinarySubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_current',
    livemode: true,
    status: 'active',
    customer: 'cus_owner',
    metadata: {},
    items: {
      data: [{ quantity: 1, price: { id: 'price_pro_monthly' } }],
    },
    ...overrides,
  } as Stripe.Subscription
}

function recurringMetadata() {
  return {
    plan: 'monthly',
    pro_checkout_nonce: NONCE,
    pro_checkout_operation_id: OPERATION_ID,
    pro_checkout_reservation_id: RESERVATION_ID,
    stripe_customer_id: 'cus_owner',
    stripe_price_id: 'price_pro_monthly',
    supabase_user_id: USER_ID,
    trial_requested: 'false',
    type: 'pro_subscription',
    userId: USER_ID,
  }
}

function exactFailedSubscription(
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return ordinarySubscription({
    created: 1_700_000_000,
    currency: 'usd',
    latest_invoice: 'in_test',
    status: 'past_due',
    cancel_at_period_end: false,
    canceled_at: null,
    metadata: recurringMetadata(),
    items: {
      data: [
        {
          id: 'si_current',
          subscription: 'sub_current',
          quantity: 1,
          current_period_start: 1_800_000_000,
          current_period_end: 1_802_592_000,
          price: {
            id: 'price_pro_monthly',
            currency: 'usd',
          },
        },
      ],
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
    ...overrides,
  })
}

function failedInvoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return invoice({
    status: 'open',
    amount_paid: 0,
    amount_due: 499,
    amount_remaining: 499,
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_current',
        metadata: recurringMetadata(),
      },
    },
    ...overrides,
  })
}

function apiSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return ordinarySubscription({
    metadata: {
      type: 'api_tier',
      api_plan: 'starter',
    },
    items: {
      data: [{ quantity: 1, price: { id: 'price_api_starter' } }],
    },
    ...overrides,
  })
}

describe('invoice webhook persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockRpc.mockReset()
    mockRetrieveSubscription.mockResolvedValue(ordinarySubscription())
    mockRetrieveCustomer.mockResolvedValue({
      id: 'cus_owner',
      object: 'customer',
      livemode: true,
      metadata: { userId: USER_ID },
    })
    mockRpc.mockImplementation(async (name: string) =>
      name === 'record_recurring_payment_history_success_atomic'
        ? { data: { status: 'recorded' }, error: null }
        : { data: 'completed', error: null }
    )
    mockActivateRecurringInvoiceEntitlement.mockResolvedValue({
      status: 'activated',
      authority: RECURRING_AUTHORITY,
    })
    mockResolveApiTierInvoicePaymentAuthority.mockResolvedValue({ kind: 'api_tier_payment' })
    mockRecordApiTierInvoicePayment.mockResolvedValue({
      status: 'recorded',
      projectionStatus: 'applied',
      shouldCancel: false,
    })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
    mockDrainApiTierReversalActions.mockResolvedValue({ claimed: 0, completed: 0, retried: 0 })
  })

  it('routes an API Invoice through its exact paid ledger and never ordinary Pro', async () => {
    mockRetrieveSubscription.mockResolvedValue(apiSubscription())

    await expect(handlePaymentSucceeded(invoice(), EVENT)).resolves.toBeUndefined()

    expect(mockResolveApiTierInvoicePaymentAuthority).toHaveBeenCalledWith({
      stripe: expect.any(Object),
      invoice: expect.objectContaining({ id: 'in_test' }),
      observation: EVENT,
    })
    expect(mockRecordApiTierInvoicePayment).toHaveBeenCalledWith({
      supabase: expect.any(Object),
      authority: { kind: 'api_tier_payment' },
      observation: EVENT,
    })
    expect(mockActivateRecurringInvoiceEntitlement).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('drains a durable API reversal action after a blocked paid Invoice', async () => {
    mockRetrieveSubscription.mockResolvedValue(apiSubscription())
    mockRecordApiTierInvoicePayment.mockResolvedValue({
      status: 'blocked',
      projectionStatus: 'blocked',
      shouldCancel: true,
    })

    await handlePaymentSucceeded(invoice(), EVENT)

    expect(mockDrainApiTierReversalActions).toHaveBeenCalledWith({ limit: 1 })
  })

  it('durably reviews API authority drift and ACKs only after review persistence', async () => {
    mockRetrieveSubscription.mockResolvedValue(apiSubscription())
    mockResolveApiTierInvoicePaymentAuthority.mockRejectedValue(authorityError())

    await expect(handlePaymentSucceeded(invoice(), EVENT)).resolves.toBeUndefined()

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'invoice',
        sessionId: 'in_test',
        reasonKey: 'api_tier_invoice_authority:identity_conflict',
      })
    )
    expect(mockRecordApiTierInvoicePayment).not.toHaveBeenCalled()
  })

  it('keeps an API resolver outage retryable without converting it to Pro', async () => {
    mockRetrieveSubscription.mockResolvedValue(apiSubscription())
    mockResolveApiTierInvoicePaymentAuthority.mockRejectedValue(new Error('Stripe unavailable'))

    await expect(handlePaymentSucceeded(invoice(), EVENT)).rejects.toThrow('Stripe unavailable')

    expect(mockActivateRecurringInvoiceEntitlement).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('activates an ordinary Pro Invoice through the recurring payment ledger', async () => {
    mockFrom.mockImplementationOnce(() =>
      lookupQuery({
        id: USER_ID,
        subscription_tier: 'pro',
        stripe_customer_id: 'cus_owner',
      })
    )

    await expect(handlePaymentSucceeded(invoice(), EVENT)).resolves.toBeUndefined()

    expect(mockActivateRecurringInvoiceEntitlement).toHaveBeenCalledWith({
      stripe: expect.any(Object),
      supabase: expect.any(Object),
      invoice: expect.objectContaining({ id: 'in_test' }),
      livemode: true,
    })
    expect(mockRpc).toHaveBeenCalledWith('record_recurring_payment_history_success_atomic', {
      p_user_id: USER_ID,
      p_livemode: true,
      p_stripe_event_id: 'evt_invoice_paid',
      p_stripe_event_created: 1_800_000_100,
      p_stripe_invoice_id: 'in_test',
      p_stripe_payment_intent_id: 'pi_test',
      p_amount_paid: 499,
      p_currency: 'usd',
    })
    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual(['user_profiles'])
  })

  it('durably reviews ordinary Pro authority drift without direct-table restoration', async () => {
    mockActivateRecurringInvoiceEntitlement.mockRejectedValue(authorityError('subscription'))

    await expect(handlePaymentSucceeded(invoice(), EVENT)).resolves.toBeUndefined()

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'recurring_invoice_authority:identity_conflict',
      })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('records activation failures for review but leaves the signed event retryable', async () => {
    mockActivateRecurringInvoiceEntitlement.mockRejectedValue(new Error('ledger unavailable'))

    await expect(handlePaymentSucceeded(invoice(), EVENT)).rejects.toThrow('ledger unavailable')

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'recurring_invoice_activation_failed',
      })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('does not ACK an unclassifiable paid Invoice unless durable review succeeds', async () => {
    mockRecordStripeCheckoutManualReview.mockRejectedValue(new Error('review unavailable'))

    await expect(
      handlePaymentSucceeded(
        invoice({
          parent: null,
        }),
        EVENT
      )
    ).rejects.toThrow('review unavailable')

    expect(mockActivateRecurringInvoiceEntitlement).not.toHaveBeenCalled()
  })

  it('reviews malformed event identity and keeps the webhook retryable', async () => {
    await expect(handlePaymentSucceeded(invoice({ livemode: false }), EVENT)).rejects.toThrow(
      'event context is invalid'
    )

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'paid_invoice_event_context_invalid',
      })
    )
    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
  })

  it('keeps an ordinary activation retryable when its owner lookup fails', async () => {
    mockFrom.mockImplementationOnce(() =>
      lookupQuery(null, { message: 'profile lookup unavailable' })
    )

    await expect(handlePaymentSucceeded(invoice(), EVENT)).rejects.toThrow(
      'Failed to find successful payment owner: profile lookup unavailable'
    )
  })

  it('ACKs a durable recurring payment retained after subject deletion', async () => {
    mockActivateRecurringInvoiceEntitlement.mockResolvedValue({
      status: 'subject_deleted',
      authority: RECURRING_AUTHORITY,
    })
    mockFrom.mockImplementationOnce(() => lookupQuery(null))

    await expect(handlePaymentSucceeded(invoice(), EVENT)).resolves.toBeUndefined()

    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('does not ACK a vanished active owner unless durable review succeeds', async () => {
    mockFrom.mockImplementationOnce(() => lookupQuery(null))

    await expect(handlePaymentSucceeded(invoice(), EVENT)).rejects.toThrow(
      'Recurring payment in_test owner disappeared after activation'
    )

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'recurring_invoice_owner_missing_after_activation',
      })
    )
  })

  it('reviews an owner/customer conflict without writing compatibility history', async () => {
    mockFrom.mockImplementationOnce(() =>
      lookupQuery({
        id: USER_ID,
        subscription_tier: 'pro',
        stripe_customer_id: 'cus_other',
      })
    )

    await expect(handlePaymentSucceeded(invoice(), EVENT)).resolves.toBeUndefined()

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'recurring_invoice_owner_identity_conflict',
      })
    )
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('keeps a successful payment retryable when history persistence fails', async () => {
    mockFrom.mockImplementationOnce(() =>
      lookupQuery({
        id: USER_ID,
        subscription_tier: 'pro',
        stripe_customer_id: 'cus_owner',
      })
    )
    mockRpc.mockImplementation(async (name: string) =>
      name === 'record_recurring_payment_history_success_atomic'
        ? { data: null, error: { message: 'history write unavailable' } }
        : { data: 'completed', error: null }
    )

    await expect(handlePaymentSucceeded(invoice(), EVENT)).rejects.toThrow(
      'Failed to record successful payment: history write unavailable'
    )
  })

  it('ACKs a durable successful-history identity conflict for manual review', async () => {
    mockFrom.mockImplementationOnce(() =>
      lookupQuery({
        id: USER_ID,
        subscription_tier: 'pro',
        stripe_customer_id: 'cus_owner',
      })
    )
    mockRpc.mockImplementation(async (name: string) =>
      name === 'record_recurring_payment_history_success_atomic'
        ? { data: { status: 'identity_conflict' }, error: null }
        : { data: 'completed', error: null }
    )

    await expect(handlePaymentSucceeded(invoice(), EVENT)).resolves.toBeUndefined()
  })

  it('rejects a contradictory successful-history RPC result', async () => {
    mockFrom.mockImplementationOnce(() =>
      lookupQuery({
        id: USER_ID,
        subscription_tier: 'pro',
        stripe_customer_id: 'cus_owner',
      })
    )
    mockRpc.mockImplementation(async (name: string) =>
      name === 'record_recurring_payment_history_success_atomic'
        ? { data: { status: 'recorded', extra: true }, error: null }
        : { data: 'completed', error: null }
    )

    await expect(handlePaymentSucceeded(invoice(), EVENT)).rejects.toThrow(
      'record_recurring_payment_history_success_atomic returned an invalid result'
    )
  })

  it('does not write ordinary Pro failure state for an API invoice', async () => {
    mockRetrieveSubscription.mockResolvedValue(
      apiSubscription({
        status: 'past_due',
      })
    )

    await expect(handlePaymentFailed(failedInvoice(), FAILED_EVENT)).resolves.toBeUndefined()

    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('does not write ordinary Pro failure state for a rotated unknown price', async () => {
    mockRetrieveSubscription.mockResolvedValue(
      ordinarySubscription({
        status: 'past_due',
        items: {
          data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
        },
      })
    )

    await expect(handlePaymentFailed(failedInvoice(), FAILED_EVENT)).rejects.toThrow(
      'Failed Invoice in_test recurring Pro identity is invalid'
    )

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'invoice_event',
        sessionId: 'evt_invoice_failed',
        reasonKey: 'failed_invoice_recurring_identity_invalid',
      })
    )
  })

  it('keeps a failed payment retryable when history persistence fails', async () => {
    mockRetrieveSubscription.mockResolvedValue(exactFailedSubscription())
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: USER_ID, stripe_customer_id: 'cus_owner' }))
      .mockImplementationOnce(() => lookupQuery(null))
      .mockImplementationOnce(() => mutationQuery({ message: 'failure history unavailable' }))

    await expect(handlePaymentFailed(failedInvoice(), FAILED_EVENT)).rejects.toThrow(
      'Failed to record payment failure: failure history unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ reasonKey: 'failed_invoice_authority_conflict' })
    )
  })

  it('records exact failure and never mutates the subscription projection', async () => {
    mockRetrieveSubscription.mockResolvedValue(exactFailedSubscription())
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: USER_ID, stripe_customer_id: 'cus_owner' }))
      .mockImplementationOnce(() => lookupQuery(null))
      .mockImplementationOnce(() => mutationQuery())

    await expect(handlePaymentFailed(failedInvoice(), FAILED_EVENT)).resolves.toBeUndefined()

    const tables = mockFrom.mock.calls.map(([table]) => table)
    expect(tables).toEqual(['user_profiles', 'payment_history', 'payment_history'])
    expect(mockRpc).toHaveBeenCalledWith(
      'assert_recurring_pro_checkout_completed_atomic',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_stripe_subscription_id: 'sub_current',
        p_reservation_id: RESERVATION_ID,
      })
    )
  })

  it('never overwrites a succeeded payment history row with failure', async () => {
    mockRetrieveSubscription.mockResolvedValue(exactFailedSubscription())
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: USER_ID, stripe_customer_id: 'cus_owner' }))
      .mockImplementationOnce(() =>
        lookupQuery({
          user_id: USER_ID,
          stripe_invoice_id: 'in_test',
          amount: 499,
          currency: 'usd',
          status: 'succeeded',
        })
      )

    await expect(handlePaymentFailed(failedInvoice(), FAILED_EVENT)).rejects.toThrow(
      'conflicts with durable payment history'
    )
    expect(mockFrom).toHaveBeenCalledTimes(2)
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ reasonKey: 'failed_invoice_authority_conflict' })
    )
  })
})
