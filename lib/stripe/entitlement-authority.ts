import type Stripe from 'stripe'

export type ProPlan = 'monthly' | 'yearly'

export type StripeAuthorityProductConfig = {
  prices: {
    monthly: readonly string[]
    yearly: readonly string[]
    lifetime: readonly string[]
  }
  expectedCurrency?: string
}

export type StripeAuthorityOptions = {
  products: StripeAuthorityProductConfig
  expectedUserId?: string
}

export type StripeAuthorityObjectIds = {
  sessionId?: string
  customerId?: string
  subscriptionId?: string
  invoiceId?: string
  invoicePaymentId?: string
  paymentIntentId?: string
  chargeId?: string
}

export type StripeAuthorityErrorCode =
  | 'ambiguous_invoice_payment'
  | 'ambiguous_product'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'deleted_customer'
  | 'identity_conflict'
  | 'identity_missing'
  | 'invalid_object'
  | 'invalid_payment_state'
  | 'invalid_period'
  | 'invalid_session_state'
  | 'invalid_trial'
  | 'object_mismatch'
  | 'pagination_invariant'
  | 'unsupported_invoice_payment'
  | 'unsupported_product'

export type StripeAuthorityErrorStage =
  | 'charge'
  | 'checkout_session'
  | 'customer'
  | 'identity'
  | 'invoice'
  | 'invoice_lines'
  | 'invoice_payments'
  | 'payment_intent'
  | 'product'
  | 'subscription'
  | 'trial'

export type StripeAuthorityReviewPayload = {
  code: StripeAuthorityErrorCode
  stage: StripeAuthorityErrorStage
  message: string
  objectIds: StripeAuthorityObjectIds
  details: Record<string, unknown>
}

/**
 * A fail-closed error whose payload can be persisted without parsing a log
 * string. Callers should store `toReviewPayload()` in their durable review
 * queue before deciding whether an event can be acknowledged.
 */
export class StripeAuthorityError extends Error {
  readonly code: StripeAuthorityErrorCode
  readonly stage: StripeAuthorityErrorStage
  readonly objectIds: StripeAuthorityObjectIds
  readonly details: Record<string, unknown>

  constructor(payload: StripeAuthorityReviewPayload) {
    super(payload.message)
    this.name = 'StripeAuthorityError'
    this.code = payload.code
    this.stage = payload.stage
    this.objectIds = { ...payload.objectIds }
    this.details = { ...payload.details }
  }

  toReviewPayload(): StripeAuthorityReviewPayload {
    return {
      code: this.code,
      stage: this.stage,
      message: this.message,
      objectIds: { ...this.objectIds },
      details: { ...this.details },
    }
  }
}

export type StripePaymentReference = {
  invoicePaymentId: string | null
  invoiceId: string | null
  paymentIntentId: string | null
  chargeId: string
  /**
   * The original captured amount. Refund state is deliberately absent: the
   * refund reconciler must aggregate the authoritative Refund collection.
   */
  originalAmount: number
}

export type RecurringPaymentAuthority = {
  kind: 'recurring_payment'
  userId: string
  customerId: string
  subscriptionId: string
  invoiceId: string
  invoicePaymentId: string
  paymentIntentId: string | null
  chargeId: string
  paymentSource: 'payment_intent' | 'charge'
  priceId: string
  plan: ProPlan
  amount: number
  currency: string
  periodStart: number
  periodEnd: number
  invoiceCreatedAt: number
  paidAt: number
  subscriptionStatus: Stripe.Subscription.Status
  refundReference: StripePaymentReference
}

export type LifetimePaymentAuthority = {
  kind: 'lifetime_payment'
  userId: string
  customerId: string
  sessionId: string
  paymentIntentId: string
  chargeId: string
  priceId: string
  plan: 'lifetime'
  amount: number
  currency: string
  paidAt: number
  refundReference: StripePaymentReference
}

export type TrialAuthority = {
  kind: 'trial'
  userId: string
  customerId: string
  subscriptionId: string
  priceId: string
  plan: ProPlan
  currency: string
  periodStart: number
  periodEnd: number
  trialStart: number
  trialEnd: number
  subscriptionStatus: 'trialing'
}

/**
 * Identity and product authority carried by one signature-verified Stripe
 * subscription event snapshot. This deliberately does not imply payment:
 * non-entitling states must be reconciled against the exact local
 * payment/trial binding by `reconcile_recurring_subscription_state_atomic`.
 */
export type SubscriptionEventStateAuthority = {
  kind: 'subscription_state'
  userId: string
  customerId: string
  subscriptionId: string
  currentInvoiceId: string | null
  priceId: string
  plan: ProPlan
  currency: string
  periodStart: number
  periodEnd: number
  subscriptionStatus: Stripe.Subscription.Status
  cancelAtPeriodEnd: boolean
  canceledAt: number | null
}

export type CheckoutEntitlementAuthority =
  | RecurringPaymentAuthority
  | LifetimePaymentAuthority
  | TrialAuthority

type ListPage<T> = {
  data: T[]
  has_more: boolean
}

/**
 * Narrow structural client used by the resolver. A real Stripe 22.1.1 client
 * satisfies this interface, while tests can provide only the APIs exercised by
 * the authority path.
 */
export type StripeAuthorityClient = {
  checkout: {
    sessions: {
      retrieve(id: string): Promise<Stripe.Checkout.Session>
      listLineItems(
        id: string,
        params: Stripe.Checkout.SessionListLineItemsParams
      ): Promise<ListPage<Stripe.LineItem>>
    }
  }
  invoices: {
    retrieve(id: string): Promise<Stripe.Invoice>
    listLineItems(
      id: string,
      params: Stripe.InvoiceListLineItemsParams
    ): Promise<ListPage<Stripe.InvoiceLineItem>>
  }
  invoicePayments: {
    list(params: Stripe.InvoicePaymentListParams): Promise<ListPage<Stripe.InvoicePayment>>
  }
  subscriptions: {
    retrieve(id: string): Promise<Stripe.Subscription>
  }
  customers: {
    retrieve(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer>
  }
  paymentIntents: {
    retrieve(id: string, params: Stripe.PaymentIntentRetrieveParams): Promise<Stripe.PaymentIntent>
  }
  charges: {
    retrieve(id: string): Promise<Stripe.Charge>
  }
}

type IdentitySource = {
  source: string
  metadata: Stripe.Metadata | null | undefined
  required: boolean
}

type PaymentChain = {
  source: 'payment_intent' | 'charge'
  paymentIntentId: string | null
  chargeId: string
  amount: number
  currency: string
  paidAt: number
  paymentIntentMetadata?: Stripe.Metadata
  chargeMetadata: Stripe.Metadata
}

type ProductResolution = { plan: ProPlan; priceId: string } | { plan: 'lifetime'; priceId: string }

const USER_ID_METADATA_KEYS = ['supabase_user_id', 'userId', 'user_id'] as const
const PAGE_LIMIT = 100
const MAX_CHECKOUT_TO_TRIAL_START_SECONDS = 24 * 60 * 60

function authorityError(
  code: StripeAuthorityErrorCode,
  stage: StripeAuthorityErrorStage,
  message: string,
  objectIds: StripeAuthorityObjectIds = {},
  details: Record<string, unknown> = {}
): never {
  throw new StripeAuthorityError({ code, stage, message, objectIds, details })
}

function nonEmptyId(
  value: string | { id: string } | null | undefined,
  stage: StripeAuthorityErrorStage,
  label: string,
  prefix: string,
  objectIds: StripeAuthorityObjectIds = {}
): string {
  const id = typeof value === 'string' ? value.trim() : value?.id?.trim()
  if (!id || !id.startsWith(prefix)) {
    authorityError('invalid_object', stage, `${label} is missing or malformed`, objectIds, {
      label,
      value: id || null,
      expectedPrefix: prefix,
    })
  }
  return id
}

function assertSame(
  actual: string,
  expected: string,
  stage: StripeAuthorityErrorStage,
  label: string,
  objectIds: StripeAuthorityObjectIds
): void {
  if (actual !== expected) {
    authorityError('object_mismatch', stage, `${label} does not match`, objectIds, {
      label,
      expected,
      actual,
    })
  }
}

function normalizeCurrency(value: string): string {
  return value.trim().toLowerCase()
}

function assertCurrencies(
  values: Array<{ source: string; value: string | null | undefined }>,
  expectedCurrency: string | undefined,
  objectIds: StripeAuthorityObjectIds
): string {
  const normalized = values.map(({ source, value }) => ({
    source,
    value: value ? normalizeCurrency(value) : '',
  }))
  const missing = normalized.filter((entry) => !entry.value)
  if (missing.length > 0) {
    authorityError('currency_mismatch', 'product', 'Payment currency is missing', objectIds, {
      currencies: normalized,
    })
  }

  const distinct = [...new Set(normalized.map((entry) => entry.value))]
  const configured = expectedCurrency ? normalizeCurrency(expectedCurrency) : null
  if (distinct.length !== 1 || (configured && distinct[0] !== configured)) {
    authorityError('currency_mismatch', 'product', 'Payment currencies do not match', objectIds, {
      currencies: normalized,
      expectedCurrency: configured,
    })
  }
  return distinct[0]
}

function assertAmounts(
  values: Array<{ source: string; value: number | null | undefined }>,
  objectIds: StripeAuthorityObjectIds
): number {
  const invalid = values.filter(
    (entry) => !Number.isSafeInteger(entry.value) || (entry.value as number) <= 0
  )
  const distinct = [
    ...new Set(values.map((entry) => (typeof entry.value === 'number' ? entry.value : null))),
  ]
  if (invalid.length > 0 || distinct.length !== 1 || distinct[0] === null) {
    authorityError('amount_mismatch', 'product', 'Payment amounts do not match', objectIds, {
      amounts: values,
    })
  }
  return distinct[0]
}

function metadataIdentity(
  source: IdentitySource,
  objectIds: StripeAuthorityObjectIds
): string | null {
  const candidates = USER_ID_METADATA_KEYS.flatMap((key) => {
    const value = source.metadata?.[key]?.trim()
    return value ? [{ key, value }] : []
  })
  const distinct = [...new Set(candidates.map((candidate) => candidate.value))]
  if (distinct.length > 1) {
    authorityError(
      'identity_conflict',
      'identity',
      `Conflicting user metadata on ${source.source}`,
      objectIds,
      { source: source.source, candidates }
    )
  }
  if (distinct.length === 0 && source.required) {
    authorityError(
      'identity_missing',
      'identity',
      `User metadata is missing on ${source.source}`,
      objectIds,
      { source: source.source, acceptedKeys: USER_ID_METADATA_KEYS }
    )
  }
  return distinct[0] ?? null
}

function resolveIdentity(
  sources: IdentitySource[],
  expectedUserId: string | undefined,
  objectIds: StripeAuthorityObjectIds
): string {
  const identities = sources.flatMap((source) => {
    const userId = metadataIdentity(source, objectIds)
    return userId ? [{ source: source.source, userId }] : []
  })
  const distinct = [...new Set(identities.map((identity) => identity.userId))]
  const expected = expectedUserId?.trim()
  if (distinct.length !== 1 || (expected && distinct[0] !== expected)) {
    authorityError(
      'identity_conflict',
      'identity',
      'Stripe objects do not identify the same user',
      objectIds,
      { identities, expectedUserId: expected || null }
    )
  }
  return distinct[0]
}

function resolveConfiguredProduct(
  priceId: string,
  products: StripeAuthorityProductConfig,
  allowedPlans: ReadonlyArray<ProPlan | 'lifetime'>,
  objectIds: StripeAuthorityObjectIds
): ProductResolution {
  const matches = allowedPlans.filter((plan) => products.prices[plan].includes(priceId))
  if (matches.length === 0) {
    authorityError(
      'unsupported_product',
      'product',
      'Stripe price is not a Pro product',
      objectIds,
      {
        priceId,
        allowedPlans,
      }
    )
  }
  if (matches.length > 1) {
    authorityError(
      'ambiguous_product',
      'product',
      'Stripe price is mapped to multiple products',
      objectIds,
      { priceId, matches }
    )
  }
  const plan = matches[0]
  return plan === 'lifetime' ? { plan, priceId } : { plan, priceId }
}

async function listEveryPage<T extends { id: string }>(
  fetchPage: (startingAfter?: string) => Promise<ListPage<T>>,
  stage: StripeAuthorityErrorStage,
  objectIds: StripeAuthorityObjectIds
): Promise<T[]> {
  const all: T[] = []
  const cursors = new Set<string>()
  let startingAfter: string | undefined
  for (;;) {
    const page = await fetchPage(startingAfter)
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      authorityError('pagination_invariant', stage, 'Stripe list response is malformed', objectIds)
    }
    all.push(...page.data)
    if (!page.has_more) return all
    const cursor = page.data.at(-1)?.id
    if (!cursor || cursors.has(cursor)) {
      authorityError(
        'pagination_invariant',
        stage,
        'Stripe pagination did not advance',
        objectIds,
        { startingAfter: startingAfter ?? null, cursor: cursor ?? null }
      )
    }
    cursors.add(cursor)
    startingAfter = cursor
  }
}

async function retrieveCustomer(
  client: StripeAuthorityClient,
  customerId: string,
  objectIds: StripeAuthorityObjectIds
): Promise<Stripe.Customer> {
  const customer = await client.customers.retrieve(customerId)
  if ('deleted' in customer && customer.deleted) {
    authorityError('deleted_customer', 'customer', 'Stripe customer is deleted', objectIds)
  }
  assertSame(customer.id, customerId, 'customer', 'customer.id', objectIds)
  return customer as Stripe.Customer
}

async function retrieveCharge(
  client: StripeAuthorityClient,
  chargeValue: string | Stripe.Charge | null | undefined,
  expectedCustomerId: string,
  expectedPaymentIntentId: string | null,
  objectIds: StripeAuthorityObjectIds
): Promise<Stripe.Charge> {
  const chargeId = nonEmptyId(chargeValue, 'charge', 'charge', 'ch_', objectIds)
  objectIds.chargeId = chargeId
  const charge = await client.charges.retrieve(chargeId)
  assertSame(charge.id, chargeId, 'charge', 'charge.id', objectIds)
  const chargeCustomerId = nonEmptyId(
    charge.customer,
    'charge',
    'charge.customer',
    'cus_',
    objectIds
  )
  assertSame(chargeCustomerId, expectedCustomerId, 'charge', 'charge.customer', objectIds)

  if (expectedPaymentIntentId) {
    const chargePaymentIntentId = nonEmptyId(
      charge.payment_intent,
      'charge',
      'charge.payment_intent',
      'pi_',
      objectIds
    )
    assertSame(
      chargePaymentIntentId,
      expectedPaymentIntentId,
      'charge',
      'charge.payment_intent',
      objectIds
    )
  } else if (charge.payment_intent !== null) {
    authorityError(
      'object_mismatch',
      'charge',
      'Direct-charge InvoicePayment unexpectedly has a PaymentIntent',
      objectIds,
      { paymentIntentId: nonEmptyId(charge.payment_intent, 'charge', 'payment_intent', 'pi_') }
    )
  }

  if (!charge.paid || !charge.captured || charge.status !== 'succeeded') {
    authorityError(
      'invalid_payment_state',
      'charge',
      'Charge is not paid, captured, and succeeded',
      objectIds,
      { paid: charge.paid, captured: charge.captured, status: charge.status }
    )
  }
  return charge
}

async function resolveInvoicePaymentChain(
  client: StripeAuthorityClient,
  payment: Stripe.InvoicePayment,
  customerId: string,
  invoice: Stripe.Invoice,
  expectedCurrency: string | undefined,
  objectIds: StripeAuthorityObjectIds
): Promise<PaymentChain> {
  const invoicePaymentId = nonEmptyId(
    payment,
    'invoice_payments',
    'invoice payment',
    'inpay_',
    objectIds
  )
  objectIds.invoicePaymentId = invoicePaymentId
  const paymentInvoiceId = nonEmptyId(
    payment.invoice,
    'invoice_payments',
    'invoice_payment.invoice',
    'in_',
    objectIds
  )
  assertSame(paymentInvoiceId, invoice.id, 'invoice_payments', 'invoice_payment.invoice', objectIds)
  if (payment.status !== 'paid') {
    authorityError(
      'invalid_payment_state',
      'invoice_payments',
      'InvoicePayment is not paid',
      objectIds,
      { status: payment.status }
    )
  }

  if (payment.payment.type === 'payment_record') {
    authorityError(
      'unsupported_invoice_payment',
      'invoice_payments',
      'PaymentRecord-backed invoice payments require manual review',
      objectIds,
      { paymentType: payment.payment.type }
    )
  }

  if (payment.payment.type === 'payment_intent') {
    if (payment.payment.charge || payment.payment.payment_record) {
      authorityError(
        'object_mismatch',
        'invoice_payments',
        'InvoicePayment contains conflicting payment references',
        objectIds,
        { paymentType: payment.payment.type }
      )
    }
    const paymentIntentId = nonEmptyId(
      payment.payment.payment_intent,
      'payment_intent',
      'invoice_payment.payment_intent',
      'pi_',
      objectIds
    )
    objectIds.paymentIntentId = paymentIntentId
    const paymentIntent = await client.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge'],
    })
    assertSame(paymentIntent.id, paymentIntentId, 'payment_intent', 'payment_intent.id', objectIds)
    const piCustomerId = nonEmptyId(
      paymentIntent.customer,
      'payment_intent',
      'payment_intent.customer',
      'cus_',
      objectIds
    )
    assertSame(piCustomerId, customerId, 'payment_intent', 'payment_intent.customer', objectIds)
    if (paymentIntent.status !== 'succeeded') {
      authorityError(
        'invalid_payment_state',
        'payment_intent',
        'PaymentIntent has not succeeded',
        objectIds,
        { status: paymentIntent.status }
      )
    }

    const charge = await retrieveCharge(
      client,
      paymentIntent.latest_charge,
      customerId,
      paymentIntentId,
      objectIds
    )
    const amount = assertAmounts(
      [
        { source: 'invoice.amount_paid', value: invoice.amount_paid },
        { source: 'invoice_payment.amount_paid', value: payment.amount_paid },
        { source: 'payment_intent.amount', value: paymentIntent.amount },
        { source: 'payment_intent.amount_received', value: paymentIntent.amount_received },
        { source: 'charge.amount', value: charge.amount },
        { source: 'charge.amount_captured', value: charge.amount_captured },
      ],
      objectIds
    )
    const currency = assertCurrencies(
      [
        { source: 'invoice.currency', value: invoice.currency },
        { source: 'invoice_payment.currency', value: payment.currency },
        { source: 'payment_intent.currency', value: paymentIntent.currency },
        { source: 'charge.currency', value: charge.currency },
      ],
      expectedCurrency,
      objectIds
    )
    return {
      source: 'payment_intent',
      paymentIntentId,
      chargeId: charge.id,
      amount,
      currency,
      paidAt: payment.status_transitions.paid_at ?? charge.created,
      paymentIntentMetadata: paymentIntent.metadata,
      chargeMetadata: charge.metadata,
    }
  }

  if (payment.payment.payment_intent || payment.payment.payment_record) {
    authorityError(
      'object_mismatch',
      'invoice_payments',
      'Direct-charge InvoicePayment contains conflicting payment references',
      objectIds,
      { paymentType: payment.payment.type }
    )
  }
  const charge = await retrieveCharge(client, payment.payment.charge, customerId, null, objectIds)
  const amount = assertAmounts(
    [
      { source: 'invoice.amount_paid', value: invoice.amount_paid },
      { source: 'invoice_payment.amount_paid', value: payment.amount_paid },
      { source: 'charge.amount', value: charge.amount },
      { source: 'charge.amount_captured', value: charge.amount_captured },
    ],
    objectIds
  )
  const currency = assertCurrencies(
    [
      { source: 'invoice.currency', value: invoice.currency },
      { source: 'invoice_payment.currency', value: payment.currency },
      { source: 'charge.currency', value: charge.currency },
    ],
    expectedCurrency,
    objectIds
  )
  return {
    source: 'charge',
    paymentIntentId: null,
    chargeId: charge.id,
    amount,
    currency,
    paidAt: payment.status_transitions.paid_at ?? charge.created,
    chargeMetadata: charge.metadata,
  }
}

async function resolveInvoiceProductAndPeriod(
  client: StripeAuthorityClient,
  invoice: Stripe.Invoice,
  subscriptionId: string,
  products: StripeAuthorityProductConfig,
  objectIds: StripeAuthorityObjectIds
): Promise<{
  priceId: string
  plan: ProPlan
  periodStart: number
  periodEnd: number
  currency: string
}> {
  const lines = await listEveryPage(
    (startingAfter) =>
      client.invoices.listLineItems(invoice.id, {
        limit: PAGE_LIMIT,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      }),
    'invoice_lines',
    objectIds
  )
  const productLines = lines.filter((line) => {
    const details = line.parent?.subscription_item_details
    const lineSubscriptionId =
      typeof line.subscription === 'string' ? line.subscription : line.subscription?.id
    return (
      details &&
      !details.proration &&
      details.subscription === subscriptionId &&
      lineSubscriptionId === subscriptionId
    )
  })
  if (productLines.length !== 1) {
    authorityError(
      'ambiguous_product',
      'invoice_lines',
      'Invoice does not contain exactly one non-proration subscription product',
      objectIds,
      { productLineIds: productLines.map((line) => line.id) }
    )
  }
  const line = productLines[0]
  const lineInvoiceId = nonEmptyId(
    line.invoice,
    'invoice_lines',
    'invoice_line.invoice',
    'in_',
    objectIds
  )
  assertSame(lineInvoiceId, invoice.id, 'invoice_lines', 'invoice_line.invoice', objectIds)
  if (line.quantity !== 1) {
    authorityError(
      'ambiguous_product',
      'invoice_lines',
      'Invoice product quantity is not one',
      objectIds,
      { lineId: line.id, quantity: line.quantity }
    )
  }
  const priceValue = line.pricing?.price_details?.price
  const priceId = nonEmptyId(priceValue, 'invoice_lines', 'invoice_line.price', 'price_', objectIds)
  const product = resolveConfiguredProduct(priceId, products, ['monthly', 'yearly'], objectIds)
  if (product.plan === 'lifetime') {
    authorityError(
      'unsupported_product',
      'product',
      'Lifetime price cannot authorize a subscription invoice',
      objectIds,
      { priceId }
    )
  }
  const periodStart = line.period.start
  const periodEnd = line.period.end
  if (
    !Number.isSafeInteger(periodStart) ||
    !Number.isSafeInteger(periodEnd) ||
    periodStart <= 0 ||
    periodEnd <= periodStart
  ) {
    authorityError(
      'invalid_period',
      'invoice_lines',
      'Invoice product period is invalid',
      objectIds,
      { periodStart, periodEnd, lineId: line.id }
    )
  }
  return {
    priceId,
    plan: product.plan,
    periodStart,
    periodEnd,
    currency: line.currency,
  }
}

async function retrieveSubscription(
  client: StripeAuthorityClient,
  value: string | Stripe.Subscription,
  objectIds: StripeAuthorityObjectIds
): Promise<Stripe.Subscription> {
  const subscriptionId = nonEmptyId(value, 'subscription', 'subscription', 'sub_', objectIds)
  objectIds.subscriptionId = subscriptionId
  const subscription = await client.subscriptions.retrieve(subscriptionId)
  assertSame(subscription.id, subscriptionId, 'subscription', 'subscription.id', objectIds)
  return subscription
}

async function retrieveInvoice(
  client: StripeAuthorityClient,
  value: string | Stripe.Invoice,
  objectIds: StripeAuthorityObjectIds
): Promise<Stripe.Invoice> {
  const invoiceId = nonEmptyId(value, 'invoice', 'invoice', 'in_', objectIds)
  objectIds.invoiceId = invoiceId
  const invoice = await client.invoices.retrieve(invoiceId)
  assertSame(invoice.id, invoiceId, 'invoice', 'invoice.id', objectIds)
  return invoice
}

async function retrieveSession(
  client: StripeAuthorityClient,
  value: string | Stripe.Checkout.Session,
  objectIds: StripeAuthorityObjectIds
): Promise<Stripe.Checkout.Session> {
  const sessionId = nonEmptyId(value, 'checkout_session', 'checkout session', 'cs_', objectIds)
  objectIds.sessionId = sessionId
  const session = await client.checkout.sessions.retrieve(sessionId)
  assertSame(session.id, sessionId, 'checkout_session', 'checkout_session.id', objectIds)
  return session
}

/**
 * Resolve one exact paid recurring invoice. This function never consults
 * `subscription.latest_invoice`; an old invoice remains an old payment period.
 */
export async function resolveRecurringInvoiceAuthority(
  client: StripeAuthorityClient,
  invoiceValue: string | Stripe.Invoice,
  options: StripeAuthorityOptions
): Promise<RecurringPaymentAuthority> {
  const objectIds: StripeAuthorityObjectIds = {}
  const invoice = await retrieveInvoice(client, invoiceValue, objectIds)
  if (invoice.status !== 'paid' || invoice.amount_remaining !== 0) {
    authorityError('invalid_payment_state', 'invoice', 'Invoice is not fully paid', objectIds, {
      status: invoice.status,
      amountRemaining: invoice.amount_remaining,
    })
  }
  const subscriptionDetails = invoice.parent?.subscription_details
  if (invoice.parent?.type !== 'subscription_details' || !subscriptionDetails) {
    authorityError(
      'invalid_object',
      'invoice',
      'Invoice is not bound to a subscription snapshot',
      objectIds
    )
  }
  const subscriptionId = nonEmptyId(
    subscriptionDetails.subscription,
    'invoice',
    'invoice.parent.subscription',
    'sub_',
    objectIds
  )
  objectIds.subscriptionId = subscriptionId
  const customerId = nonEmptyId(invoice.customer, 'invoice', 'invoice.customer', 'cus_', objectIds)
  objectIds.customerId = customerId

  const [subscription, customer, payments, invoiceProduct] = await Promise.all([
    retrieveSubscription(client, subscriptionId, objectIds),
    retrieveCustomer(client, customerId, objectIds),
    listEveryPage(
      (startingAfter) =>
        client.invoicePayments.list({
          invoice: invoice.id,
          status: 'paid',
          limit: PAGE_LIMIT,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        }),
      'invoice_payments',
      objectIds
    ),
    resolveInvoiceProductAndPeriod(client, invoice, subscriptionId, options.products, objectIds),
  ])

  const subscriptionCustomerId = nonEmptyId(
    subscription.customer,
    'subscription',
    'subscription.customer',
    'cus_',
    objectIds
  )
  assertSame(subscriptionCustomerId, customerId, 'subscription', 'subscription.customer', objectIds)
  if (
    payments.some(
      (payment) => payment.status === 'paid' && payment.payment.type === 'payment_record'
    )
  ) {
    authorityError(
      'unsupported_invoice_payment',
      'invoice_payments',
      'PaymentRecord-backed invoice payments require manual review',
      objectIds,
      {
        paymentIds: payments
          .filter((payment) => payment.payment.type === 'payment_record')
          .map((payment) => payment.id),
      }
    )
  }
  const paidPayments = payments.filter((payment) => payment.status === 'paid')
  if (paidPayments.length !== 1) {
    authorityError(
      'ambiguous_invoice_payment',
      'invoice_payments',
      'Invoice must have exactly one paid attributable payment',
      objectIds,
      { paymentIds: paidPayments.map((payment) => payment.id) }
    )
  }

  const chain = await resolveInvoicePaymentChain(
    client,
    paidPayments[0],
    customerId,
    invoice,
    options.products.expectedCurrency,
    objectIds
  )
  const currency = assertCurrencies(
    [
      { source: 'payment_chain.currency', value: chain.currency },
      { source: 'invoice_line.currency', value: invoiceProduct.currency },
      { source: 'subscription.currency', value: subscription.currency },
    ],
    options.products.expectedCurrency,
    objectIds
  )
  const userId = resolveIdentity(
    [
      {
        source: 'invoice.parent.subscription_details.metadata',
        metadata: subscriptionDetails.metadata,
        required: true,
      },
      { source: 'subscription.metadata', metadata: subscription.metadata, required: true },
      { source: 'customer.metadata', metadata: customer.metadata, required: true },
      { source: 'invoice.metadata', metadata: invoice.metadata, required: false },
      {
        source: 'payment_intent.metadata',
        metadata: chain.paymentIntentMetadata,
        required: false,
      },
      { source: 'charge.metadata', metadata: chain.chargeMetadata, required: false },
    ],
    options.expectedUserId,
    objectIds
  )

  return {
    kind: 'recurring_payment',
    userId,
    customerId,
    subscriptionId,
    invoiceId: invoice.id,
    invoicePaymentId: paidPayments[0].id,
    paymentIntentId: chain.paymentIntentId,
    chargeId: chain.chargeId,
    paymentSource: chain.source,
    priceId: invoiceProduct.priceId,
    plan: invoiceProduct.plan,
    amount: chain.amount,
    currency,
    periodStart: invoiceProduct.periodStart,
    periodEnd: invoiceProduct.periodEnd,
    invoiceCreatedAt: invoice.created,
    paidAt: chain.paidAt,
    subscriptionStatus: subscription.status,
    refundReference: {
      invoicePaymentId: paidPayments[0].id,
      invoiceId: invoice.id,
      paymentIntentId: chain.paymentIntentId,
      chargeId: chain.chargeId,
      originalAmount: chain.amount,
    },
  }
}

async function resolveTrialFromSubscription(
  client: StripeAuthorityClient,
  subscription: Stripe.Subscription,
  options: StripeAuthorityOptions,
  extraIdentitySources: IdentitySource[] = [],
  objectIds: StripeAuthorityObjectIds = { subscriptionId: subscription.id }
): Promise<TrialAuthority> {
  if (subscription.status !== 'trialing') {
    authorityError('invalid_trial', 'trial', 'Subscription is not currently trialing', objectIds, {
      status: subscription.status,
    })
  }
  const customerId = nonEmptyId(
    subscription.customer,
    'subscription',
    'subscription.customer',
    'cus_',
    objectIds
  )
  objectIds.customerId = customerId
  const customer = await retrieveCustomer(client, customerId, objectIds)
  if (subscription.items.data.length !== 1) {
    authorityError(
      'ambiguous_product',
      'trial',
      'Trial must contain exactly one subscription item',
      objectIds,
      { itemIds: subscription.items.data.map((item) => item.id) }
    )
  }
  const item = subscription.items.data[0]
  if (item.quantity !== 1) {
    authorityError('ambiguous_product', 'trial', 'Trial product quantity is not one', objectIds, {
      itemId: item.id,
      quantity: item.quantity ?? null,
    })
  }
  const priceId = nonEmptyId(item.price, 'trial', 'trial price', 'price_', objectIds)
  const product = resolveConfiguredProduct(
    priceId,
    options.products,
    ['monthly', 'yearly'],
    objectIds
  )
  if (product.plan === 'lifetime') {
    authorityError(
      'unsupported_product',
      'trial',
      'Lifetime products cannot create trials',
      objectIds,
      { priceId }
    )
  }
  const trialStart = subscription.trial_start
  const trialEnd = subscription.trial_end
  const periodStart = item.current_period_start
  const periodEnd = item.current_period_end
  if (
    !trialStart ||
    !trialEnd ||
    trialEnd <= trialStart ||
    periodStart !== trialStart ||
    periodEnd !== trialEnd
  ) {
    authorityError(
      'invalid_period',
      'trial',
      'Trial and subscription item periods do not match',
      objectIds,
      { trialStart, trialEnd, periodStart, periodEnd }
    )
  }
  const currency = assertCurrencies(
    [
      { source: 'subscription.currency', value: subscription.currency },
      { source: 'price.currency', value: item.price.currency },
    ],
    options.products.expectedCurrency,
    objectIds
  )
  const userId = resolveIdentity(
    [
      { source: 'subscription.metadata', metadata: subscription.metadata, required: true },
      { source: 'customer.metadata', metadata: customer.metadata, required: true },
      ...extraIdentitySources,
    ],
    options.expectedUserId,
    objectIds
  )
  return {
    kind: 'trial',
    userId,
    customerId,
    subscriptionId: subscription.id,
    priceId,
    plan: product.plan,
    currency,
    periodStart,
    periodEnd,
    trialStart,
    trialEnd,
    subscriptionStatus: 'trialing',
  }
}

/**
 * Resolve the subscription's current authority. This is the only entry point
 * that intentionally follows `latest_invoice`.
 */
export async function resolveSubscriptionAuthority(
  client: StripeAuthorityClient,
  subscriptionValue: string | Stripe.Subscription,
  options: StripeAuthorityOptions
): Promise<RecurringPaymentAuthority | TrialAuthority> {
  const objectIds: StripeAuthorityObjectIds = {}
  const subscription = await retrieveSubscription(client, subscriptionValue, objectIds)
  if (subscription.status === 'trialing') {
    return resolveTrialFromSubscription(client, subscription, options, [], objectIds)
  }
  const invoiceId = nonEmptyId(
    subscription.latest_invoice,
    'subscription',
    'subscription.latest_invoice',
    'in_',
    objectIds
  )
  return resolveRecurringInvoiceAuthority(client, invoiceId, options)
}

/**
 * Resolve identity and product state from a Stripe-signature-verified
 * subscription event snapshot without turning that state into payment
 * authority.
 *
 * Unlike `resolveSubscriptionAuthority`, this function intentionally does not
 * retrieve the current Subscription or follow `latest_invoice`: replacing an
 * older webhook snapshot with today's Stripe state would attach the older
 * event id/timestamp to a newer state transition. The customer is still
 * retrieved so both required identity sources must agree.
 */
export async function resolveSubscriptionEventStateAuthority(
  client: StripeAuthorityClient,
  subscription: Stripe.Subscription,
  options: StripeAuthorityOptions
): Promise<SubscriptionEventStateAuthority> {
  const objectIds: StripeAuthorityObjectIds = {}
  const subscriptionId = nonEmptyId(subscription, 'subscription', 'subscription', 'sub_', objectIds)
  objectIds.subscriptionId = subscriptionId
  const customerId = nonEmptyId(
    subscription.customer,
    'subscription',
    'subscription.customer',
    'cus_',
    objectIds
  )
  objectIds.customerId = customerId

  const supportedStatuses: readonly Stripe.Subscription.Status[] = [
    'active',
    'trialing',
    'past_due',
    'canceled',
    'unpaid',
    'incomplete',
    'incomplete_expired',
    'paused',
  ]
  if (!supportedStatuses.includes(subscription.status)) {
    authorityError(
      'invalid_payment_state',
      'subscription',
      'Subscription event status is unsupported',
      objectIds,
      { status: subscription.status ?? null }
    )
  }
  if (typeof subscription.cancel_at_period_end !== 'boolean') {
    authorityError(
      'invalid_object',
      'subscription',
      'Subscription cancellation state is malformed',
      objectIds,
      { cancelAtPeriodEnd: subscription.cancel_at_period_end ?? null }
    )
  }
  if (subscription.items.data.length !== 1) {
    authorityError(
      'ambiguous_product',
      'subscription',
      'Subscription event must contain exactly one item',
      objectIds,
      { itemIds: subscription.items.data.map((item) => item.id) }
    )
  }

  const item = subscription.items.data[0]
  if (item.quantity !== 1) {
    authorityError(
      'ambiguous_product',
      'subscription',
      'Subscription event product quantity is not one',
      objectIds,
      { itemId: item.id, quantity: item.quantity ?? null }
    )
  }
  const priceId = nonEmptyId(
    item.price,
    'subscription',
    'subscription event price',
    'price_',
    objectIds
  )
  const product = resolveConfiguredProduct(
    priceId,
    options.products,
    ['monthly', 'yearly'],
    objectIds
  )
  if (product.plan === 'lifetime') {
    authorityError(
      'unsupported_product',
      'subscription',
      'Lifetime products cannot create recurring subscription state',
      objectIds,
      { priceId }
    )
  }

  const periodStart = item.current_period_start
  const periodEnd = item.current_period_end
  if (
    !Number.isSafeInteger(periodStart) ||
    periodStart <= 0 ||
    !Number.isSafeInteger(periodEnd) ||
    periodEnd <= periodStart
  ) {
    authorityError(
      'invalid_period',
      'subscription',
      'Subscription event period is invalid',
      objectIds,
      { periodStart: periodStart ?? null, periodEnd: periodEnd ?? null }
    )
  }

  const currentInvoiceId =
    subscription.latest_invoice === null
      ? null
      : nonEmptyId(
          subscription.latest_invoice,
          'subscription',
          'subscription.latest_invoice',
          'in_',
          objectIds
        )
  if (currentInvoiceId) objectIds.invoiceId = currentInvoiceId
  if (subscription.status === 'past_due' && !currentInvoiceId) {
    authorityError(
      'invalid_object',
      'subscription',
      'Past-due subscription event has no current invoice',
      objectIds
    )
  }

  const canceledAt = subscription.canceled_at
  if (canceledAt !== null && (!Number.isSafeInteger(canceledAt) || (canceledAt as number) <= 0)) {
    authorityError(
      'invalid_object',
      'subscription',
      'Subscription cancellation timestamp is malformed',
      objectIds,
      { canceledAt: canceledAt ?? null }
    )
  }

  const customer = await retrieveCustomer(client, customerId, objectIds)
  const currency = assertCurrencies(
    [
      { source: 'subscription.currency', value: subscription.currency },
      { source: 'price.currency', value: item.price.currency },
    ],
    options.products.expectedCurrency,
    objectIds
  )
  const userId = resolveIdentity(
    [
      { source: 'subscription.metadata', metadata: subscription.metadata, required: true },
      { source: 'customer.metadata', metadata: customer.metadata, required: true },
    ],
    options.expectedUserId,
    objectIds
  )

  return {
    kind: 'subscription_state',
    userId,
    customerId,
    subscriptionId,
    currentInvoiceId,
    priceId,
    plan: product.plan,
    currency,
    periodStart,
    periodEnd,
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt,
  }
}

async function resolveCheckoutProduct(
  client: StripeAuthorityClient,
  session: Stripe.Checkout.Session,
  options: StripeAuthorityOptions,
  allowedPlans: ReadonlyArray<ProPlan | 'lifetime'>,
  objectIds: StripeAuthorityObjectIds
): Promise<ProductResolution & { amount: number; currency: string }> {
  const lines = await listEveryPage(
    (startingAfter) =>
      client.checkout.sessions.listLineItems(session.id, {
        limit: PAGE_LIMIT,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      }),
    'product',
    objectIds
  )
  if (lines.length !== 1 || lines[0].quantity !== 1) {
    authorityError(
      'ambiguous_product',
      'product',
      'Checkout Session must contain exactly one product with quantity one',
      objectIds,
      {
        lines: lines.map((line) => ({ id: line.id, quantity: line.quantity })),
      }
    )
  }
  const line = lines[0]
  const priceId = nonEmptyId(line.price, 'product', 'checkout line price', 'price_', objectIds)
  const product = resolveConfiguredProduct(priceId, options.products, allowedPlans, objectIds)
  return {
    ...product,
    amount: line.amount_total,
    currency: line.currency,
  }
}

async function resolveLifetimeAuthority(
  client: StripeAuthorityClient,
  session: Stripe.Checkout.Session,
  options: StripeAuthorityOptions,
  objectIds: StripeAuthorityObjectIds
): Promise<LifetimePaymentAuthority> {
  if (
    session.mode !== 'payment' ||
    session.payment_status !== 'paid' ||
    session.status !== 'complete'
  ) {
    authorityError(
      'invalid_session_state',
      'checkout_session',
      'Lifetime Checkout Session is not complete and paid',
      objectIds,
      { mode: session.mode, paymentStatus: session.payment_status, status: session.status }
    )
  }
  if (session.subscription !== null) {
    authorityError(
      'object_mismatch',
      'checkout_session',
      'Lifetime Checkout Session unexpectedly references a subscription',
      objectIds
    )
  }
  const customerId = nonEmptyId(
    session.customer,
    'checkout_session',
    'checkout_session.customer',
    'cus_',
    objectIds
  )
  objectIds.customerId = customerId
  const paymentIntentId = nonEmptyId(
    session.payment_intent,
    'checkout_session',
    'checkout_session.payment_intent',
    'pi_',
    objectIds
  )
  objectIds.paymentIntentId = paymentIntentId
  const [customer, paymentIntent, checkoutProduct] = await Promise.all([
    retrieveCustomer(client, customerId, objectIds),
    client.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] }),
    resolveCheckoutProduct(client, session, options, ['lifetime'], objectIds),
  ])
  assertSame(paymentIntent.id, paymentIntentId, 'payment_intent', 'payment_intent.id', objectIds)
  const piCustomerId = nonEmptyId(
    paymentIntent.customer,
    'payment_intent',
    'payment_intent.customer',
    'cus_',
    objectIds
  )
  assertSame(piCustomerId, customerId, 'payment_intent', 'payment_intent.customer', objectIds)
  if (paymentIntent.status !== 'succeeded') {
    authorityError(
      'invalid_payment_state',
      'payment_intent',
      'Lifetime PaymentIntent has not succeeded',
      objectIds,
      { status: paymentIntent.status }
    )
  }
  const charge = await retrieveCharge(
    client,
    paymentIntent.latest_charge,
    customerId,
    paymentIntentId,
    objectIds
  )
  const amount = assertAmounts(
    [
      { source: 'checkout_session.amount_total', value: session.amount_total },
      { source: 'checkout_line.amount_total', value: checkoutProduct.amount },
      { source: 'payment_intent.amount', value: paymentIntent.amount },
      { source: 'payment_intent.amount_received', value: paymentIntent.amount_received },
      { source: 'charge.amount', value: charge.amount },
      { source: 'charge.amount_captured', value: charge.amount_captured },
    ],
    objectIds
  )
  const currency = assertCurrencies(
    [
      { source: 'checkout_session.currency', value: session.currency },
      { source: 'checkout_line.currency', value: checkoutProduct.currency },
      { source: 'payment_intent.currency', value: paymentIntent.currency },
      { source: 'charge.currency', value: charge.currency },
    ],
    options.products.expectedCurrency,
    objectIds
  )
  const userId = resolveIdentity(
    [
      { source: 'checkout_session.metadata', metadata: session.metadata, required: true },
      { source: 'customer.metadata', metadata: customer.metadata, required: true },
      { source: 'payment_intent.metadata', metadata: paymentIntent.metadata, required: false },
      { source: 'charge.metadata', metadata: charge.metadata, required: false },
    ],
    options.expectedUserId,
    objectIds
  )
  const declaredPlan = session.metadata?.plan?.trim()
  if (declaredPlan !== 'lifetime') {
    authorityError(
      'unsupported_product',
      'product',
      'Checkout Session metadata does not declare the lifetime plan',
      objectIds,
      { declaredPlan: declaredPlan || null, priceId: checkoutProduct.priceId }
    )
  }
  return {
    kind: 'lifetime_payment',
    userId,
    customerId,
    sessionId: session.id,
    paymentIntentId,
    chargeId: charge.id,
    priceId: checkoutProduct.priceId,
    plan: 'lifetime',
    amount,
    currency,
    paidAt: charge.created,
    refundReference: {
      invoicePaymentId: null,
      invoiceId: null,
      paymentIntentId,
      chargeId: charge.id,
      originalAmount: amount,
    },
  }
}

/**
 * Resolve only the original objects attached to a Checkout Session. In
 * subscription mode this function never follows `subscription.latest_invoice`,
 * so replaying a delayed Session cannot silently authorize a later period.
 */
export async function resolveCheckoutSessionAuthority(
  client: StripeAuthorityClient,
  sessionValue: string | Stripe.Checkout.Session,
  options: StripeAuthorityOptions
): Promise<CheckoutEntitlementAuthority> {
  const objectIds: StripeAuthorityObjectIds = {}
  const session = await retrieveSession(client, sessionValue, objectIds)
  if (session.mode === 'payment') {
    return resolveLifetimeAuthority(client, session, options, objectIds)
  }
  if (session.mode !== 'subscription' || session.status !== 'complete') {
    authorityError(
      'invalid_session_state',
      'checkout_session',
      'Checkout Session is not a completed subscription purchase',
      objectIds,
      { mode: session.mode, status: session.status, paymentStatus: session.payment_status }
    )
  }

  const subscriptionId = nonEmptyId(
    session.subscription,
    'checkout_session',
    'checkout_session.subscription',
    'sub_',
    objectIds
  )
  objectIds.subscriptionId = subscriptionId
  const customerId = nonEmptyId(
    session.customer,
    'checkout_session',
    'checkout_session.customer',
    'cus_',
    objectIds
  )
  objectIds.customerId = customerId

  if (session.payment_status === 'no_payment_required') {
    const subscription = await retrieveSubscription(client, subscriptionId, objectIds)
    const subscriptionCustomerId = nonEmptyId(
      subscription.customer,
      'subscription',
      'subscription.customer',
      'cus_',
      objectIds
    )
    assertSame(
      subscriptionCustomerId,
      customerId,
      'checkout_session',
      'checkout_session.customer',
      objectIds
    )
    const trial = await resolveTrialFromSubscription(
      client,
      subscription,
      options,
      [{ source: 'checkout_session.metadata', metadata: session.metadata, required: true }],
      objectIds
    )
    const checkoutToTrialStart = trial.periodStart - session.created
    if (checkoutToTrialStart < 0 || checkoutToTrialStart > MAX_CHECKOUT_TO_TRIAL_START_SECONDS) {
      authorityError(
        'invalid_session_state',
        'checkout_session',
        'Checkout Session is not the Session that created the current trial',
        objectIds,
        {
          sessionCreated: session.created,
          trialStart: trial.periodStart,
          checkoutToTrialStart,
          maximumSeconds: MAX_CHECKOUT_TO_TRIAL_START_SECONDS,
        }
      )
    }
    const checkoutProduct = await resolveCheckoutProduct(
      client,
      session,
      options,
      ['monthly', 'yearly'],
      objectIds
    )
    assertSame(checkoutProduct.priceId, trial.priceId, 'product', 'checkout price', objectIds)
    const declaredPlan = session.metadata?.plan?.trim()
    if (declaredPlan && declaredPlan !== trial.plan) {
      authorityError(
        'unsupported_product',
        'product',
        'Checkout Session plan metadata conflicts with its trial price',
        objectIds,
        { declaredPlan, authoritativePlan: trial.plan }
      )
    }
    return trial
  }

  if (session.payment_status !== 'paid') {
    authorityError(
      'invalid_session_state',
      'checkout_session',
      'Subscription Checkout Session has not been paid',
      objectIds,
      { paymentStatus: session.payment_status }
    )
  }
  const invoiceId = nonEmptyId(
    session.invoice,
    'checkout_session',
    'checkout_session.invoice',
    'in_',
    objectIds
  )
  objectIds.invoiceId = invoiceId
  const authority = await resolveRecurringInvoiceAuthority(client, invoiceId, options)
  const authorityObjectIds: StripeAuthorityObjectIds = {
    ...objectIds,
    invoicePaymentId: authority.invoicePaymentId,
    paymentIntentId: authority.paymentIntentId ?? undefined,
    chargeId: authority.chargeId,
  }
  assertSame(
    authority.subscriptionId,
    subscriptionId,
    'checkout_session',
    'subscription',
    authorityObjectIds
  )
  assertSame(authority.customerId, customerId, 'checkout_session', 'customer', authorityObjectIds)
  const sessionUserId = resolveIdentity(
    [{ source: 'checkout_session.metadata', metadata: session.metadata, required: true }],
    options.expectedUserId ?? authority.userId,
    objectIds
  )
  assertSame(sessionUserId, authority.userId, 'identity', 'checkout user', objectIds)
  const checkoutProduct = await resolveCheckoutProduct(
    client,
    session,
    options,
    ['monthly', 'yearly'],
    objectIds
  )
  assertSame(checkoutProduct.priceId, authority.priceId, 'product', 'checkout price', objectIds)
  assertAmounts(
    [
      { source: 'checkout_session.amount_total', value: session.amount_total },
      { source: 'checkout_line.amount_total', value: checkoutProduct.amount },
      { source: 'invoice_payment.amount', value: authority.amount },
    ],
    objectIds
  )
  assertCurrencies(
    [
      { source: 'checkout_session.currency', value: session.currency },
      { source: 'checkout_line.currency', value: checkoutProduct.currency },
      { source: 'invoice_payment.currency', value: authority.currency },
    ],
    options.products.expectedCurrency,
    objectIds
  )
  const declaredPlan = session.metadata?.plan?.trim()
  if (declaredPlan && declaredPlan !== authority.plan) {
    authorityError(
      'unsupported_product',
      'product',
      'Checkout Session plan metadata conflicts with its exact invoice price',
      objectIds,
      { declaredPlan, authoritativePlan: authority.plan }
    )
  }
  return authority
}
