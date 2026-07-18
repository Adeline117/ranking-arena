import type Stripe from 'stripe'
import {
  resolveCheckoutSessionAuthority,
  resolveRecurringInvoiceAuthority,
  resolveSubscriptionAuthority,
  StripeAuthorityError,
  type StripeAuthorityClient,
  type StripeAuthorityOptions,
} from './entitlement-authority'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = 'cus_owner'
const SUBSCRIPTION_ID = 'sub_pro'

const options: StripeAuthorityOptions = {
  products: {
    prices: {
      monthly: ['price_monthly'],
      yearly: ['price_yearly'],
      lifetime: ['price_lifetime'],
    },
    expectedCurrency: 'usd',
  },
  expectedUserId: USER_ID,
}

type Scenario = {
  customers: Record<string, Stripe.Customer>
  subscriptions: Record<string, Stripe.Subscription>
  invoices: Record<string, Stripe.Invoice>
  invoiceLines: Record<string, Stripe.InvoiceLineItem[]>
  invoicePayments: Record<string, Stripe.InvoicePayment[]>
  paymentIntents: Record<string, Stripe.PaymentIntent>
  charges: Record<string, Stripe.Charge>
  sessions: Record<string, Stripe.Checkout.Session>
  sessionLines: Record<string, Stripe.LineItem[]>
}

function customer(userId = USER_ID): Stripe.Customer {
  return {
    id: CUSTOMER_ID,
    object: 'customer',
    metadata: { userId, supabase_user_id: userId },
  } as unknown as Stripe.Customer
}

function subscription(
  latestInvoice: string | null = 'in_paid',
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return {
    id: SUBSCRIPTION_ID,
    object: 'subscription',
    customer: CUSTOMER_ID,
    currency: 'usd',
    latest_invoice: latestInvoice,
    metadata: { userId: USER_ID, supabase_user_id: USER_ID },
    status: 'active',
    items: {
      data: [
        {
          id: 'si_pro',
          object: 'subscription_item',
          current_period_start: 2_000,
          current_period_end: 3_000,
          price: { id: 'price_monthly', currency: 'usd' },
          quantity: 1,
        },
      ],
    },
    trial_start: null,
    trial_end: null,
    ...overrides,
  } as unknown as Stripe.Subscription
}

function invoice(
  id = 'in_paid',
  periodStart = 2_000,
  periodEnd = 3_000,
  overrides: Partial<Stripe.Invoice> = {}
): Stripe.Invoice {
  return {
    id,
    object: 'invoice',
    amount_paid: 1_000,
    amount_remaining: 0,
    created: periodStart - 10,
    currency: 'usd',
    customer: CUSTOMER_ID,
    metadata: {},
    parent: {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: {
        subscription: SUBSCRIPTION_ID,
        metadata: { userId: USER_ID, supabase_user_id: USER_ID },
      },
    },
    period_start: periodStart,
    period_end: periodEnd,
    status: 'paid',
    ...overrides,
  } as unknown as Stripe.Invoice
}

function invoiceLine(
  id: string,
  periodStart: number,
  periodEnd: number,
  priceId = 'price_monthly',
  overrides: Partial<Stripe.InvoiceLineItem> = {}
): Stripe.InvoiceLineItem {
  return {
    id,
    object: 'line_item',
    currency: 'usd',
    invoice: id.replace('il_', 'in_'),
    parent: {
      type: 'subscription_item_details',
      invoice_item_details: null,
      subscription_item_details: {
        invoice_item: null,
        proration: false,
        proration_details: null,
        subscription: SUBSCRIPTION_ID,
        subscription_item: 'si_pro',
      },
    },
    period: { start: periodStart, end: periodEnd },
    pricing: {
      type: 'price_details',
      price_details: { price: priceId, product: 'prod_pro' },
      unit_amount_decimal: '1000',
    },
    quantity: 1,
    subscription: SUBSCRIPTION_ID,
    ...overrides,
  } as unknown as Stripe.InvoiceLineItem
}

function invoicePayment(
  id = 'inpay_paid',
  paymentIntentId = 'pi_paid',
  overrides: Partial<Stripe.InvoicePayment> = {}
): Stripe.InvoicePayment {
  return {
    id,
    object: 'invoice_payment',
    amount_paid: 1_000,
    amount_requested: 1_000,
    created: 2_001,
    currency: 'usd',
    invoice: 'in_paid',
    is_default: true,
    livemode: true,
    payment: { type: 'payment_intent', payment_intent: paymentIntentId },
    status: 'paid',
    status_transitions: { paid_at: 2_002, canceled_at: null },
    ...overrides,
  } as unknown as Stripe.InvoicePayment
}

function paymentIntent(
  id = 'pi_paid',
  chargeId = 'ch_paid',
  overrides: Partial<Stripe.PaymentIntent> = {}
): Stripe.PaymentIntent {
  return {
    id,
    object: 'payment_intent',
    amount: 1_000,
    amount_received: 1_000,
    currency: 'usd',
    customer: CUSTOMER_ID,
    latest_charge: chargeId,
    metadata: {},
    status: 'succeeded',
    ...overrides,
  } as unknown as Stripe.PaymentIntent
}

function charge(
  id = 'ch_paid',
  paymentIntentId: string | null = 'pi_paid',
  overrides: Partial<Stripe.Charge> = {}
): Stripe.Charge {
  return {
    id,
    object: 'charge',
    amount: 1_000,
    amount_captured: 1_000,
    amount_refunded: 0,
    captured: true,
    created: 2_002,
    currency: 'usd',
    customer: CUSTOMER_ID,
    metadata: {},
    paid: true,
    payment_intent: paymentIntentId,
    refunded: false,
    status: 'succeeded',
    ...overrides,
  } as unknown as Stripe.Charge
}

function checkoutSession(
  id = 'cs_paid',
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return {
    id,
    object: 'checkout.session',
    amount_total: 1_000,
    created: 1_990,
    currency: 'usd',
    customer: CUSTOMER_ID,
    invoice: 'in_paid',
    metadata: { userId: USER_ID, supabase_user_id: USER_ID, plan: 'monthly' },
    mode: 'subscription',
    payment_intent: null,
    payment_status: 'paid',
    status: 'complete',
    subscription: SUBSCRIPTION_ID,
    ...overrides,
  } as unknown as Stripe.Checkout.Session
}

function checkoutLine(
  priceId = 'price_monthly',
  overrides: Partial<Stripe.LineItem> = {}
): Stripe.LineItem {
  return {
    id: `li_${priceId}`,
    object: 'item',
    amount_total: 1_000,
    currency: 'usd',
    price: { id: priceId },
    quantity: 1,
    ...overrides,
  } as unknown as Stripe.LineItem
}

function baseScenario(): Scenario {
  return {
    customers: { [CUSTOMER_ID]: customer() },
    subscriptions: { [SUBSCRIPTION_ID]: subscription() },
    invoices: { in_paid: invoice() },
    invoiceLines: { in_paid: [invoiceLine('il_paid', 2_000, 3_000)] },
    invoicePayments: { in_paid: [invoicePayment()] },
    paymentIntents: { pi_paid: paymentIntent() },
    charges: { ch_paid: charge() },
    sessions: { cs_paid: checkoutSession() },
    sessionLines: { cs_paid: [checkoutLine()] },
  }
}

function clientFor(scenario: Scenario): StripeAuthorityClient {
  return {
    checkout: {
      sessions: {
        retrieve: jest.fn(async (id: string) => scenario.sessions[id]),
        listLineItems: jest.fn(async (id: string) => ({
          data: scenario.sessionLines[id] ?? [],
          has_more: false,
        })),
      },
    },
    invoices: {
      retrieve: jest.fn(async (id: string) => scenario.invoices[id]),
      listLineItems: jest.fn(async (id: string) => ({
        data: scenario.invoiceLines[id] ?? [],
        has_more: false,
      })),
    },
    invoicePayments: {
      list: jest.fn(async (params) => ({
        data: scenario.invoicePayments[params.invoice ?? ''] ?? [],
        has_more: false,
      })),
    },
    subscriptions: {
      retrieve: jest.fn(async (id: string) => scenario.subscriptions[id]),
    },
    customers: {
      retrieve: jest.fn(async (id: string) => scenario.customers[id]),
    },
    paymentIntents: {
      retrieve: jest.fn(async (id: string) => scenario.paymentIntents[id]),
    },
    charges: {
      retrieve: jest.fn(async (id: string) => scenario.charges[id]),
    },
  }
}

async function expectAuthorityError(
  promise: Promise<unknown>,
  code: StripeAuthorityError['code']
): Promise<StripeAuthorityError> {
  try {
    await promise
    throw new Error('Expected StripeAuthorityError')
  } catch (error) {
    expect(error).toBeInstanceOf(StripeAuthorityError)
    const authorityError = error as StripeAuthorityError
    expect(authorityError.code).toBe(code)
    expect(authorityError.toReviewPayload()).toMatchObject({
      code,
      stage: expect.any(String),
      objectIds: expect.any(Object),
      details: expect.any(Object),
    })
    return authorityError
  }
}

describe('Stripe entitlement authority', () => {
  it('walks every InvoicePayments page and accepts only the paid payment', async () => {
    const scenario = baseScenario()
    const client = clientFor(scenario)
    const open = invoicePayment('inpay_open', 'pi_unused', {
      status: 'open',
      amount_paid: null,
      invoice: 'in_paid',
      payment: { type: 'payment_intent', payment_intent: 'pi_unused' },
    })
    const list = client.invoicePayments.list as jest.Mock
    list.mockImplementation(async (params: Stripe.InvoicePaymentListParams) => {
      if (!params.starting_after) return { data: [open], has_more: true }
      return { data: scenario.invoicePayments.in_paid, has_more: false }
    })

    const authority = await resolveRecurringInvoiceAuthority(client, 'in_paid', options)

    expect(authority).toMatchObject({
      kind: 'recurring_payment',
      invoiceId: 'in_paid',
      invoicePaymentId: 'inpay_paid',
      paymentIntentId: 'pi_paid',
      chargeId: 'ch_paid',
      periodStart: 2_000,
      periodEnd: 3_000,
    })
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ invoice: 'in_paid', starting_after: 'inpay_open' })
    )
  })

  it('keeps separate invoice periods on the same subscription', async () => {
    const scenario = baseScenario()
    scenario.invoices.in_old = invoice('in_old', 1_000, 2_000)
    scenario.invoices.in_new = invoice('in_new', 2_000, 3_000)
    scenario.invoiceLines.in_old = [invoiceLine('il_old', 1_000, 2_000)]
    scenario.invoiceLines.in_new = [invoiceLine('il_new', 2_000, 3_000)]
    scenario.invoicePayments.in_old = [invoicePayment('inpay_old', 'pi_old', { invoice: 'in_old' })]
    scenario.invoicePayments.in_new = [invoicePayment('inpay_new', 'pi_new', { invoice: 'in_new' })]
    scenario.paymentIntents.pi_old = paymentIntent('pi_old', 'ch_old')
    scenario.paymentIntents.pi_new = paymentIntent('pi_new', 'ch_new')
    scenario.charges.ch_old = charge('ch_old', 'pi_old')
    scenario.charges.ch_new = charge('ch_new', 'pi_new')
    scenario.subscriptions[SUBSCRIPTION_ID] = subscription('in_new')
    const client = clientFor(scenario)

    const oldAuthority = await resolveRecurringInvoiceAuthority(client, 'in_old', options)
    const currentAuthority = await resolveSubscriptionAuthority(client, SUBSCRIPTION_ID, options)

    expect(oldAuthority).toMatchObject({
      invoiceId: 'in_old',
      invoicePaymentId: 'inpay_old',
      periodStart: 1_000,
      periodEnd: 2_000,
    })
    expect(currentAuthority).toMatchObject({
      kind: 'recurring_payment',
      invoiceId: 'in_new',
      invoicePaymentId: 'inpay_new',
      periodStart: 2_000,
      periodEnd: 3_000,
    })
  })

  it('uses a delayed Checkout Session exact invoice and never follows latest_invoice', async () => {
    const scenario = baseScenario()
    scenario.invoices.in_old = invoice('in_old', 1_000, 2_000)
    scenario.invoices.in_new = invoice('in_new', 2_000, 3_000)
    scenario.invoiceLines.in_old = [invoiceLine('il_old', 1_000, 2_000)]
    scenario.invoiceLines.in_new = [invoiceLine('il_new', 2_000, 3_000)]
    scenario.invoicePayments.in_old = [invoicePayment('inpay_old', 'pi_old', { invoice: 'in_old' })]
    scenario.invoicePayments.in_new = [invoicePayment('inpay_new', 'pi_new', { invoice: 'in_new' })]
    scenario.paymentIntents.pi_old = paymentIntent('pi_old', 'ch_old')
    scenario.paymentIntents.pi_new = paymentIntent('pi_new', 'ch_new')
    scenario.charges.ch_old = charge('ch_old', 'pi_old')
    scenario.charges.ch_new = charge('ch_new', 'pi_new')
    scenario.subscriptions[SUBSCRIPTION_ID] = subscription('in_new')
    scenario.sessions.cs_delayed = checkoutSession('cs_delayed', { invoice: 'in_old' })
    scenario.sessionLines.cs_delayed = [checkoutLine()]
    const client = clientFor(scenario)

    const authority = await resolveCheckoutSessionAuthority(client, 'cs_delayed', options)

    expect(authority).toMatchObject({
      kind: 'recurring_payment',
      invoiceId: 'in_old',
      periodStart: 1_000,
      periodEnd: 2_000,
    })
    expect(client.invoices.retrieve).toHaveBeenCalledWith('in_old')
    expect(client.invoices.retrieve).not.toHaveBeenCalledWith('in_new')
  })

  it('fails closed with a durable payload when immutable/current/customer metadata conflict', async () => {
    const scenario = baseScenario()
    scenario.subscriptions[SUBSCRIPTION_ID] = subscription('in_paid', {
      metadata: { userId: OTHER_USER_ID },
    })
    const error = await expectAuthorityError(
      resolveRecurringInvoiceAuthority(clientFor(scenario), 'in_paid', options),
      'identity_conflict'
    )

    expect(error.toReviewPayload()).toMatchObject({
      objectIds: {
        customerId: CUSTOMER_ID,
        subscriptionId: SUBSCRIPTION_ID,
        invoiceId: 'in_paid',
      },
      details: {
        expectedUserId: USER_ID,
        identities: expect.arrayContaining([
          { source: 'subscription.metadata', userId: OTHER_USER_ID },
        ]),
      },
    })
  })

  it('rejects a paid PaymentRecord instead of treating it as product payment', async () => {
    const scenario = baseScenario()
    scenario.invoicePayments.in_paid = [
      invoicePayment('inpay_record', 'pi_unused', {
        invoice: 'in_paid',
        payment: { type: 'payment_record', payment_record: 'pyr_record' },
      }),
    ]

    await expectAuthorityError(
      resolveRecurringInvoiceAuthority(clientFor(scenario), 'in_paid', options),
      'unsupported_invoice_payment'
    )
  })

  it('rejects multiple paid invoice payments as ambiguous attribution', async () => {
    const scenario = baseScenario()
    scenario.invoicePayments.in_paid = [
      invoicePayment('inpay_first', 'pi_paid', { invoice: 'in_paid' }),
      invoicePayment('inpay_second', 'pi_second', { invoice: 'in_paid' }),
    ]

    await expectAuthorityError(
      resolveRecurringInvoiceAuthority(clientFor(scenario), 'in_paid', options),
      'ambiguous_invoice_payment'
    )
  })

  it.each([
    {
      name: 'PaymentIntent customer',
      mutate: (scenario: Scenario) => {
        scenario.paymentIntents.pi_paid = paymentIntent('pi_paid', 'ch_paid', {
          customer: 'cus_attacker',
        })
      },
      code: 'object_mismatch' as const,
    },
    {
      name: 'PaymentIntent state',
      mutate: (scenario: Scenario) => {
        scenario.paymentIntents.pi_paid = paymentIntent('pi_paid', 'ch_paid', {
          status: 'requires_action',
        })
      },
      code: 'invalid_payment_state' as const,
    },
    {
      name: 'Charge capture',
      mutate: (scenario: Scenario) => {
        scenario.charges.ch_paid = charge('ch_paid', 'pi_paid', {
          captured: false,
          amount_captured: 0,
        })
      },
      code: 'invalid_payment_state' as const,
    },
    {
      name: 'currency',
      mutate: (scenario: Scenario) => {
        scenario.paymentIntents.pi_paid = paymentIntent('pi_paid', 'ch_paid', {
          currency: 'eur',
        })
      },
      code: 'currency_mismatch' as const,
    },
    {
      name: 'amount',
      mutate: (scenario: Scenario) => {
        scenario.paymentIntents.pi_paid = paymentIntent('pi_paid', 'ch_paid', {
          amount_received: 999,
        })
      },
      code: 'amount_mismatch' as const,
    },
    {
      name: 'Charge PaymentIntent',
      mutate: (scenario: Scenario) => {
        scenario.charges.ch_paid = charge('ch_paid', 'pi_other')
      },
      code: 'object_mismatch' as const,
    },
  ])('rejects a mismatched $name', async ({ mutate, code }) => {
    const scenario = baseScenario()
    mutate(scenario)
    await expectAuthorityError(
      resolveRecurringInvoiceAuthority(clientFor(scenario), 'in_paid', options),
      code
    )
  })

  it('returns exact lifetime session, PaymentIntent, and Charge authority without guessing refunds', async () => {
    const scenario = baseScenario()
    scenario.sessions.cs_lifetime = checkoutSession('cs_lifetime', {
      invoice: null,
      metadata: { userId: USER_ID, supabase_user_id: USER_ID, plan: 'lifetime' },
      mode: 'payment',
      payment_intent: 'pi_lifetime',
      subscription: null,
    })
    scenario.sessionLines.cs_lifetime = [checkoutLine('price_lifetime')]
    scenario.paymentIntents.pi_lifetime = paymentIntent('pi_lifetime', 'ch_lifetime')
    scenario.charges.ch_lifetime = charge('ch_lifetime', 'pi_lifetime', {
      amount_refunded: 250,
      refunded: false,
    })
    const authority = await resolveCheckoutSessionAuthority(
      clientFor(scenario),
      'cs_lifetime',
      options
    )

    expect(authority).toEqual(
      expect.objectContaining({
        kind: 'lifetime_payment',
        sessionId: 'cs_lifetime',
        paymentIntentId: 'pi_lifetime',
        chargeId: 'ch_lifetime',
        priceId: 'price_lifetime',
        amount: 1_000,
        refundReference: {
          invoicePaymentId: null,
          invoiceId: null,
          paymentIntentId: 'pi_lifetime',
          chargeId: 'ch_lifetime',
          originalAmount: 1_000,
        },
      })
    )
    expect(authority).not.toHaveProperty('refunded')
    expect(authority).not.toHaveProperty('amountRefunded')
  })

  it('returns a strict trial authority without inventing a payment', async () => {
    const scenario = baseScenario()
    scenario.subscriptions[SUBSCRIPTION_ID] = subscription(null, {
      status: 'trialing',
      trial_start: 2_000,
      trial_end: 3_000,
      items: {
        data: [
          {
            id: 'si_trial',
            current_period_start: 2_000,
            current_period_end: 3_000,
            price: { id: 'price_monthly', currency: 'usd' },
            quantity: 1,
          },
        ],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    })
    const client = clientFor(scenario)

    const authority = await resolveSubscriptionAuthority(client, SUBSCRIPTION_ID, options)

    expect(authority).toEqual({
      kind: 'trial',
      userId: USER_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      priceId: 'price_monthly',
      plan: 'monthly',
      currency: 'usd',
      periodStart: 2_000,
      periodEnd: 3_000,
      trialStart: 2_000,
      trialEnd: 3_000,
      subscriptionStatus: 'trialing',
    })
    expect(client.invoices.retrieve).not.toHaveBeenCalled()
    expect(client.invoicePayments.list).not.toHaveBeenCalled()
  })

  it('does not turn a stale no-payment Checkout Session into current paid authority', async () => {
    const scenario = baseScenario()
    scenario.sessions.cs_old_trial = checkoutSession('cs_old_trial', {
      invoice: 'in_old_trial',
      payment_status: 'no_payment_required',
    })
    scenario.sessionLines.cs_old_trial = [checkoutLine()]
    scenario.subscriptions[SUBSCRIPTION_ID] = subscription('in_paid', { status: 'active' })
    const client = clientFor(scenario)

    await expectAuthorityError(
      resolveCheckoutSessionAuthority(client, 'cs_old_trial', options),
      'invalid_trial'
    )
    expect(client.invoices.retrieve).not.toHaveBeenCalled()
  })
})
