import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

const mockResolveRecurringInvoiceAuthority = jest.fn()
const mockRecordRecurringAuthorityReview = jest.fn()
const mockParseApiTierSubscriptionAuthority = jest.fn()
const mockResolveApiTierCheckoutConfirmation = jest.fn()
const mockRetrieveSubscription = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/app/(app)/user-center/membership-config', () => ({
  API_PRICING: {
    starter: { price: 49 },
    pro: { price: 199 },
  },
}))

jest.mock('@/lib/stripe/entitlement-authority', () => {
  const actual = jest.requireActual('@/lib/stripe/entitlement-authority')
  return {
    ...actual,
    resolveRecurringInvoiceAuthority: (...args: unknown[]) =>
      mockResolveRecurringInvoiceAuthority(...args),
  }
})

jest.mock('@/lib/stripe/recurring-entitlement', () => ({
  recordRecurringAuthorityReview: (...args: unknown[]) =>
    mockRecordRecurringAuthorityReview(...args),
}))

jest.mock('../subscription', () => ({
  parseApiTierSubscriptionAuthority: (...args: unknown[]) =>
    mockParseApiTierSubscriptionAuthority(...args),
  resolveApiTierCheckoutConfirmation: (...args: unknown[]) =>
    mockResolveApiTierCheckoutConfirmation(...args),
}))

import { StripeAuthorityError } from '@/lib/stripe/entitlement-authority'
import { applyExactApiTierInvoicePayment } from '../api-tier-payment'

const USER_ID = '11e34ce2-43c1-4bcc-8f19-79b36d56605c'
const RESERVATION_ID = '91e34ce2-43c1-4bcc-8f19-79b36d56605c'
const PAYMENT_ID = '21e34ce2-43c1-4bcc-8f19-79b36d56605c'
const OWNERSHIP_ID = '31e34ce2-43c1-4bcc-8f19-79b36d56605c'
const REFUND_EFFECT_ID = '41e34ce2-43c1-4bcc-8f19-79b36d56605c'
const CANCEL_EFFECT_ID = '51e34ce2-43c1-4bcc-8f19-79b36d56605c'
const RECOVERY_OPERATION_ID = '61e34ce2-43c1-4bcc-8f19-79b36d56605c'
const EVENT_CREATED = 1_800_000_000
const SUBSCRIPTION_CREATED = 1_700_000_000
const SESSION_CREATED = 1_699_999_940
const INVOICE_CREATED = 1_700_000_100
const PAID_AT = 1_700_000_200
const PERIOD_START = 1_700_000_000
const PERIOD_END = 1_702_592_000

const event = {
  id: 'evt_api_paid',
  created: EVENT_CREATED,
  livemode: true,
  type: 'invoice.paid' as const,
}

function invoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_api_paid',
    object: 'invoice',
    created: INVOICE_CREATED,
    livemode: true,
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_api_current',
        metadata: { userId: USER_ID, supabase_user_id: USER_ID },
      },
    },
    ...overrides,
  } as Stripe.Invoice
}

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_api_current',
    object: 'subscription',
    created: SUBSCRIPTION_CREATED,
    livemode: true,
    status: 'active',
    customer: 'cus_api_owner',
    metadata: {},
    items: { object: 'list', has_more: false, data: [] },
    ...overrides,
  } as Stripe.Subscription
}

function paymentAuthority(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'recurring_payment',
    userId: USER_ID,
    customerId: 'cus_api_owner',
    subscriptionId: 'sub_api_current',
    invoiceId: 'in_api_paid',
    invoicePaymentId: 'inpay_api_paid',
    paymentIntentId: 'pi_api_paid',
    chargeId: 'ch_api_paid',
    paymentSource: 'payment_intent',
    priceId: 'price_api_starter',
    plan: 'monthly',
    amount: 4_900,
    currency: 'usd',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    invoiceCreatedAt: INVOICE_CREATED,
    paidAt: PAID_AT,
    subscriptionStatus: 'active',
    refundReference: {
      invoicePaymentId: 'inpay_api_paid',
      invoiceId: 'in_api_paid',
      paymentIntentId: 'pi_api_paid',
      chargeId: 'ch_api_paid',
      originalAmount: 4_900,
    },
    ...overrides,
  }
}

function appliedAck(overrides: Record<string, unknown> = {}) {
  return {
    status: 'applied',
    payment_id: PAYMENT_ID,
    ownership_id: OWNERSHIP_ID,
    subscription_status: 'applied',
    idempotent_replay: false,
    ...overrides,
  }
}

const stripe = {
  subscriptions: { retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args) },
} as unknown as Stripe

const supabase = { rpc: mockRpc } as unknown as SupabaseClient<Database>

describe('API tier paid Invoice authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRetrieveSubscription.mockResolvedValue(subscription())
    mockParseApiTierSubscriptionAuthority.mockReturnValue({
      userId: USER_ID,
      metadataUserId: USER_ID,
      metadataSupabaseUserId: USER_ID,
      stripeCustomerId: 'cus_api_owner',
      checkoutReservationId: RESERVATION_ID,
      stripePriceId: 'price_api_starter',
      plan: 'starter',
    })
    mockResolveApiTierCheckoutConfirmation.mockResolvedValue({
      sessionId: 'cs_api_paid',
      sessionCreated: SESSION_CREATED,
      checkoutPlan: 'starter',
      checkoutPriceId: 'price_api_starter',
    })
    mockResolveRecurringInvoiceAuthority.mockResolvedValue(paymentAuthority())
    mockRpc.mockResolvedValue({ data: appliedAck(), error: null })
    mockRecordRecurringAuthorityReview.mockResolvedValue(undefined)
  })

  it('commits one exact fresh Checkout, Subscription and paid Invoice graph', async () => {
    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).resolves.toEqual({ status: 'applied', idempotentReplay: false })

    expect(mockRetrieveSubscription).toHaveBeenCalledWith('sub_api_current')
    expect(mockResolveApiTierCheckoutConfirmation).toHaveBeenCalledWith(
      stripe,
      expect.objectContaining({ id: 'sub_api_current', status: 'active' }),
      expect.objectContaining({ checkoutReservationId: RESERVATION_ID }),
      event
    )
    expect(mockResolveRecurringInvoiceAuthority).toHaveBeenCalledWith(
      stripe,
      expect.objectContaining({ id: 'in_api_paid' }),
      expect.objectContaining({
        expectedUserId: USER_ID,
        expectedCustomerId: 'cus_api_owner',
        expectedLivemode: true,
        products: expect.objectContaining({
          expectedRecurringAmountsByPrice: { price_api_starter: 4_900 },
        }),
      })
    )
    expect(mockRpc).toHaveBeenCalledWith('apply_api_tier_paid_invoice_event_atomic', {
      p_event_id: 'evt_api_paid',
      p_event_created_at: '2027-01-15T08:00:00.000Z',
      p_event_type: 'invoice.paid',
      p_livemode: true,
      p_user_id: USER_ID,
      p_metadata_user_id: USER_ID,
      p_metadata_supabase_user_id: USER_ID,
      p_stripe_customer_id: 'cus_api_owner',
      p_checkout_reservation_id: RESERVATION_ID,
      p_checkout_session_id: 'cs_api_paid',
      p_session_created_at: '2023-11-14T22:12:20.000Z',
      p_stripe_subscription_id: 'sub_api_current',
      p_subscription_created: SUBSCRIPTION_CREATED,
      p_subscription_status: 'active',
      p_stripe_invoice_id: 'in_api_paid',
      p_stripe_invoice_payment_id: 'inpay_api_paid',
      p_stripe_payment_intent_id: 'pi_api_paid',
      p_stripe_charge_id: 'ch_api_paid',
      p_stripe_price_id: 'price_api_starter',
      p_api_plan: 'starter',
      p_amount_paid: 4_900,
      p_currency: 'usd',
      p_period_start: '2023-11-14T22:13:20.000Z',
      p_period_end: '2023-12-14T22:13:20.000Z',
      p_invoice_created_at: '2023-11-14T22:15:00.000Z',
      p_paid_at: '2023-11-14T22:16:40.000Z',
    })
    expect(mockRecordRecurringAuthorityReview).not.toHaveBeenCalled()
  })

  it('accepts the exact recovery-blocked ACK without granting quota', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'account_recovery_billing_blocked',
        payment_id: PAYMENT_ID,
        ownership_id: OWNERSHIP_ID,
        recovery_operation_id: RECOVERY_OPERATION_ID,
        refund_effect_id: REFUND_EFFECT_ID,
        cancellation_effect_id: CANCEL_EFFECT_ID,
        stripe_subscription_id: 'sub_api_current',
        idempotent_replay: true,
      },
      error: null,
    })

    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).resolves.toEqual({
      status: 'account_recovery_billing_blocked',
      idempotentReplay: true,
    })
  })

  it('durably records a central ownership conflict for manual review', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'identity_conflict' }, error: null })

    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).resolves.toEqual({
      status: 'authority_review_recorded',
      reviewCode: 'identity_conflict',
    })
    expect(mockRecordRecurringAuthorityReview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'invoice',
        objectId: 'in_api_paid',
        userId: USER_ID,
        error: expect.any(StripeAuthorityError),
      })
    )
  })

  it.each([
    ['extra key', appliedAck({ unexpected: true })],
    ['uppercase payment id', appliedAck({ payment_id: PAYMENT_ID.toUpperCase() })],
    ['unknown subscription ACK', appliedAck({ subscription_status: 'blocked' })],
    [
      'wrong blocked Subscription',
      {
        status: 'account_recovery_billing_blocked',
        payment_id: PAYMENT_ID,
        ownership_id: OWNERSHIP_ID,
        recovery_operation_id: RECOVERY_OPERATION_ID,
        refund_effect_id: REFUND_EFFECT_ID,
        cancellation_effect_id: CANCEL_EFFECT_ID,
        stripe_subscription_id: 'sub_other',
        idempotent_replay: false,
      },
    ],
  ])('rejects malformed database acknowledgement: %s', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).rejects.toThrow('invalid acknowledgement')
  })

  it.each([
    ['past_due Subscription', subscription({ status: 'past_due' })],
    ['cross-mode Subscription', subscription({ livemode: false })],
    ['Subscription after Invoice', subscription({ created: INVOICE_CREATED + 1 })],
  ])('records deterministic non-entitling authority for %s', async (_label, snapshot) => {
    mockRetrieveSubscription.mockResolvedValue(snapshot)

    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).resolves.toEqual({
      status: 'authority_review_recorded',
      reviewCode: 'invalid_payment_state',
    })
    expect(mockResolveRecurringInvoiceAuthority).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('records a missing reservation instead of inventing Checkout identity', async () => {
    mockParseApiTierSubscriptionAuthority.mockReturnValue({
      userId: USER_ID,
      metadataUserId: USER_ID,
      metadataSupabaseUserId: USER_ID,
      stripeCustomerId: 'cus_api_owner',
      checkoutReservationId: null,
      stripePriceId: 'price_api_starter',
      plan: 'starter',
    })

    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).resolves.toEqual({
      status: 'authority_review_recorded',
      reviewCode: 'identity_missing',
    })
    expect(mockResolveApiTierCheckoutConfirmation).not.toHaveBeenCalled()
  })

  it('records a Checkout product mismatch before resolving money', async () => {
    mockResolveApiTierCheckoutConfirmation.mockResolvedValue({
      sessionId: 'cs_api_paid',
      sessionCreated: SESSION_CREATED,
      checkoutPlan: 'pro',
      checkoutPriceId: 'price_api_pro',
    })

    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).resolves.toEqual({
      status: 'authority_review_recorded',
      reviewCode: 'identity_conflict',
    })
    expect(mockResolveRecurringInvoiceAuthority).not.toHaveBeenCalled()
  })

  it.each([
    ['paid before Invoice', { paidAt: INVOICE_CREATED - 1 }],
    ['paid after event', { paidAt: EVENT_CREATED + 1 }],
    ['paid outside period', { periodEnd: PAID_AT }],
    ['non-active resolved status', { subscriptionStatus: 'past_due' }],
  ])('records contradictory resolved payment chronology: %s', async (_label, overrides) => {
    mockResolveRecurringInvoiceAuthority.mockResolvedValue(paymentAuthority(overrides))

    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).resolves.toEqual({
      status: 'authority_review_recorded',
      reviewCode: 'object_mismatch',
    })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('keeps Stripe retrieval failures retryable', async () => {
    mockRetrieveSubscription.mockRejectedValue(new Error('Stripe unavailable'))

    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).rejects.toThrow('Stripe unavailable')
    expect(mockRecordRecurringAuthorityReview).not.toHaveBeenCalled()
  })

  it('keeps atomic persistence failures retryable', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    await expect(
      applyExactApiTierInvoicePayment({ stripe, supabase, invoice: invoice(), event })
    ).rejects.toThrow('API paid Invoice persistence failed: database unavailable')
    expect(mockRecordRecurringAuthorityReview).not.toHaveBeenCalled()
  })
})
