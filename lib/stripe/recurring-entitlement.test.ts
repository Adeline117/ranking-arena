import type Stripe from 'stripe'

const mockResolveRecurringInvoiceAuthority = jest.fn()
const mockRetrieveSubscription = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/stripe/entitlement-authority', () => {
  const actual = jest.requireActual('@/lib/stripe/entitlement-authority')
  return {
    ...actual,
    resolveRecurringInvoiceAuthority: (...args: unknown[]) =>
      mockResolveRecurringInvoiceAuthority(...args),
  }
})

jest.mock('@/lib/stripe/entitlement-runtime', () => ({
  stripeEntitlementAuthorityOptions: () => ({
    products: {
      prices: {
        monthly: ['price_pro_monthly'],
        yearly: ['price_pro_yearly'],
        lifetime: ['price_pro_lifetime'],
      },
      expectedCurrency: 'usd',
    },
  }),
}))

import { StripeAuthorityError } from '@/lib/stripe/entitlement-authority'
import {
  activateRecurringInvoiceEntitlement,
  type SafeRecurringActivationStatus,
} from './recurring-entitlement'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222'
const OPERATION_ID = '33333333-3333-4333-8333-333333333333'
const NONCE = '44444444-4444-4444-8444-444444444444'

const AUTHORITY = {
  kind: 'recurring_payment' as const,
  userId: USER_ID,
  customerId: 'cus_owner',
  subscriptionId: 'sub_current',
  invoiceId: 'in_paid',
  invoicePaymentId: 'ipmt_paid',
  paymentIntentId: 'pi_paid',
  chargeId: 'ch_paid',
  paymentSource: 'payment_intent' as const,
  priceId: 'price_pro_monthly',
  plan: 'monthly' as const,
  amount: 499,
  currency: 'usd',
  periodStart: 1_800_000_000,
  periodEnd: 1_802_592_000,
  invoiceCreatedAt: 1_800_000_000,
  paidAt: 1_800_000_100,
  subscriptionStatus: 'active' as const,
  refundReference: {
    invoicePaymentId: 'ipmt_paid',
    invoiceId: 'in_paid',
    paymentIntentId: 'pi_paid',
    chargeId: 'ch_paid',
    originalAmount: 499,
  },
}

function subscription(
  metadataOverrides: Record<string, string> = {},
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return {
    id: 'sub_current',
    livemode: true,
    customer: 'cus_owner',
    status: 'active',
    metadata: {
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
      ...metadataOverrides,
    },
    items: {
      data: [{ quantity: 1, price: { id: 'price_pro_monthly' } }],
    },
    ...overrides,
  } as Stripe.Subscription
}

function stripeClient() {
  return {
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args),
    },
  } as unknown as Stripe
}

function supabaseClient() {
  return {
    rpc: (...args: unknown[]) => mockRpc(...args),
  } as never
}

describe('recurring Pro Invoice entitlement activation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveRecurringInvoiceAuthority.mockResolvedValue(AUTHORITY)
    mockRetrieveSubscription.mockResolvedValue(subscription())
    mockRpc.mockImplementation((name: string) => {
      if (name === 'assert_recurring_pro_checkout_completed_atomic') {
        return Promise.resolve({ data: 'completed', error: null })
      }
      if (name === 'activate_recurring_entitlement_payment_atomic') {
        return Promise.resolve({ data: { status: 'activated' }, error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
  })

  it('requires the exact completed-checkout identity before activating the paid ledger', async () => {
    const stripe = stripeClient()
    const supabase = supabaseClient()

    await expect(
      activateRecurringInvoiceEntitlement({
        stripe,
        supabase,
        invoice: 'in_paid',
        livemode: true,
      })
    ).resolves.toEqual({
      status: 'activated',
      authority: AUTHORITY,
    })

    expect(mockResolveRecurringInvoiceAuthority).toHaveBeenCalledWith(
      stripe,
      'in_paid',
      expect.objectContaining({
        expectedLivemode: true,
        products: expect.objectContaining({ expectedCurrency: 'usd' }),
      })
    )
    expect(mockRetrieveSubscription).toHaveBeenCalledWith('sub_current')
    expect(mockRpc.mock.calls).toEqual([
      [
        'assert_recurring_pro_checkout_completed_atomic',
        {
          p_user_id: USER_ID,
          p_livemode: true,
          p_stripe_customer_id: 'cus_owner',
          p_stripe_subscription_id: 'sub_current',
          p_reservation_id: RESERVATION_ID,
          p_operation_id: OPERATION_ID,
          p_reservation_nonce: NONCE,
          p_plan: 'monthly',
          p_stripe_price_id: 'price_pro_monthly',
          p_trial_requested: false,
        },
      ],
      [
        'activate_recurring_entitlement_payment_atomic',
        {
          p_user_id: USER_ID,
          p_stripe_customer_id: 'cus_owner',
          p_stripe_subscription_id: 'sub_current',
          p_stripe_invoice_id: 'in_paid',
          p_stripe_payment_intent_id: 'pi_paid',
          p_stripe_charge_id: 'ch_paid',
          p_plan: 'monthly',
          p_amount_paid: 499,
          p_currency: 'usd',
          p_livemode: true,
          p_period_start: '2027-01-15T08:00:00.000Z',
          p_period_end: '2027-02-14T08:00:00.000Z',
          p_payment_status: 'paid',
          p_stripe_subscription_status: 'active',
        },
      ],
    ])
  })

  it.each([
    ['extra metadata key', { extra: 'unsafe' }],
    ['missing reservation', { pro_checkout_reservation_id: '' }],
    ['malformed nonce', { pro_checkout_nonce: 'not-a-uuid' }],
    ['changed plan', { plan: 'yearly' }],
    ['changed Customer', { stripe_customer_id: 'cus_other' }],
    ['changed price', { stripe_price_id: 'price_pro_yearly' }],
    ['changed user', { userId: '55555555-5555-4555-8555-555555555555' }],
    ['invalid trial marker', { trial_requested: '0' }],
  ])('rejects a Subscription with %s', async (_label, metadata) => {
    mockRetrieveSubscription.mockResolvedValue(subscription(metadata))

    await expect(
      activateRecurringInvoiceEntitlement({
        stripe: stripeClient(),
        supabase: supabaseClient(),
        invoice: 'in_paid',
        livemode: true,
      })
    ).rejects.toMatchObject<Partial<StripeAuthorityError>>({
      name: 'StripeAuthorityError',
      code: 'identity_conflict',
      stage: 'subscription',
    })

    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects a cross-mode Subscription before any ledger write', async () => {
    mockRetrieveSubscription.mockResolvedValue(subscription({}, { livemode: false }))

    await expect(
      activateRecurringInvoiceEntitlement({
        stripe: stripeClient(),
        supabase: supabaseClient(),
        invoice: 'in_paid',
        livemode: true,
      })
    ).rejects.toMatchObject({
      code: 'identity_conflict',
      stage: 'subscription',
    })

    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['amount', { amount: 500 }, 'amount_mismatch'],
    ['currency', { currency: 'eur' }, 'currency_mismatch'],
  ])('rejects a mismatched configured %s before checkout assertion', async (_, delta, code) => {
    mockResolveRecurringInvoiceAuthority.mockResolvedValue({
      ...AUTHORITY,
      ...delta,
    })

    await expect(
      activateRecurringInvoiceEntitlement({
        stripe: stripeClient(),
        supabase: supabaseClient(),
        invoice: 'in_paid',
        livemode: true,
      })
    ).rejects.toMatchObject({ code, stage: 'product' })

    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when the completed-checkout assertion is unavailable', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'reservation lock timeout' },
    })

    await expect(
      activateRecurringInvoiceEntitlement({
        stripe: stripeClient(),
        supabase: supabaseClient(),
        invoice: 'in_paid',
        livemode: true,
      })
    ).rejects.toThrow('Recurring Pro checkout completion is not ready')

    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it.each(['identity_conflict', 'pending', null])(
    'accepts only completed from checkout assertion, not %s',
    async (status) => {
      mockRpc.mockResolvedValueOnce({ data: status, error: null })

      await expect(
        activateRecurringInvoiceEntitlement({
          stripe: stripeClient(),
          supabase: supabaseClient(),
          invoice: 'in_paid',
          livemode: true,
        })
      ).rejects.toThrow('assert_recurring_pro_checkout_completed_atomic returned')

      expect(mockRpc).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves a direct-Charge Invoice payment without inventing a PaymentIntent', async () => {
    mockResolveRecurringInvoiceAuthority.mockResolvedValue({
      ...AUTHORITY,
      paymentIntentId: null,
      paymentSource: 'charge',
      refundReference: {
        ...AUTHORITY.refundReference,
        paymentIntentId: null,
      },
    })

    await activateRecurringInvoiceEntitlement({
      stripe: stripeClient(),
      supabase: supabaseClient(),
      invoice: 'in_paid',
      livemode: true,
    })

    expect(mockRpc).toHaveBeenLastCalledWith(
      'activate_recurring_entitlement_payment_atomic',
      expect.objectContaining({ p_stripe_payment_intent_id: null })
    )
  })

  it.each<SafeRecurringActivationStatus>([
    'activated',
    'already_activated',
    'current_entitlement_protected',
    'identity_conflict',
    'manual_review',
    'parallel_subscription_review',
    'refunded_payment',
    'stale_payment',
    'stripe_status_not_entitling',
    'subject_deleted',
  ])('accepts the durable activation outcome %s', async (status) => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'assert_recurring_pro_checkout_completed_atomic') {
        return Promise.resolve({ data: 'completed', error: null })
      }
      return Promise.resolve({ data: { status }, error: null })
    })

    await expect(
      activateRecurringInvoiceEntitlement({
        stripe: stripeClient(),
        supabase: supabaseClient(),
        invoice: 'in_paid',
        livemode: true,
      })
    ).resolves.toMatchObject({ status })
  })

  it.each([
    { data: { status: 'unsafe_future_status' }, error: null },
    { data: null, error: null },
    { data: [], error: null },
    { data: null, error: { message: 'activation unavailable' } },
  ])('rejects an unsafe or unavailable activation result %#', async (activationResult) => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'assert_recurring_pro_checkout_completed_atomic') {
        return Promise.resolve({ data: 'completed', error: null })
      }
      return Promise.resolve(activationResult)
    })

    await expect(
      activateRecurringInvoiceEntitlement({
        stripe: stripeClient(),
        supabase: supabaseClient(),
        invoice: 'in_paid',
        livemode: true,
      })
    ).rejects.toThrow()
  })
})
