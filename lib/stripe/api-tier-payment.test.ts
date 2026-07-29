import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

jest.mock('@/lib/stripe', () => ({
  API_TIER_LIMITS: { free: 100, starter: 10_000, pro: 0 },
  STRIPE_API_PRICE_IDS: {
    starter: 'price_api_starter',
    pro: 'price_api_pro',
  },
  STRIPE_PRICE_IDS: {
    monthly: 'price_pro_monthly',
    yearly: 'price_pro_yearly',
    lifetime: 'price_pro_lifetime',
  },
  SUBSCRIPTION_STATUS_MAP: {},
  stripe: {},
}))

import {
  recordApiTierInvoicePayment,
  resolveApiTierInvoicePaymentAuthority,
} from './api-tier-payment'
import { StripeAuthorityError } from './entitlement-authority'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = 'cus_api_owner'
const SUBSCRIPTION_ID = 'sub_api_starter'
const INVOICE_ID = 'in_api_starter'
const CHARGE_ID = 'ch_api_starter'

const apiMetadata = {
  api_plan: 'starter',
  api_tier_reservation_id: RESERVATION_ID,
  supabase_user_id: USER_ID,
  type: 'api_tier',
  userId: USER_ID,
}

function invoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: INVOICE_ID,
    object: 'invoice',
    amount_due: 4_900,
    amount_overpaid: 0,
    amount_paid: 4_900,
    amount_remaining: 0,
    created: 1_900,
    currency: 'usd',
    customer: CUSTOMER_ID,
    discounts: [],
    ending_balance: 0,
    livemode: true,
    metadata: {},
    parent: {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: {
        subscription: SUBSCRIPTION_ID,
        metadata: apiMetadata,
      },
    },
    starting_balance: 0,
    status: 'paid',
    subtotal: 4_900,
    total: 4_900,
    total_discount_amounts: [],
    total_taxes: [],
    ...overrides,
  } as Stripe.Invoice
}

function subscription(): Stripe.Subscription {
  return {
    id: SUBSCRIPTION_ID,
    object: 'subscription',
    customer: CUSTOMER_ID,
    currency: 'usd',
    items: {
      data: [
        {
          id: 'si_api_starter',
          current_period_start: 2_000,
          current_period_end: 3_000,
          price: { id: 'price_api_starter', currency: 'usd' },
          quantity: 1,
        },
      ],
    },
    livemode: true,
    metadata: apiMetadata,
    status: 'active',
  } as unknown as Stripe.Subscription
}

function customer(): Stripe.Customer {
  return {
    id: CUSTOMER_ID,
    object: 'customer',
    livemode: true,
    metadata: {
      userId: USER_ID,
      supabase_user_id: USER_ID,
    },
  } as Stripe.Customer
}

function line(): Stripe.InvoiceLineItem {
  return {
    id: 'il_api_starter',
    object: 'line_item',
    currency: 'usd',
    invoice: INVOICE_ID,
    parent: {
      type: 'subscription_item_details',
      invoice_item_details: null,
      subscription_item_details: {
        invoice_item: null,
        proration: false,
        proration_details: null,
        subscription: SUBSCRIPTION_ID,
        subscription_item: 'si_api_starter',
      },
    },
    period: { start: 2_000, end: 3_000 },
    pricing: {
      type: 'price_details',
      price_details: { price: 'price_api_starter', product: 'prod_api_starter' },
      unit_amount_decimal: '4900',
    },
    quantity: 1,
    subscription: SUBSCRIPTION_ID,
  } as Stripe.InvoiceLineItem
}

function invoicePayment(
  id: string,
  status: Stripe.InvoicePayment.Status = 'open'
): Stripe.InvoicePayment {
  return {
    id,
    object: 'invoice_payment',
    amount_paid: status === 'paid' ? 4_900 : null,
    amount_requested: 4_900,
    created: 2_000,
    currency: 'usd',
    invoice: INVOICE_ID,
    is_default: true,
    livemode: true,
    payment: {
      type: 'charge',
      charge: CHARGE_ID,
      payment_intent: null,
      payment_record: null,
    },
    status,
    status_transitions: {
      paid_at: status === 'paid' ? 2_010 : null,
      canceled_at: null,
    },
  } as Stripe.InvoicePayment
}

function charge(): Stripe.Charge {
  return {
    id: CHARGE_ID,
    object: 'charge',
    amount: 4_900,
    amount_captured: 4_900,
    captured: true,
    created: 2_010,
    currency: 'usd',
    customer: CUSTOMER_ID,
    livemode: true,
    metadata: {},
    paid: true,
    payment_intent: null,
    status: 'succeeded',
  } as Stripe.Charge
}

function stripeHarness() {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    invoicePayment(`inpay_open_${String(index).padStart(3, '0')}`)
  )
  const paid = invoicePayment('inpay_paid_direct', 'paid')
  const listPayments = jest.fn(async (params: Stripe.InvoicePaymentListParams) =>
    params.starting_after ? { data: [paid], has_more: false } : { data: firstPage, has_more: true }
  )
  const stripe = {
    invoices: {
      retrieve: jest.fn(async () => invoice()),
      listLineItems: jest.fn(async () => ({ data: [line()], has_more: false })),
    },
    subscriptions: {
      retrieve: jest.fn(async () => subscription()),
    },
    customers: {
      retrieve: jest.fn(async () => customer()),
    },
    invoicePayments: {
      list: listPayments,
    },
    paymentIntents: {
      retrieve: jest.fn(),
    },
    charges: {
      retrieve: jest.fn(async () => charge()),
    },
  } as unknown as Stripe
  return { stripe, listPayments }
}

const observation = {
  type: 'invoice.paid' as const,
  id: 'evt_api_invoice_paid',
  created: 2_100,
  livemode: true,
}

describe('API tier paid-Invoice authority', () => {
  it('paginates beyond 100 InvoicePayments and supports a direct Charge without guessing a PI', async () => {
    const test = stripeHarness()

    const authority = await resolveApiTierInvoicePaymentAuthority({
      stripe: test.stripe,
      invoice: invoice({ amount_paid: -1 }),
      observation,
    })

    expect(authority).toMatchObject({
      userId: USER_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      invoiceId: INVOICE_ID,
      invoicePaymentId: 'inpay_paid_direct',
      paymentIntentId: null,
      chargeId: CHARGE_ID,
      paymentSource: 'charge',
      priceId: 'price_api_starter',
      plan: 'starter',
      amount: 4_900,
      currency: 'usd',
      checkoutReservationId: RESERVATION_ID,
      livemode: true,
    })
    expect(test.listPayments).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        invoice: INVOICE_ID,
        starting_after: 'inpay_open_099',
      })
    )
    expect((test.stripe.paymentIntents.retrieve as unknown as jest.Mock).mock.calls).toHaveLength(0)
  })

  it('rejects a webhook mode mismatch before persisting financial ownership', async () => {
    const test = stripeHarness()

    await expect(
      resolveApiTierInvoicePaymentAuthority({
        stripe: test.stripe,
        invoice: INVOICE_ID,
        observation: { ...observation, livemode: false },
      })
    ).rejects.toMatchObject<Partial<StripeAuthorityError>>({
      name: 'StripeAuthorityError',
      code: 'object_mismatch',
      stage: 'invoice',
    })
  })

  it('persists the full signed observation and nullable PaymentIntent identity', async () => {
    const test = stripeHarness()
    const authority = await resolveApiTierInvoicePaymentAuthority({
      stripe: test.stripe,
      invoice: INVOICE_ID,
      observation,
    })
    const rpc = jest.fn().mockResolvedValue({
      data: { status: 'recorded', projection_status: 'reprojected', should_cancel: false },
      error: null,
    })

    await expect(
      recordApiTierInvoicePayment({
        supabase: { rpc } as unknown as SupabaseClient<Database>,
        authority,
        observation,
      })
    ).resolves.toMatchObject({
      status: 'recorded',
      projectionStatus: 'reprojected',
      shouldCancel: false,
    })

    expect(rpc).toHaveBeenCalledWith(
      'record_api_tier_payment_atomic',
      expect.objectContaining({
        p_livemode: true,
        p_stripe_payment_intent_id: null,
        p_stripe_charge_id: CHARGE_ID,
        p_observation_id: observation.id,
        p_observation_created: observation.created,
        p_observation_type: observation.type,
      })
    )
  })
})
