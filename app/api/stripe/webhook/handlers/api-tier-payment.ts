import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { API_PRICING } from '@/app/(app)/user-center/membership-config'
import type { Database, Json } from '@/lib/supabase/database.types'
import {
  resolveRecurringInvoiceAuthority,
  StripeAuthorityError,
  type StripeAuthorityClient,
} from '@/lib/stripe/entitlement-authority'
import {
  recordRecurringAuthorityReview,
  type SignedStripeEventContext,
} from '@/lib/stripe/recurring-entitlement'
import {
  parseApiTierSubscriptionAuthority,
  resolveApiTierCheckoutConfirmation,
  type ApiTierCheckoutSessionClient,
} from './subscription'

const MAX_STRIPE_UNIX_SECONDS = 253_402_300_799
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const EVENT_PATTERN = /^evt_[A-Za-z0-9_]+$/

type ApiTierPaidEvent = SignedStripeEventContext & {
  type: 'invoice.paid' | 'invoice.payment_succeeded'
}

type ApiTierPaidStripeClient = StripeAuthorityClient & ApiTierCheckoutSessionClient

export type ApiTierPaidInvoiceOutcome = {
  status: 'applied' | 'account_recovery_billing_blocked' | 'authority_review_recorded'
  reviewCode?: StripeAuthorityError['code']
  idempotentReplay?: boolean
}

function isExactStripeId(value: unknown, prefix: string): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length <= 255 &&
    value.startsWith(prefix) &&
    value.length > prefix.length &&
    /^[A-Za-z0-9_]+$/.test(value.slice(prefix.length))
  )
}

function isStripeSecond(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_STRIPE_UNIX_SECONDS
  )
}

function isoFromStripeSecond(value: number, label: string): string {
  if (!isStripeSecond(value)) throw new Error(`${label} is not a valid Stripe timestamp`)
  return new Date(value * 1000).toISOString()
}

function authorityError(params: {
  code: StripeAuthorityError['code']
  stage: StripeAuthorityError['stage']
  message: string
  invoiceId: string
  subscriptionId?: string
  details?: Record<string, unknown>
}): never {
  throw new StripeAuthorityError({
    code: params.code,
    stage: params.stage,
    message: params.message,
    objectIds: {
      invoiceId: params.invoiceId,
      ...(params.subscriptionId ? { subscriptionId: params.subscriptionId } : {}),
    },
    details: params.details ?? {},
  })
}

function assertSignedInvoice(invoice: Stripe.Invoice, event: ApiTierPaidEvent): string {
  const subscriptionValue = invoice.parent?.subscription_details?.subscription
  const subscriptionId =
    typeof subscriptionValue === 'string' ? subscriptionValue : subscriptionValue?.id
  if (
    !isExactStripeId(event.id, 'evt_') ||
    !EVENT_PATTERN.test(event.id) ||
    !isStripeSecond(event.created) ||
    typeof event.livemode !== 'boolean' ||
    !isExactStripeId(invoice.id, 'in_') ||
    invoice.object !== 'invoice' ||
    !isStripeSecond(invoice.created) ||
    invoice.created > event.created ||
    typeof invoice.livemode !== 'boolean' ||
    invoice.livemode !== event.livemode ||
    invoice.parent?.type !== 'subscription_details' ||
    !isExactStripeId(subscriptionId, 'sub_')
  ) {
    authorityError({
      code: 'invalid_object',
      stage: 'invoice',
      message: 'Signed API Invoice identity or event chronology is malformed.',
      invoiceId: invoice.id,
      details: {
        eventId: event.id,
        eventCreated: event.created,
        invoiceCreated: invoice.created,
        subscriptionId: subscriptionId ?? null,
      },
    })
  }
  return subscriptionId
}

function assertFreshSubscription(params: {
  subscription: Stripe.Subscription
  subscriptionId: string
  invoice: Stripe.Invoice
  event: ApiTierPaidEvent
}): void {
  const { subscription, subscriptionId, invoice, event } = params
  if (
    subscription.object !== 'subscription' ||
    subscription.id !== subscriptionId ||
    !isExactStripeId(subscription.id, 'sub_') ||
    !isStripeSecond(subscription.created) ||
    subscription.created > invoice.created ||
    subscription.created > event.created ||
    typeof subscription.livemode !== 'boolean' ||
    subscription.livemode !== event.livemode ||
    subscription.status !== 'active'
  ) {
    authorityError({
      code: 'invalid_payment_state',
      stage: 'subscription',
      message: 'Fresh API Subscription is not one active, chronological payment authority.',
      invoiceId: invoice.id,
      subscriptionId,
      details: {
        returnedSubscriptionId: subscription.id,
        subscriptionCreated: subscription.created,
        invoiceCreated: invoice.created,
        status: subscription.status,
        subscriptionLivemode: subscription.livemode,
        eventLivemode: event.livemode,
      },
    })
  }
}

function exactRecord(value: Json): Record<string, Json | undefined> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, Json | undefined>)
    : null
}

function hasExactKeys(value: Record<string, Json | undefined>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function canonicalUuid(value: Json | undefined): value is string {
  return typeof value === 'string' && value === value.toLowerCase() && UUID_PATTERN.test(value)
}

function parseApplyAck(
  value: Json,
  expectedSubscriptionId: string
): ApiTierPaidInvoiceOutcome | null {
  const record = exactRecord(value)
  if (!record || typeof record.status !== 'string') return null
  if (record.status === 'identity_conflict') {
    return null
  }
  if (record.status === 'applied') {
    if (
      !hasExactKeys(record, [
        'status',
        'payment_id',
        'ownership_id',
        'subscription_status',
        'idempotent_replay',
      ]) ||
      !canonicalUuid(record.payment_id) ||
      !canonicalUuid(record.ownership_id) ||
      (record.subscription_status !== 'applied' &&
        record.subscription_status !== 'idempotent' &&
        record.subscription_status !== 'stale') ||
      typeof record.idempotent_replay !== 'boolean'
    ) {
      return null
    }
    return { status: 'applied', idempotentReplay: record.idempotent_replay }
  }
  if (record.status === 'account_recovery_billing_blocked') {
    if (
      !hasExactKeys(record, [
        'status',
        'payment_id',
        'ownership_id',
        'recovery_operation_id',
        'refund_effect_id',
        'cancellation_effect_id',
        'stripe_subscription_id',
        'idempotent_replay',
      ]) ||
      !canonicalUuid(record.payment_id) ||
      !canonicalUuid(record.ownership_id) ||
      !canonicalUuid(record.recovery_operation_id) ||
      !canonicalUuid(record.refund_effect_id) ||
      !canonicalUuid(record.cancellation_effect_id) ||
      record.stripe_subscription_id !== expectedSubscriptionId ||
      typeof record.idempotent_replay !== 'boolean'
    ) {
      return null
    }
    return {
      status: 'account_recovery_billing_blocked',
      idempotentReplay: record.idempotent_replay,
    }
  }
  return null
}

function isExactIdentityConflictAck(value: Json): boolean {
  const record = exactRecord(value)
  return !!record && record.status === 'identity_conflict' && hasExactKeys(record, ['status'])
}

/**
 * Turns a signature-verified API Invoice into quota only after rebuilding the
 * complete current Stripe graph and committing its immutable money identity in
 * one recovery-gated database transaction.
 */
export async function applyExactApiTierInvoicePayment(params: {
  stripe: ApiTierPaidStripeClient
  supabase: SupabaseClient<Database>
  invoice: Stripe.Invoice
  event: ApiTierPaidEvent
}): Promise<ApiTierPaidInvoiceOutcome> {
  let candidateUserId: string | null = null
  try {
    const subscriptionId = assertSignedInvoice(params.invoice, params.event)
    // This provider read intentionally stays outside the deterministic review
    // catch boundary: transport failures must make Stripe retry the webhook.
    const subscription = await params.stripe.subscriptions.retrieve(subscriptionId)
    assertFreshSubscription({
      subscription,
      subscriptionId,
      invoice: params.invoice,
      event: params.event,
    })

    const apiAuthority = parseApiTierSubscriptionAuthority(subscription)
    candidateUserId = apiAuthority.userId
    if (!apiAuthority.checkoutReservationId) {
      authorityError({
        code: 'identity_missing',
        stage: 'subscription',
        message: 'Paid API Subscription has no immutable Checkout reservation identity.',
        invoiceId: params.invoice.id,
        subscriptionId,
      })
    }

    const checkout = await resolveApiTierCheckoutConfirmation(
      params.stripe,
      subscription,
      apiAuthority,
      params.event
    )
    if (
      !checkout ||
      checkout.checkoutPlan !== apiAuthority.plan ||
      checkout.checkoutPriceId !== apiAuthority.stripePriceId
    ) {
      authorityError({
        code: 'identity_conflict',
        stage: 'checkout_session',
        message: 'Paid API Checkout does not match the fresh Subscription product.',
        invoiceId: params.invoice.id,
        subscriptionId,
      })
    }

    const expectedAmount = Math.round(API_PRICING[apiAuthority.plan].price * 100)
    const payment = await resolveRecurringInvoiceAuthority(params.stripe, params.invoice, {
      expectedUserId: apiAuthority.userId,
      expectedCustomerId: apiAuthority.stripeCustomerId,
      expectedLivemode: params.event.livemode,
      products: {
        prices: {
          monthly: [apiAuthority.stripePriceId],
          yearly: [],
          lifetime: [],
        },
        expectedCurrency: 'usd',
        expectedRecurringAmountsByPrice: {
          [apiAuthority.stripePriceId]: expectedAmount,
        },
      },
    })

    if (
      payment.kind !== 'recurring_payment' ||
      payment.userId !== apiAuthority.userId ||
      payment.customerId !== apiAuthority.stripeCustomerId ||
      payment.subscriptionId !== subscription.id ||
      payment.invoiceId !== params.invoice.id ||
      payment.priceId !== apiAuthority.stripePriceId ||
      payment.plan !== 'monthly' ||
      payment.amount !== expectedAmount ||
      payment.currency !== 'usd' ||
      payment.subscriptionStatus !== 'active' ||
      !isStripeSecond(payment.invoiceCreatedAt) ||
      payment.invoiceCreatedAt !== params.invoice.created ||
      !isStripeSecond(payment.paidAt) ||
      checkout.sessionCreated > subscription.created ||
      subscription.created > payment.invoiceCreatedAt ||
      payment.invoiceCreatedAt > payment.paidAt ||
      payment.paidAt > params.event.created ||
      !isStripeSecond(payment.periodStart) ||
      !isStripeSecond(payment.periodEnd) ||
      payment.periodStart > payment.paidAt ||
      payment.paidAt >= payment.periodEnd
    ) {
      authorityError({
        code: 'object_mismatch',
        stage: 'invoice',
        message: 'API Invoice payment graph or chronology contradicted its Checkout authority.',
        invoiceId: params.invoice.id,
        subscriptionId,
        details: {
          checkoutCreated: checkout.sessionCreated,
          subscriptionCreated: subscription.created,
          invoiceCreated: payment.invoiceCreatedAt,
          paidAt: payment.paidAt,
          eventCreated: params.event.created,
          priceId: payment.priceId,
          amount: payment.amount,
          status: payment.subscriptionStatus,
        },
      })
    }

    const { data, error } = await params.supabase.rpc('apply_api_tier_paid_invoice_event_atomic', {
      p_event_id: params.event.id,
      p_event_created_at: isoFromStripeSecond(params.event.created, 'API event created'),
      p_event_type: params.event.type,
      p_livemode: params.event.livemode,
      p_user_id: apiAuthority.userId,
      p_metadata_user_id: apiAuthority.metadataUserId,
      p_metadata_supabase_user_id: apiAuthority.metadataSupabaseUserId,
      p_stripe_customer_id: apiAuthority.stripeCustomerId,
      p_checkout_reservation_id: apiAuthority.checkoutReservationId,
      p_checkout_session_id: checkout.sessionId,
      p_session_created_at: isoFromStripeSecond(checkout.sessionCreated, 'API Checkout created'),
      p_stripe_subscription_id: subscription.id,
      p_subscription_created: subscription.created,
      p_subscription_status: subscription.status,
      p_stripe_invoice_id: payment.invoiceId,
      p_stripe_invoice_payment_id: payment.invoicePaymentId,
      p_stripe_payment_intent_id: payment.paymentIntentId,
      p_stripe_charge_id: payment.chargeId,
      p_stripe_price_id: payment.priceId,
      p_api_plan: apiAuthority.plan,
      p_amount_paid: payment.amount,
      p_currency: payment.currency,
      p_period_start: isoFromStripeSecond(payment.periodStart, 'API period start'),
      p_period_end: isoFromStripeSecond(payment.periodEnd, 'API period end'),
      p_invoice_created_at: isoFromStripeSecond(payment.invoiceCreatedAt, 'API Invoice created'),
      p_paid_at: isoFromStripeSecond(payment.paidAt, 'API Invoice paid'),
    })
    if (error) throw new Error(`API paid Invoice persistence failed: ${error.message}`)

    if (isExactIdentityConflictAck(data)) {
      authorityError({
        code: 'identity_conflict',
        stage: 'identity',
        message: 'API paid Invoice conflicted with durable payment ownership.',
        invoiceId: params.invoice.id,
        subscriptionId,
      })
    }
    const ack = parseApplyAck(data, subscription.id)
    if (!ack) throw new Error('API paid Invoice persistence returned an invalid acknowledgement')
    return ack
  } catch (error) {
    if (!(error instanceof StripeAuthorityError)) throw error
    await recordRecurringAuthorityReview({
      supabase: params.supabase,
      objectType: 'invoice',
      objectId: params.invoice.id,
      event: params.event,
      error,
      userId: candidateUserId,
    })
    return { status: 'authority_review_recorded', reviewCode: error.code }
  }
}
