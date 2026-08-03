import 'server-only'

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/database.types'
import {
  resolveCheckoutSessionAuthority,
  resolveExactRecurringInvoicePriceId,
  resolveRecurringInvoiceAuthority,
  resolveRecurringInvoiceFinancialObservationAuthority,
  resolveRecurringInvoiceFailureAuthority,
  resolveSubscriptionEventStateAuthority,
  resolveTrialZeroInvoiceAuthority,
  StripeAuthorityError,
  type StripeAuthorityClient,
  type RecurringInvoiceFailureAuthority,
  type RecurringFinancialObservationAuthority,
  type RecurringPaymentAuthority,
  type SubscriptionEventStateAuthority,
  type TrialZeroInvoiceAuthority,
  type TrialAuthority,
} from '@/lib/stripe/entitlement-authority'
import { stripeEntitlementAuthorityOptions } from '@/lib/stripe/entitlement-runtime'

export type SignedStripeEventContext = {
  id: string
  created: number
  livemode: boolean
}

export type RecurringAuthorityOutcome = {
  status: string
  authority?:
    | RecurringPaymentAuthority
    | RecurringFinancialObservationAuthority
    | RecurringInvoiceFailureAuthority
    | TrialZeroInvoiceAuthority
    | TrialAuthority
  reviewCode?: StripeAuthorityError['code']
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STRIPE_EVENT_PATTERN = /^evt_[A-Za-z0-9_]+$/
const MAX_STRIPE_UNIX_SECONDS = 253_402_300_799

function isExactStripeId(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 255) return false
  const suffix = value.slice(prefix.length)
  return value.startsWith(prefix) && suffix.length > 0 && /^[A-Za-z0-9_]+$/.test(suffix)
}

const PAYMENT_ACTIVATION_STATUSES = new Set([
  'activated',
  'already_activated',
  'current_entitlement_protected',
  'identity_conflict',
  'inactive_subject',
  'manual_review',
  'parallel_subscription_review',
  'refunded_payment',
  'stale_payment',
  'stripe_status_not_entitling',
  'subject_deleted',
  'owner_conflict',
])

const TRIAL_ACTIVATION_STATUSES = new Set([
  'activated',
  'already_activated',
  'current_entitlement_protected',
  'identity_conflict',
  'manual_review',
  'stale_trial',
  'owner_conflict',
  'terminal_trial_recorded',
])

const SUBSCRIPTION_RECONCILIATION_STATUSES = new Set([
  'already_reconciled',
  'current_entitlement_protected',
  'identity_conflict',
  'manual_review',
  'not_current',
  'owner_conflict',
  'pending_authority',
  'reconciled',
  'grace_applied',
  'grace_expired',
  'grant_protected',
  'inactive_subject',
  'revoked',
  'stale_event',
  'terminal_without_projection',
])

const INVOICE_EVENT_STATUSES = new Set([
  ...PAYMENT_ACTIVATION_STATUSES,
  'already_recorded',
  'failed_recorded',
  'owner_conflict',
  'trial_zero_recorded',
])

type ExactHistoricalPriceAuthority = {
  financialOnly: false
  legacyUnboundPrice: boolean
  userId: string
  customerId: string
  priceId: string
  plan: 'monthly' | 'yearly'
  expectedAmount: number
  currency: string
}

type DeletedFinancialOwnerAuthority = {
  financialOnly: true
  userId: string
  customerId: string
}

type HistoricalPriceAuthority = ExactHistoricalPriceAuthority | DeletedFinancialOwnerAuthority

function signedSubscriptionPriceId(subscription: Stripe.Subscription): string | null {
  const items = subscription.items
  if (items.object !== 'list' || items.has_more !== false || items.data.length !== 1) {
    return null
  }
  const item = items.data[0]
  const itemSubscriptionId =
    typeof item.subscription === 'string'
      ? item.subscription
      : (item.subscription as unknown as { id?: string } | null)?.id
  return item.object === 'subscription_item' &&
    isExactStripeId(item.id, 'si_') &&
    itemSubscriptionId === subscription.id &&
    item.quantity === 1 &&
    isExactStripeId(item.price.id, 'price_')
    ? item.price.id
    : null
}

function rpcStatus(value: Json, operation: string): string {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    typeof value.status !== 'string'
  ) {
    throw new Error(`${operation} returned an invalid result`)
  }
  return value.status
}

async function resolveHistoricalPriceAuthority(params: {
  supabase: SupabaseClient<Database>
  subscriptionId: string
  signedPriceId: string | null
  livemode: boolean
  signedSubscription?: Stripe.Subscription
  stripe?: StripeAuthorityClient
}): Promise<HistoricalPriceAuthority | null> {
  if (!isExactStripeId(params.subscriptionId, 'sub_')) {
    throw new StripeAuthorityError({
      code: 'invalid_object',
      stage: 'subscription',
      message: 'Historical recurring Subscription id is malformed.',
      objectIds: { subscriptionId: params.subscriptionId },
      details: {},
    })
  }
  if (params.signedPriceId === null) return null
  if (!isExactStripeId(params.signedPriceId, 'price_')) {
    throw new StripeAuthorityError({
      code: 'invalid_object',
      stage: 'product',
      message: 'Signed recurring Price id is malformed.',
      objectIds: { subscriptionId: params.subscriptionId },
      details: { priceId: params.signedPriceId },
    })
  }
  const { data, error } = await params.supabase.rpc('resolve_b2c_recurring_price_authority', {
    p_stripe_subscription_id: params.subscriptionId,
    p_stripe_price_id: params.signedPriceId,
    p_livemode: params.livemode,
  })
  if (error) throw new Error(`Historical recurring price authority failed: ${error.message}`)
  if (!data || Array.isArray(data) || typeof data !== 'object' || typeof data.status !== 'string') {
    throw new Error('Historical recurring price authority returned an invalid result')
  }
  if (data.status === 'not_found') return null
  if (data.status === 'manual_review') {
    throw new StripeAuthorityError({
      code: 'identity_conflict',
      stage: 'product',
      message: 'Durable historical recurring price authorities conflict.',
      objectIds: { subscriptionId: params.subscriptionId },
      details: { livemode: params.livemode },
    })
  }
  const userId = typeof data.user_id === 'string' ? data.user_id : ''
  const customerId = typeof data.stripe_customer_id === 'string' ? data.stripe_customer_id : ''
  const priceId = typeof data.stripe_price_id === 'string' ? data.stripe_price_id : ''
  const plan = data.plan
  const expectedAmount = data.expected_amount
  const currency = typeof data.currency === 'string' ? data.currency : ''
  if (data.status === 'resolved_deleted_financial_owner') {
    if (
      !UUID_PATTERN.test(userId) ||
      !isExactStripeId(customerId, 'cus_') ||
      data.source_kind !== 'legacy_exact_central_payment_owner'
    ) {
      throw new Error('Historical deleted financial owner returned malformed identity')
    }
    return { financialOnly: true, userId, customerId }
  }
  if (data.status === 'resolved_legacy_trial_owner') {
    const subscription = params.signedSubscription
    const item =
      subscription?.items.object === 'list' &&
      subscription.items.has_more === false &&
      subscription.items.data.length === 1
        ? subscription.items.data[0]
        : null
    const freshPrice = !item && params.stripe ? await params.stripe.prices.retrieve(priceId) : null
    const productPrice = item?.price ?? freshPrice
    const amount = productPrice?.unit_amount
    const itemCurrency = productPrice?.currency
    const expectedInterval = plan === 'monthly' ? 'month' : 'year'
    if (
      (subscription !== undefined && subscription.id !== params.subscriptionId) ||
      !UUID_PATTERN.test(userId) ||
      !isExactStripeId(customerId, 'cus_') ||
      !isExactStripeId(priceId, 'price_') ||
      priceId !== params.signedPriceId ||
      (plan !== 'monthly' && plan !== 'yearly') ||
      data.source_kind !== 'legacy_exact_current_trial_owner' ||
      !productPrice ||
      productPrice.id !== priceId ||
      productPrice.object !== 'price' ||
      productPrice.livemode !== params.livemode ||
      productPrice.type !== 'recurring' ||
      productPrice.billing_scheme !== 'per_unit' ||
      productPrice.recurring?.interval !== expectedInterval ||
      productPrice.recurring.interval_count !== 1 ||
      productPrice.recurring.usage_type !== 'licensed' ||
      !Number.isSafeInteger(amount) ||
      (amount as number) <= 0 ||
      typeof itemCurrency !== 'string' ||
      !/^[a-z]{3}$/.test(itemCurrency)
    ) {
      throw new StripeAuthorityError({
        code: 'identity_conflict',
        stage: 'product',
        message: 'Historical recurring trial owner or fresh Price shape is malformed.',
        objectIds: { subscriptionId: params.subscriptionId },
        details: { priceId: params.signedPriceId, livemode: params.livemode },
      })
    }
    return {
      financialOnly: false,
      legacyUnboundPrice: true,
      userId,
      customerId,
      priceId,
      plan,
      expectedAmount: amount as number,
      currency: itemCurrency,
    }
  }
  if (
    data.status !== 'resolved' ||
    !UUID_PATTERN.test(userId) ||
    !isExactStripeId(customerId, 'cus_') ||
    !isExactStripeId(priceId, 'price_') ||
    priceId !== params.signedPriceId ||
    (plan !== 'monthly' && plan !== 'yearly') ||
    !Number.isSafeInteger(expectedAmount) ||
    (expectedAmount as number) <= 0 ||
    !/^[a-z]{3}$/.test(currency)
  ) {
    throw new Error('Historical recurring price authority returned malformed identity')
  }
  return {
    financialOnly: false,
    legacyUnboundPrice: data.source_kind === 'legacy_exact_current_payment_owner',
    userId,
    customerId,
    priceId,
    plan,
    expectedAmount: expectedAmount as number,
    currency,
  }
}

function isoFromStripeSeconds(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_STRIPE_UNIX_SECONDS) {
    throw new Error(`${label} is not a valid Stripe timestamp`)
  }
  return new Date(value * 1000).toISOString()
}

function assertSignedSnapshot(params: {
  event: SignedStripeEventContext
  object: { id: string; created: number; livemode: boolean }
  objectPrefix: 'in_' | 'sub_' | 'cs_'
  stage: 'invoice' | 'subscription' | 'checkout_session'
}): void {
  const { event, object, objectPrefix, stage } = params
  if (
    typeof event.id !== 'string' ||
    event.id !== event.id.trim() ||
    !STRIPE_EVENT_PATTERN.test(event.id) ||
    event.id.length > 255 ||
    !Number.isSafeInteger(event.created) ||
    event.created <= 0 ||
    event.created > MAX_STRIPE_UNIX_SECONDS ||
    !isExactStripeId(object.id, objectPrefix) ||
    !Number.isSafeInteger(object.created) ||
    object.created <= 0 ||
    object.created > event.created ||
    typeof object.livemode !== 'boolean' ||
    object.livemode !== event.livemode
  ) {
    throw new StripeAuthorityError({
      code: 'invalid_object',
      stage,
      message: `Signed Stripe ${stage} snapshot identity is malformed or cross-mode.`,
      objectIds:
        stage === 'invoice'
          ? { invoiceId: object.id }
          : stage === 'subscription'
            ? { subscriptionId: object.id }
            : { sessionId: object.id },
      details: {
        event_id: event.id,
        event_created: event.created,
        event_livemode: event.livemode,
        object_created: object.created,
        object_livemode: object.livemode,
      },
    })
  }
}

function reviewContext(error: StripeAuthorityError, event: SignedStripeEventContext): Json {
  return JSON.parse(
    JSON.stringify({
      ...error.toReviewPayload(),
      signed_event: event,
    })
  ) as Json
}

function authorityOptionsForHistorical(
  historical: HistoricalPriceAuthority | null,
  livemode: boolean
) {
  const options = stripeEntitlementAuthorityOptions(
    historical?.userId,
    livemode,
    historical && !historical.financialOnly
      ? {
          priceId: historical.priceId,
          plan: historical.plan,
          expectedAmount: historical.expectedAmount,
          currency: historical.currency,
        }
      : undefined
  )
  return historical?.financialOnly
    ? {
        ...options,
        expectedCustomerId: historical.customerId,
      }
    : {
        ...options,
        ...(historical ? { expectedCustomerId: historical.customerId } : {}),
      }
}

export async function recordRecurringAuthorityReview(params: {
  supabase: SupabaseClient<Database>
  objectType: 'checkout_session' | 'invoice' | 'subscription' | 'subscription_event'
  objectId: string
  event: SignedStripeEventContext
  error: StripeAuthorityError
  userId?: string | null
}): Promise<void> {
  const candidate = params.userId?.trim().toLowerCase()
  const userId = candidate && UUID_PATTERN.test(candidate) ? candidate : null
  const { data, error } = await params.supabase.rpc('record_b2c_recurring_manual_review_atomic', {
    p_object_type: params.objectType,
    p_object_id: params.objectId || params.event.id,
    p_user_id: userId,
    p_reason_key: `b2c_recurring_authority:${params.error.code}`,
    p_reason: params.error.message,
    p_context: reviewContext(params.error, params.event),
  })
  if (error) {
    throw new Error(`Failed to persist recurring Stripe authority review: ${error.message}`)
  }
  const status = rpcStatus(data, 'record_b2c_recurring_manual_review_atomic')
  if (status !== 'recorded' && status !== 'already_recorded') {
    throw new Error(
      `record_b2c_recurring_manual_review_atomic returned unexpected status ${status}`
    )
  }
}

async function activateRecurringPaymentAuthority(params: {
  supabase: SupabaseClient<Database>
  authority: RecurringPaymentAuthority
  event: SignedStripeEventContext
}): Promise<string> {
  const { authority } = params
  const { data, error } = await params.supabase.rpc('activate_b2c_recurring_payment_atomic', {
    p_user_id: authority.userId,
    p_stripe_customer_id: authority.customerId,
    p_stripe_subscription_id: authority.subscriptionId,
    p_stripe_invoice_id: authority.invoiceId,
    p_stripe_payment_intent_id: authority.paymentIntentId,
    p_stripe_charge_id: authority.chargeId,
    p_stripe_price_id: authority.priceId,
    p_plan: authority.plan,
    p_amount_paid: authority.amount,
    p_currency: authority.currency,
    p_period_start: isoFromStripeSeconds(authority.periodStart, 'Recurring period start'),
    p_period_end: isoFromStripeSeconds(authority.periodEnd, 'Recurring period end'),
    p_payment_status: 'paid',
    p_stripe_subscription_status: authority.subscriptionStatus,
    p_source_event_id: params.event.id,
    p_source_event_created_at: isoFromStripeSeconds(
      params.event.created,
      'Stripe source event created'
    ),
    p_livemode: params.event.livemode,
    p_financial_only: false,
  })
  if (error) throw new Error(`B2C recurring payment activation failed: ${error.message}`)
  const status = rpcStatus(data, 'activate_b2c_recurring_payment_atomic')
  if (!PAYMENT_ACTIVATION_STATUSES.has(status)) {
    throw new Error(`Recurring payment activation returned unexpected status ${status}`)
  }
  return status
}

export async function activateExactRecurringCheckout(params: {
  stripe: StripeAuthorityClient
  supabase: SupabaseClient<Database>
  session: Stripe.Checkout.Session
  event: SignedStripeEventContext
  expectedUserId: string
}): Promise<RecurringAuthorityOutcome> {
  try {
    assertSignedSnapshot({
      event: params.event,
      object: params.session,
      objectPrefix: 'cs_',
      stage: 'checkout_session',
    })
    const resolved = await resolveCheckoutSessionAuthority(
      params.stripe,
      params.session,
      stripeEntitlementAuthorityOptions(params.expectedUserId, params.event.livemode)
    )
    if (resolved.kind === 'trial') {
      const status = await activateRecurringTrialAuthority({
        supabase: params.supabase,
        authority: resolved,
        event: params.event,
      })
      return { status, authority: resolved }
    }
    if (resolved.kind !== 'recurring_payment') {
      throw new StripeAuthorityError({
        code: 'unsupported_product',
        stage: 'product',
        message: 'Checkout Session is not an ordinary recurring Pro entitlement.',
        objectIds: { sessionId: params.session.id },
        details: { authority_kind: resolved.kind },
      })
    }
    const status = await activateRecurringPaymentAuthority({
      supabase: params.supabase,
      authority: resolved,
      event: params.event,
    })
    return { status, authority: resolved }
  } catch (error) {
    if (!(error instanceof StripeAuthorityError)) throw error
    await recordRecurringAuthorityReview({
      supabase: params.supabase,
      objectType: 'checkout_session',
      objectId: params.session.id,
      event: params.event,
      error,
      userId: params.expectedUserId,
    })
    return { status: 'authority_review_recorded', reviewCode: error.code }
  }
}

export async function applyExactRecurringInvoicePayment(params: {
  stripe: StripeAuthorityClient
  supabase: SupabaseClient<Database>
  invoice: Stripe.Invoice
  event: SignedStripeEventContext
  eventType: 'invoice.paid' | 'invoice.payment_succeeded'
}): Promise<RecurringAuthorityOutcome> {
  try {
    assertSignedSnapshot({
      event: params.event,
      object: params.invoice,
      objectPrefix: 'in_',
      stage: 'invoice',
    })
    const subscriptionValue = params.invoice.parent?.subscription_details?.subscription
    const subscriptionId =
      typeof subscriptionValue === 'string' ? subscriptionValue : subscriptionValue?.id || ''
    const signedPriceId = subscriptionId
      ? await resolveExactRecurringInvoicePriceId(
          params.stripe,
          params.invoice,
          params.event.livemode
        )
      : null
    const historical = subscriptionId
      ? await resolveHistoricalPriceAuthority({
          supabase: params.supabase,
          subscriptionId,
          signedPriceId,
          livemode: params.event.livemode,
          stripe: params.stripe,
        })
      : null

    if (
      params.invoice.amount_due === 0 &&
      params.invoice.amount_paid === 0 &&
      params.invoice.amount_remaining === 0 &&
      params.invoice.subtotal === 0 &&
      params.invoice.total === 0
    ) {
      const authority = await resolveTrialZeroInvoiceAuthority(
        params.stripe,
        params.invoice,
        authorityOptionsForHistorical(historical, params.event.livemode)
      )
      const { data, error } = await params.supabase.rpc(
        'apply_b2c_recurring_invoice_event_atomic',
        {
          p_event_id: params.event.id,
          p_event_created_at: isoFromStripeSeconds(params.event.created, 'Stripe event created'),
          p_livemode: params.event.livemode,
          p_event_type: 'trial_zero_invoice',
          p_user_id: authority.userId,
          p_stripe_customer_id: authority.customerId,
          p_stripe_subscription_id: authority.subscriptionId,
          p_stripe_invoice_id: authority.invoiceId,
          p_stripe_invoice_payment_id: null,
          p_stripe_payment_intent_id: null,
          p_stripe_charge_id: null,
          p_stripe_price_id: authority.priceId,
          p_plan: authority.plan,
          p_amount: authority.expectedAmount,
          p_currency: authority.currency,
          p_period_start: isoFromStripeSeconds(authority.periodStart, 'Trial Invoice period start'),
          p_period_end: isoFromStripeSeconds(authority.periodEnd, 'Trial Invoice period end'),
          p_payment_status: 'trial_zero',
          p_stripe_subscription_status: authority.subscriptionStatus,
          p_next_payment_attempt: null,
          p_financial_only: historical?.financialOnly === true,
        }
      )
      if (error) throw new Error(`Zero-dollar trial Invoice persistence failed: ${error.message}`)
      const status = rpcStatus(data, 'apply_b2c_recurring_invoice_event_atomic')
      if (!INVOICE_EVENT_STATUSES.has(status)) {
        throw new Error(`Zero-dollar trial Invoice returned unexpected status ${status}`)
      }
      return { status, authority }
    }
    const authority = historical?.financialOnly
      ? await resolveRecurringInvoiceFinancialObservationAuthority(
          params.stripe,
          params.invoice,
          authorityOptionsForHistorical(historical, params.event.livemode) as ReturnType<
            typeof authorityOptionsForHistorical
          > & { expectedUserId: string; expectedCustomerId: string }
        )
      : await resolveRecurringInvoiceAuthority(
          params.stripe,
          params.invoice,
          authorityOptionsForHistorical(historical, params.event.livemode)
        )
    const { data, error } = await params.supabase.rpc('apply_b2c_recurring_invoice_event_atomic', {
      p_event_id: params.event.id,
      p_event_created_at: isoFromStripeSeconds(params.event.created, 'Stripe event created'),
      p_livemode: params.event.livemode,
      p_event_type: params.eventType,
      p_user_id: authority.userId,
      p_stripe_customer_id: authority.customerId,
      p_stripe_subscription_id: authority.subscriptionId,
      p_stripe_invoice_id: authority.invoiceId,
      p_stripe_invoice_payment_id: authority.invoicePaymentId,
      p_stripe_payment_intent_id: authority.paymentIntentId,
      p_stripe_charge_id: authority.chargeId,
      p_stripe_price_id: authority.priceId,
      p_plan: authority.plan,
      p_amount: authority.amount,
      p_currency: authority.currency,
      p_period_start: isoFromStripeSeconds(authority.periodStart, 'Invoice period start'),
      p_period_end: isoFromStripeSeconds(authority.periodEnd, 'Invoice period end'),
      p_payment_status: 'succeeded',
      p_stripe_subscription_status: authority.subscriptionStatus,
      p_next_payment_attempt: null,
      p_financial_only: historical?.financialOnly === true,
    })
    if (error) throw new Error(`Recurring invoice event persistence failed: ${error.message}`)
    const status = rpcStatus(data, 'apply_b2c_recurring_invoice_event_atomic')
    if (!INVOICE_EVENT_STATUSES.has(status)) {
      throw new Error(`Recurring invoice event returned unexpected status ${status}`)
    }
    return { status, authority }
  } catch (error) {
    if (!(error instanceof StripeAuthorityError)) throw error
    await recordRecurringAuthorityReview({
      supabase: params.supabase,
      objectType: 'invoice',
      objectId: params.invoice.id,
      event: params.event,
      error,
    })
    return { status: 'authority_review_recorded', reviewCode: error.code }
  }
}

export async function applyExactRecurringInvoiceFailure(params: {
  stripe: StripeAuthorityClient
  supabase: SupabaseClient<Database>
  invoice: Stripe.Invoice
  event: SignedStripeEventContext
}): Promise<RecurringAuthorityOutcome> {
  try {
    assertSignedSnapshot({
      event: params.event,
      object: params.invoice,
      objectPrefix: 'in_',
      stage: 'invoice',
    })
    const subscriptionValue = params.invoice.parent?.subscription_details?.subscription
    const subscriptionId =
      typeof subscriptionValue === 'string' ? subscriptionValue : subscriptionValue?.id || ''
    const signedPriceId = subscriptionId
      ? await resolveExactRecurringInvoicePriceId(
          params.stripe,
          params.invoice,
          params.event.livemode
        )
      : null
    const historical = subscriptionId
      ? await resolveHistoricalPriceAuthority({
          supabase: params.supabase,
          subscriptionId,
          signedPriceId,
          livemode: params.event.livemode,
          stripe: params.stripe,
        })
      : null
    const authority = await resolveRecurringInvoiceFailureAuthority(
      params.stripe,
      params.invoice,
      authorityOptionsForHistorical(historical, params.event.livemode)
    )
    const { data, error } = await params.supabase.rpc('apply_b2c_recurring_invoice_event_atomic', {
      p_event_id: params.event.id,
      p_event_created_at: isoFromStripeSeconds(params.event.created, 'Stripe event created'),
      p_livemode: params.event.livemode,
      p_event_type: 'invoice.payment_failed',
      p_user_id: authority.userId,
      p_stripe_customer_id: authority.customerId,
      p_stripe_subscription_id: authority.subscriptionId,
      p_stripe_invoice_id: authority.invoiceId,
      p_stripe_invoice_payment_id: null,
      p_stripe_payment_intent_id: null,
      p_stripe_charge_id: null,
      p_stripe_price_id: authority.priceId,
      p_plan: authority.plan,
      p_amount: authority.amountDue,
      p_currency: authority.currency,
      p_period_start: isoFromStripeSeconds(authority.periodStart, 'Invoice period start'),
      p_period_end: isoFromStripeSeconds(authority.periodEnd, 'Invoice period end'),
      p_payment_status: 'failed',
      p_stripe_subscription_status: authority.subscriptionStatus,
      p_next_payment_attempt: authority.nextPaymentAttempt
        ? isoFromStripeSeconds(authority.nextPaymentAttempt, 'Next payment attempt')
        : null,
      p_financial_only: historical?.financialOnly === true,
    })
    if (error) throw new Error(`Failed invoice event persistence failed: ${error.message}`)
    const status = rpcStatus(data, 'apply_b2c_recurring_invoice_event_atomic')
    if (!INVOICE_EVENT_STATUSES.has(status)) {
      throw new Error(`Failed invoice event returned unexpected status ${status}`)
    }
    return { status, authority }
  } catch (error) {
    if (!(error instanceof StripeAuthorityError)) throw error
    await recordRecurringAuthorityReview({
      supabase: params.supabase,
      objectType: 'invoice',
      objectId: params.invoice.id,
      event: params.event,
      error,
    })
    return { status: 'authority_review_recorded', reviewCode: error.code }
  }
}

async function activateRecurringTrialAuthority(params: {
  supabase: SupabaseClient<Database>
  authority: TrialAuthority
  event: SignedStripeEventContext
}): Promise<string> {
  const { authority } = params
  const { data, error } = await params.supabase.rpc('activate_b2c_recurring_trial_atomic', {
    p_user_id: authority.userId,
    p_stripe_customer_id: authority.customerId,
    p_stripe_subscription_id: authority.subscriptionId,
    p_stripe_price_id: authority.priceId,
    p_plan: authority.plan,
    p_expected_amount: authority.expectedAmount,
    p_currency: authority.currency,
    p_period_start: isoFromStripeSeconds(authority.periodStart, 'Trial period start'),
    p_period_end: isoFromStripeSeconds(authority.periodEnd, 'Trial period end'),
    p_stripe_subscription_status: authority.subscriptionStatus,
    p_source_event_id: params.event.id,
    p_source_event_created_at: isoFromStripeSeconds(
      params.event.created,
      'Stripe source event created'
    ),
    p_livemode: params.event.livemode,
  })
  if (error) throw new Error(`Recurring trial activation failed: ${error.message}`)
  const status = rpcStatus(data, 'activate_b2c_recurring_trial_atomic')
  if (!TRIAL_ACTIVATION_STATUSES.has(status)) {
    throw new Error(`Recurring trial activation returned unexpected status ${status}`)
  }
  return status
}

export async function reconcileExactRecurringSubscriptionEvent(params: {
  stripe: StripeAuthorityClient
  supabase: SupabaseClient<Database>
  subscription: Stripe.Subscription
  event: SignedStripeEventContext
}): Promise<RecurringAuthorityOutcome> {
  try {
    assertSignedSnapshot({
      event: params.event,
      object: params.subscription,
      objectPrefix: 'sub_',
      stage: 'subscription',
    })
    const historical = await resolveHistoricalPriceAuthority({
      supabase: params.supabase,
      subscriptionId: params.subscription.id,
      signedPriceId: signedSubscriptionPriceId(params.subscription),
      livemode: params.event.livemode,
      signedSubscription: params.subscription,
      stripe: params.stripe,
    })
    if (
      historical &&
      !historical.financialOnly &&
      historical.legacyUnboundPrice &&
      (params.subscription.status === 'active' || params.subscription.status === 'trialing')
    ) {
      throw new StripeAuthorityError({
        code: 'unsupported_product',
        stage: 'product',
        message:
          'A pre-cutover unbound Price cannot grant or change active authority without a new exact paid Invoice.',
        objectIds: { subscriptionId: params.subscription.id },
        details: { priceId: historical.priceId, status: params.subscription.status },
      })
    }
    const authority = await resolveSubscriptionEventStateAuthority(
      params.stripe,
      params.subscription,
      authorityOptionsForHistorical(historical, params.event.livemode)
    )
    const hasExactTrialWindow =
      Number.isSafeInteger(params.subscription.trial_start) &&
      Number.isSafeInteger(params.subscription.trial_end) &&
      params.subscription.trial_start === authority.periodStart &&
      params.subscription.trial_end === authority.periodEnd &&
      authority.periodEnd - authority.periodStart === 7 * 24 * 60 * 60
    const rpcName = hasExactTrialWindow
      ? 'activate_and_reconcile_b2c_recurring_trial_event_atomic'
      : 'reconcile_b2c_subscription_event_atomic'
    const rpcArgs = subscriptionReconciliationArgs(authority, params.event)
    const { data, error } = await params.supabase.rpc(rpcName, rpcArgs)
    if (error) throw new Error(`Recurring subscription reconciliation failed: ${error.message}`)
    const status = rpcStatus(data, rpcName)
    if (!SUBSCRIPTION_RECONCILIATION_STATUSES.has(status)) {
      throw new Error(`Recurring subscription reconciliation returned unexpected status ${status}`)
    }
    return { status }
  } catch (error) {
    if (!(error instanceof StripeAuthorityError)) throw error
    await recordRecurringAuthorityReview({
      supabase: params.supabase,
      objectType: 'subscription_event',
      objectId: params.event.id,
      event: params.event,
      error,
    })
    return { status: 'authority_review_recorded', reviewCode: error.code }
  }
}

function subscriptionReconciliationArgs(
  authority: SubscriptionEventStateAuthority,
  event: SignedStripeEventContext
) {
  const graceExpiresAt =
    authority.subscriptionStatus === 'past_due'
      ? isoFromStripeSeconds(event.created + 14 * 24 * 60 * 60, 'Retry grace expiry')
      : null
  return {
    p_user_id: authority.userId,
    p_stripe_customer_id: authority.customerId,
    p_stripe_subscription_id: authority.subscriptionId,
    p_stripe_price_id: authority.priceId,
    p_current_invoice_id: authority.currentInvoiceId,
    p_plan: authority.plan,
    p_expected_amount: authority.expectedAmount,
    p_currency: authority.currency,
    p_period_start: isoFromStripeSeconds(authority.periodStart, 'Subscription period start'),
    p_period_end: isoFromStripeSeconds(authority.periodEnd, 'Subscription period end'),
    p_stripe_status: authority.subscriptionStatus,
    p_cancel_at_period_end: authority.cancelAtPeriodEnd,
    p_canceled_at: authority.canceledAt
      ? isoFromStripeSeconds(authority.canceledAt, 'Subscription canceled at')
      : null,
    p_grace_expires_at: graceExpiresAt,
    p_event_id: event.id,
    p_event_created_at: isoFromStripeSeconds(event.created, 'Stripe event created'),
    p_livemode: event.livemode,
  }
}
