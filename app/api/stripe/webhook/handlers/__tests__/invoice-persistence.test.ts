import type Stripe from 'stripe'
import { StripeAuthorityError } from '@/lib/stripe/entitlement-authority'

const mockFrom = jest.fn()
const mockRetrieveSubscription = jest.fn()
const mockActivateRecurringInvoiceEntitlement = jest.fn()
const mockResolveApiTierInvoicePaymentAuthority = jest.fn()
const mockRecordApiTierInvoicePayment = jest.fn()
const mockRecordStripeCheckoutManualReview = jest.fn()
const mockDrainApiTierReversalActions = jest.fn()

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom }),
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
    upsert: jest.Mock
    update: jest.Mock
    eq: jest.Mock
    then: Promise<typeof result>['then']
  } = {
    upsert: jest.fn(),
    update: jest.fn(),
    eq: jest.fn(),
    then: Promise.resolve(result).then.bind(Promise.resolve(result)),
  }
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
    mockRetrieveSubscription.mockResolvedValue(ordinarySubscription())
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
    const historyMutation = mutationQuery()
    mockFrom
      .mockImplementationOnce(() =>
        lookupQuery({
          id: USER_ID,
          subscription_tier: 'pro',
          stripe_customer_id: 'cus_owner',
        })
      )
      .mockImplementationOnce(() => historyMutation)

    await expect(handlePaymentSucceeded(invoice(), EVENT)).resolves.toBeUndefined()

    expect(mockActivateRecurringInvoiceEntitlement).toHaveBeenCalledWith({
      stripe: expect.any(Object),
      supabase: expect.any(Object),
      invoice: expect.objectContaining({ id: 'in_test' }),
      livemode: true,
    })
    expect(historyMutation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        stripe_invoice_id: 'in_test',
        stripe_payment_intent_id: 'pi_test',
        amount: 499,
        currency: 'usd',
        status: 'succeeded',
      }),
      { onConflict: 'stripe_invoice_id' }
    )
    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual([
      'user_profiles',
      'payment_history',
    ])
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
    mockFrom
      .mockImplementationOnce(() =>
        lookupQuery({
          id: USER_ID,
          subscription_tier: 'pro',
          stripe_customer_id: 'cus_owner',
        })
      )
      .mockImplementationOnce(() => mutationQuery({ message: 'history write unavailable' }))

    await expect(handlePaymentSucceeded(invoice(), EVENT)).rejects.toThrow(
      'Failed to record successful payment: history write unavailable'
    )
  })

  it('does not write ordinary Pro failure state for an API invoice', async () => {
    mockRetrieveSubscription.mockResolvedValue(
      apiSubscription({
        status: 'past_due',
      })
    )

    await expect(handlePaymentFailed(invoice())).resolves.toBeUndefined()

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

    await expect(handlePaymentFailed(invoice())).rejects.toThrow(
      'Invoice in_test subscription is not an exact ordinary Pro subscription'
    )

    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps a failed payment retryable when history persistence fails', async () => {
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: USER_ID, subscription_tier: 'pro' }))
      .mockImplementationOnce(() => mutationQuery({ message: 'failure history unavailable' }))

    await expect(handlePaymentFailed(invoice())).rejects.toThrow(
      'Failed to record payment failure: failure history unavailable'
    )
  })

  it('keeps a past-due transition retryable when subscription persistence fails', async () => {
    mockRetrieveSubscription.mockResolvedValue(
      ordinarySubscription({
        status: 'past_due',
      })
    )
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: USER_ID, subscription_tier: 'pro' }))
      .mockImplementationOnce(() => mutationQuery())
      .mockImplementationOnce(() => mutationQuery({ message: 'status write unavailable' }))

    await expect(handlePaymentFailed(invoice())).rejects.toThrow(
      'Failed to mark subscription past due: status write unavailable'
    )
  })
})
