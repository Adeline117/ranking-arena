import type Stripe from 'stripe'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockResolveExactRecurringInvoicePriceId = jest.fn()
const mockResolveRecurringInvoiceAuthority = jest.fn()
const mockResolveRecurringInvoiceFailureAuthority = jest.fn()
const mockApplyExactApiTierInvoicePayment = jest.fn()

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
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
  stripe: {},
}))

jest.mock('@/lib/stripe/entitlement-authority', () => {
  const actual = jest.requireActual('@/lib/stripe/entitlement-authority')
  return {
    ...actual,
    resolveExactRecurringInvoicePriceId: (...args: unknown[]) =>
      mockResolveExactRecurringInvoicePriceId(...args),
    resolveRecurringInvoiceAuthority: (...args: unknown[]) =>
      mockResolveRecurringInvoiceAuthority(...args),
    resolveRecurringInvoiceFailureAuthority: (...args: unknown[]) =>
      mockResolveRecurringInvoiceFailureAuthority(...args),
  }
})

jest.mock('@/lib/data/notifications', () => ({ sendNotification: jest.fn() }))
jest.mock('../api-tier-payment', () => ({
  applyExactApiTierInvoicePayment: (...args: unknown[]) =>
    mockApplyExactApiTierInvoicePayment(...args),
}))

import { StripeAuthorityError } from '@/lib/stripe/entitlement-authority'
import { handlePaymentFailed, handlePaymentSucceeded } from '../invoice'

const paidEvent = {
  id: 'evt_invoice_paid',
  created: 1_800_000_000,
  livemode: true,
  type: 'invoice.payment_succeeded' as const,
}
const failedEvent = {
  id: 'evt_invoice_failed',
  created: 1_800_000_001,
  livemode: true,
}

const paymentAuthority = {
  kind: 'recurring_payment' as const,
  userId: '11e34ce2-43c1-4bcc-8f19-79b36d56605c',
  customerId: 'cus_owner',
  subscriptionId: 'sub_current',
  invoiceId: 'in_test',
  invoicePaymentId: 'inpay_test',
  paymentIntentId: 'pi_test',
  chargeId: 'ch_test',
  paymentSource: 'payment_intent' as const,
  priceId: 'price_pro_monthly',
  plan: 'monthly' as const,
  amount: 2500,
  currency: 'usd',
  periodStart: 1_700_000_000,
  periodEnd: 1_702_592_000,
  invoiceCreatedAt: 1_700_000_100,
  paidAt: 1_700_000_200,
  subscriptionStatus: 'active' as const,
  refundReference: {
    invoicePaymentId: 'inpay_test',
    invoiceId: 'in_test',
    paymentIntentId: 'pi_test',
    chargeId: 'ch_test',
    originalAmount: 2500,
  },
}

const failureAuthority = {
  kind: 'recurring_invoice_failure' as const,
  userId: paymentAuthority.userId,
  customerId: 'cus_owner',
  subscriptionId: 'sub_current',
  invoiceId: 'in_test',
  priceId: 'price_pro_monthly',
  plan: 'monthly' as const,
  amountDue: 2500,
  currency: 'usd',
  periodStart: 1_700_000_000,
  periodEnd: 1_702_592_000,
  invoiceCreatedAt: 1_700_000_100,
  subscriptionStatus: 'past_due' as const,
  nextPaymentAttempt: 1_700_086_400,
}

function invoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_test',
    object: 'invoice',
    created: 1_700_000_100,
    livemode: true,
    customer: 'cus_owner',
    amount_paid: 2500,
    amount_due: 2500,
    amount_remaining: 0,
    subtotal: 2500,
    total: 2500,
    currency: 'usd',
    status: 'paid',
    parent: {
      type: 'subscription_details',
      subscription_details: {
        metadata: {},
        subscription: 'sub_current',
      },
    },
    ...overrides,
  } as Stripe.Invoice
}

function authorityReviewError(priceId: string) {
  return new StripeAuthorityError({
    code: 'unsupported_product',
    stage: 'product',
    message: `Invoice in_test subscription is not an exact ordinary Pro subscription (${priceId})`,
    objectIds: { invoiceId: 'in_test', subscriptionId: 'sub_current' },
    details: { priceId },
  })
}

function defaultRpc(name: string, args: Record<string, unknown>) {
  if (name === 'classify_recurring_invoice_product_authority_atomic') {
    const priceId = args.p_stripe_price_id
    if (priceId === 'price_api_starter' || priceId === 'price_api_pro') {
      return Promise.resolve({ data: { status: 'api_tier' }, error: null })
    }
    if (priceId === 'price_pro_monthly' || priceId === 'price_pro_yearly') {
      return Promise.resolve({ data: { status: 'b2c_pro' }, error: null })
    }
    return Promise.resolve({ data: { status: 'not_found' }, error: null })
  }
  if (name === 'resolve_b2c_recurring_price_authority') {
    return Promise.resolve({ data: { status: 'not_found' }, error: null })
  }
  if (name === 'apply_b2c_recurring_invoice_event_atomic') {
    return Promise.resolve({
      data: {
        status: args.p_event_type === 'invoice.payment_failed' ? 'failed_recorded' : 'activated',
      },
      error: null,
    })
  }
  if (name === 'record_b2c_recurring_manual_review_atomic') {
    return Promise.resolve({ data: { status: 'recorded' }, error: null })
  }
  throw new Error(`Unexpected RPC: ${name}`)
}

function failInvoicePersistence(message: string) {
  mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === 'apply_b2c_recurring_invoice_event_atomic') {
      return Promise.resolve({ data: null, error: { message } })
    }
    return defaultRpc(name, args)
  })
}

describe('invoice webhook persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockRpc.mockReset()
    mockResolveExactRecurringInvoicePriceId.mockReset()
    mockResolveRecurringInvoiceAuthority.mockReset()
    mockResolveRecurringInvoiceFailureAuthority.mockReset()
    mockApplyExactApiTierInvoicePayment.mockReset()
    mockRpc.mockImplementation(defaultRpc)
    mockResolveExactRecurringInvoicePriceId.mockResolvedValue('price_pro_monthly')
    mockResolveRecurringInvoiceAuthority.mockResolvedValue(paymentAuthority)
    mockResolveRecurringInvoiceFailureAuthority.mockResolvedValue(failureAuthority)
    mockApplyExactApiTierInvoicePayment.mockResolvedValue({ status: 'applied' })
  })

  it('does not turn a successful API invoice into an ordinary Pro entitlement', async () => {
    const snapshot = invoice()
    mockResolveExactRecurringInvoicePriceId.mockResolvedValue('price_api_starter')

    await expect(handlePaymentSucceeded(snapshot, paidEvent)).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'classify_recurring_invoice_product_authority_atomic',
      expect.objectContaining({
        p_event_id: 'evt_invoice_paid',
        p_invoice_id: 'in_test',
        p_stripe_price_id: 'price_api_starter',
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_b2c_recurring_invoice_event_atomic'
    )
    expect(mockResolveRecurringInvoiceAuthority).not.toHaveBeenCalled()
    expect(mockApplyExactApiTierInvoicePayment).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: snapshot, event: paidEvent })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('isolates a current API price even when Stripe omits subscription metadata', async () => {
    const snapshot = invoice()
    mockResolveExactRecurringInvoicePriceId.mockResolvedValue('price_api_pro')

    await expect(handlePaymentSucceeded(snapshot, paidEvent)).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'classify_recurring_invoice_product_authority_atomic',
      expect.objectContaining({ p_stripe_price_id: 'price_api_pro' })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_b2c_recurring_invoice_event_atomic'
    )
    expect(mockResolveRecurringInvoiceAuthority).not.toHaveBeenCalled()
    expect(mockApplyExactApiTierInvoicePayment).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: snapshot, event: paidEvent })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each(['price_api_legacy_pro', 'price_pro_lifetime', 'price_unknown'])(
    'does not restore ordinary Pro for unknown subscription price %s',
    async (priceId) => {
      const snapshot = invoice()
      mockResolveExactRecurringInvoicePriceId.mockResolvedValue(priceId)
      mockResolveRecurringInvoiceAuthority.mockRejectedValueOnce(authorityReviewError(priceId))

      await expect(handlePaymentSucceeded(snapshot, paidEvent)).resolves.toBeUndefined()

      expect(mockRpc).toHaveBeenCalledWith(
        'record_b2c_recurring_manual_review_atomic',
        expect.objectContaining({
          p_object_type: 'invoice',
          p_object_id: 'in_test',
          p_reason_key: 'b2c_recurring_authority:unsupported_product',
        })
      )
      expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
        'activate_b2c_recurring_payment_atomic'
      )
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('does not write ordinary Pro failure state for an API invoice', async () => {
    const snapshot = invoice({ status: 'open', amount_paid: 0, amount_remaining: 2500 })
    mockResolveExactRecurringInvoicePriceId.mockResolvedValue('price_api_starter')

    await expect(handlePaymentFailed(snapshot, failedEvent)).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'classify_recurring_invoice_product_authority_atomic',
      expect.objectContaining({ p_stripe_price_id: 'price_api_starter' })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'apply_b2c_recurring_invoice_event_atomic'
    )
    expect(mockResolveRecurringInvoiceFailureAuthority).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('does not write ordinary Pro failure state for a rotated unknown price', async () => {
    const snapshot = invoice({ status: 'open', amount_paid: 0, amount_remaining: 2500 })
    mockResolveExactRecurringInvoicePriceId.mockResolvedValue('price_api_legacy_pro')
    mockResolveRecurringInvoiceFailureAuthority.mockRejectedValueOnce(
      authorityReviewError('price_api_legacy_pro')
    )

    await expect(handlePaymentFailed(snapshot, failedEvent)).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenCalledWith(
      'record_b2c_recurring_manual_review_atomic',
      expect.objectContaining({
        p_object_type: 'invoice',
        p_object_id: 'in_test',
        p_reason_key: 'b2c_recurring_authority:unsupported_product',
      })
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'activate_b2c_recurring_payment_atomic'
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps a successful payment retryable when its history row cannot be written', async () => {
    failInvoicePersistence('history write unavailable')

    await expect(handlePaymentSucceeded(invoice(), paidEvent)).rejects.toThrow(
      'Recurring invoice event persistence failed: history write unavailable'
    )
  })

  it('keeps a successful payment retryable when Pro restoration fails', async () => {
    failInvoicePersistence('profile write unavailable')

    await expect(handlePaymentSucceeded(invoice(), paidEvent)).rejects.toThrow(
      'Recurring invoice event persistence failed: profile write unavailable'
    )
  })

  it('reconciles the subscription row even when the profile is already Pro', async () => {
    const snapshot = invoice()

    await expect(handlePaymentSucceeded(snapshot, paidEvent)).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'apply_b2c_recurring_invoice_event_atomic',
      expect.objectContaining({
        p_event_id: 'evt_invoice_paid',
        p_event_type: 'invoice.payment_succeeded',
        p_user_id: paymentAuthority.userId,
        p_stripe_subscription_id: 'sub_current',
        p_stripe_invoice_id: 'in_test',
        p_stripe_subscription_status: 'active',
        p_livemode: true,
      })
    )
  })

  it('keeps an active-subscription reconciliation failure retryable', async () => {
    failInvoicePersistence('subscription write unavailable')

    await expect(handlePaymentSucceeded(invoice(), paidEvent)).rejects.toThrow(
      'Recurring invoice event persistence failed: subscription write unavailable'
    )
  })

  it('keeps a failed payment retryable when its history row cannot be written', async () => {
    failInvoicePersistence('failure history unavailable')

    await expect(handlePaymentFailed(invoice({ status: 'open' }), failedEvent)).rejects.toThrow(
      'Failed invoice event persistence failed: failure history unavailable'
    )
  })

  it('keeps a past-due transition retryable when subscription persistence fails', async () => {
    failInvoicePersistence('status write unavailable')

    await expect(handlePaymentFailed(invoice({ status: 'open' }), failedEvent)).rejects.toThrow(
      'Failed invoice event persistence failed: status write unavailable'
    )
  })
})
