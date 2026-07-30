import Stripe from 'stripe'
import { getStripe } from '@/lib/stripe'
import { getSupabase, logger, type StripeWebhookEventContext } from './shared'
import { deliverNotification, sendNotification } from '@/lib/data/notifications'
import { carriesApiTierSubscriptionIdentity } from './api-tier-identity'
import {
  resolveSubscriptionEventStateAuthority,
  StripeAuthorityError,
} from '@/lib/stripe/entitlement-authority'
import {
  recordApiTierInvoicePayment,
  resolveApiTierInvoicePaymentAuthority,
} from '@/lib/stripe/api-tier-payment'
import { activateRecurringInvoiceEntitlement } from '@/lib/stripe/recurring-entitlement'
import { recordStripeCheckoutManualReview } from '@/lib/stripe/lifetime-entitlement'
import { drainApiTierReversalActions } from '@/lib/stripe/api-tier-reversal-actions'
import type { Json } from '@/lib/supabase/database.types'
import {
  assertRecurringProCheckoutCompleted,
  carriesRecurringProCheckoutMarker,
  parseRecurringProCheckoutMetadata,
} from '@/lib/stripe/recurring-pro-checkout'
import { stripeEntitlementAuthorityOptions } from '@/lib/stripe/entitlement-runtime'

export type StripePaidInvoiceEventContext = StripeWebhookEventContext & {
  type: 'invoice.paid' | 'invoice.payment_succeeded'
}
export type StripeFailedInvoiceEventContext = StripeWebhookEventContext & {
  type: 'invoice.payment_failed'
}

const MAX_STRIPE_UNIX_SECONDS = 253_402_300_799
const RECURRING_PAYMENT_HISTORY_SUCCESS_STATUSES = new Set([
  'recorded',
  'already_recorded',
  'promoted_from_failed',
  'identity_conflict',
] as const)

type RecurringPaymentHistorySuccessStatus =
  | 'recorded'
  | 'already_recorded'
  | 'promoted_from_failed'
  | 'identity_conflict'

function recurringPaymentHistorySuccessStatus(
  value: unknown
): RecurringPaymentHistorySuccessStatus {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 1 ||
    !('status' in value) ||
    typeof value.status !== 'string' ||
    !RECURRING_PAYMENT_HISTORY_SUCCESS_STATUSES.has(
      value.status as RecurringPaymentHistorySuccessStatus
    )
  ) {
    throw new Error('record_recurring_payment_history_success_atomic returned an invalid result')
  }
  return value.status as RecurringPaymentHistorySuccessStatus
}

function candidateInvoiceUserId(invoice: Stripe.Invoice): string | null {
  const metadata = invoice.parent?.subscription_details?.metadata
  const userId = metadata?.userId?.trim().toLowerCase()
  const supabaseUserId = metadata?.supabase_user_id?.trim().toLowerCase()
  return userId && userId === supabaseUserId ? userId : null
}

function reviewJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

async function recordPaidInvoiceReview(params: {
  invoice: Stripe.Invoice
  event: StripePaidInvoiceEventContext
  reasonKey: string
  reason: string
  context?: Record<string, unknown>
}): Promise<void> {
  await recordStripeCheckoutManualReview({
    supabase: getSupabase(),
    objectType: 'invoice',
    sessionId: params.invoice.id,
    userId: candidateInvoiceUserId(params.invoice),
    reasonKey: params.reasonKey,
    reason: params.reason,
    context: reviewJson({
      invoice_id: params.invoice.id,
      customer_id:
        typeof params.invoice.customer === 'string'
          ? params.invoice.customer
          : (params.invoice.customer?.id ?? null),
      subscription_id:
        typeof params.invoice.parent?.subscription_details?.subscription === 'string'
          ? params.invoice.parent.subscription_details.subscription
          : (params.invoice.parent?.subscription_details?.subscription?.id ?? null),
      invoice_amount_paid: params.invoice.amount_paid,
      invoice_currency: params.invoice.currency,
      invoice_livemode: params.invoice.livemode,
      event_id: params.event.id,
      event_type: params.event.type,
      event_created: params.event.created,
      event_livemode: params.event.livemode,
      ...(params.context ?? {}),
    }),
  })
}

async function recordFailedInvoiceReview(params: {
  invoice: Stripe.Invoice
  event: StripeFailedInvoiceEventContext
  reasonKey: string
  reason: string
  userId?: string | null
  context?: Record<string, unknown>
}): Promise<void> {
  await recordStripeCheckoutManualReview({
    supabase: getSupabase(),
    objectType: 'invoice_event',
    sessionId: params.event.id,
    userId: params.userId ?? candidateInvoiceUserId(params.invoice),
    reasonKey: params.reasonKey,
    reason: params.reason,
    context: reviewJson({
      invoice_id: params.invoice.id,
      invoice_created: params.invoice.created,
      invoice_status: params.invoice.status,
      invoice_amount_paid: params.invoice.amount_paid,
      invoice_amount_due: params.invoice.amount_due,
      invoice_currency: params.invoice.currency,
      invoice_livemode: params.invoice.livemode,
      customer_id:
        typeof params.invoice.customer === 'string'
          ? params.invoice.customer
          : (params.invoice.customer?.id ?? null),
      subscription_id:
        typeof params.invoice.parent?.subscription_details?.subscription === 'string'
          ? params.invoice.parent.subscription_details.subscription
          : (params.invoice.parent?.subscription_details?.subscription?.id ?? null),
      event_id: params.event.id,
      event_type: params.event.type,
      event_created: params.event.created,
      event_livemode: params.event.livemode,
      ...(params.context ?? {}),
    }),
  })
}

function exactPaidEventContext(
  invoice: Stripe.Invoice,
  event: StripePaidInvoiceEventContext
): boolean {
  return (
    /^in_[A-Za-z0-9_]+$/.test(invoice.id) &&
    invoice.id.length <= 255 &&
    /^evt_[A-Za-z0-9_]+$/.test(event.id) &&
    event.id.length <= 255 &&
    Number.isSafeInteger(invoice.created) &&
    invoice.created > 0 &&
    invoice.created <= event.created &&
    (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') &&
    Number.isSafeInteger(event.created) &&
    event.created > 0 &&
    event.created <= MAX_STRIPE_UNIX_SECONDS &&
    typeof event.livemode === 'boolean' &&
    invoice.livemode === event.livemode
  )
}

function exactFailedEventContext(
  invoice: Stripe.Invoice,
  event: StripeFailedInvoiceEventContext
): boolean {
  return (
    /^in_[A-Za-z0-9_]+$/.test(invoice.id) &&
    invoice.id.length <= 255 &&
    /^evt_[A-Za-z0-9_]+$/.test(event.id) &&
    event.id.length <= 255 &&
    event.type === 'invoice.payment_failed' &&
    Number.isSafeInteger(invoice.created) &&
    invoice.created > 0 &&
    invoice.created <= event.created &&
    Number.isSafeInteger(event.created) &&
    event.created > 0 &&
    event.created <= MAX_STRIPE_UNIX_SECONDS &&
    typeof event.livemode === 'boolean' &&
    invoice.livemode === event.livemode &&
    Number.isSafeInteger(invoice.amount_paid) &&
    invoice.amount_paid === 0 &&
    Number.isSafeInteger(invoice.amount_due) &&
    invoice.amount_due > 0 &&
    Number.isSafeInteger(invoice.amount_remaining) &&
    invoice.amount_remaining === invoice.amount_due &&
    invoice.currency === 'usd'
  )
}

export async function handlePaymentSucceeded(
  invoice: Stripe.Invoice,
  event: StripePaidInvoiceEventContext
) {
  if (!Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid <= 0) return
  if (!exactPaidEventContext(invoice, event)) {
    await recordPaidInvoiceReview({
      invoice,
      event,
      reasonKey: 'paid_invoice_event_context_invalid',
      reason: 'A paid Invoice webhook has malformed or mismatched event context.',
    })
    throw new Error(`Paid Invoice ${invoice.id} event context is invalid`)
  }

  const subscriptionData = invoice.parent?.subscription_details?.subscription
  const subscriptionId =
    typeof subscriptionData === 'string' ? subscriptionData : subscriptionData?.id || null

  if (!subscriptionId) {
    await recordPaidInvoiceReview({
      invoice,
      event,
      reasonKey: 'paid_invoice_subscription_missing',
      reason: 'A positive paid Invoice has no exact subscription identity.',
    })
    return
  }

  const stripeClient = getStripe()
  const subscription = await stripeClient.subscriptions.retrieve(subscriptionId)
  if (carriesApiTierSubscriptionIdentity(subscription)) {
    try {
      const observation = {
        type: event.type,
        id: event.id,
        created: event.created,
        livemode: event.livemode,
      } as const
      const authority = await resolveApiTierInvoicePaymentAuthority({
        stripe: stripeClient,
        invoice,
        observation,
      })
      const outcome = await recordApiTierInvoicePayment({
        supabase: getSupabase(),
        authority,
        observation,
      })
      logger.info('API tier Invoice payment reached a durable state', {
        invoiceId: invoice.id,
        subscriptionId,
        status: outcome.status,
        projectionStatus: outcome.projectionStatus,
      })
      if (outcome.shouldCancel) {
        void drainApiTierReversalActions({ limit: 1 }).catch((error) => {
          logger.error('Durable API tier reversal action remains queued', {
            invoiceId: invoice.id,
            subscriptionId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      return
    } catch (error) {
      if (!(error instanceof StripeAuthorityError)) throw error
      await recordPaidInvoiceReview({
        invoice,
        event,
        reasonKey: `api_tier_invoice_authority:${error.code}`,
        reason: error.message,
        context: { authority: error.toReviewPayload() },
      })
      logger.error('API tier paid Invoice routed to durable review', {
        invoiceId: invoice.id,
        subscriptionId,
        authorityCode: error.code,
      })
      return
    }
  }

  let activation: Awaited<ReturnType<typeof activateRecurringInvoiceEntitlement>>
  try {
    activation = await activateRecurringInvoiceEntitlement({
      stripe: stripeClient,
      supabase: getSupabase(),
      invoice,
      livemode: event.livemode,
    })
  } catch (error) {
    if (error instanceof StripeAuthorityError) {
      await recordPaidInvoiceReview({
        invoice,
        event,
        reasonKey: `recurring_invoice_authority:${error.code}`,
        reason: error.message,
        context: { authority: error.toReviewPayload() },
      })
      logger.error('Ordinary Pro paid Invoice routed to durable review', {
        invoiceId: invoice.id,
        subscriptionId,
        authorityCode: error.code,
      })
      return
    }
    await recordPaidInvoiceReview({
      invoice,
      event,
      reasonKey: 'recurring_invoice_activation_failed',
      reason: error instanceof Error ? error.message : String(error),
      context: {
        subscription_id: subscriptionId,
      },
    })
    throw error
  }

  const { authority } = activation
  const { data: profile, error: profileError } = await getSupabase()
    .from('user_profiles')
    .select('id, subscription_tier, stripe_customer_id')
    .eq('id', authority.userId)
    .maybeSingle()

  if (profileError) {
    throw new Error(`Failed to find successful payment owner: ${profileError.message}`)
  }
  if (!profile) {
    if (activation.status === 'subject_deleted') {
      logger.info('Recurring payment retained after subject deletion', {
        invoiceId: invoice.id,
        userId: authority.userId,
      })
      return
    }
    await recordPaidInvoiceReview({
      invoice,
      event,
      reasonKey: 'recurring_invoice_owner_missing_after_activation',
      reason: 'A durable recurring payment has no matching profile subject.',
      context: { activation_status: activation.status, user_id: authority.userId },
    })
    throw new Error(`Recurring payment ${invoice.id} owner disappeared after activation`)
  }
  if (profile.id !== authority.userId || profile.stripe_customer_id !== authority.customerId) {
    await recordPaidInvoiceReview({
      invoice,
      event,
      reasonKey: 'recurring_invoice_owner_identity_conflict',
      reason: 'Recurring payment owner no longer matches the Stripe Customer.',
      context: {
        activation_status: activation.status,
        authority_user_id: authority.userId,
        authority_customer_id: authority.customerId,
        profile_customer_id: profile.stripe_customer_id,
      },
    })
    return
  }

  const { data: historyData, error: historyErr } = await getSupabase().rpc(
    'record_recurring_payment_history_success_atomic',
    {
      p_user_id: profile.id,
      p_livemode: event.livemode,
      p_stripe_event_id: event.id,
      p_stripe_event_created: event.created,
      p_stripe_invoice_id: invoice.id,
      p_stripe_payment_intent_id: authority.paymentIntentId,
      p_amount_paid: authority.amount,
      p_currency: authority.currency,
    }
  )
  if (historyErr) {
    logger.error('Failed to record payment', { error: historyErr, invoiceId: invoice.id })
    throw new Error(`Failed to record successful payment: ${historyErr.message}`)
  }
  const historyStatus = recurringPaymentHistorySuccessStatus(historyData)
  if (historyStatus === 'identity_conflict') {
    logger.error('Recurring payment compatibility history requires manual review', {
      invoiceId: invoice.id,
      userId: profile.id,
      activationStatus: activation.status,
    })
    return
  }
  logger.info('Recurring Pro Invoice payment reached a durable state', {
    userId: profile.id,
    invoiceId: invoice.id,
    amount: authority.amount,
    activationStatus: activation.status,
    historyStatus,
  })
}

export async function handlePaymentFailed(
  invoice: Stripe.Invoice,
  event: StripeFailedInvoiceEventContext
) {
  if (!exactFailedEventContext(invoice, event)) {
    await recordFailedInvoiceReview({
      invoice,
      event,
      reasonKey: 'failed_invoice_event_context_invalid',
      reason: 'A failed Invoice webhook has malformed or mismatched signed event context.',
    })
    throw new Error(`Failed Invoice ${invoice.id} event context is invalid`)
  }

  const subscriptionData = invoice.parent?.subscription_details?.subscription
  const subscriptionId =
    typeof subscriptionData === 'string' ? subscriptionData : subscriptionData?.id || null

  if (!subscriptionId) {
    await recordFailedInvoiceReview({
      invoice,
      event,
      reasonKey: 'failed_invoice_subscription_missing',
      reason: 'A failed recurring Invoice has no exact Subscription identity.',
    })
    throw new Error(`Failed Invoice ${invoice.id} subscription identity is missing`)
  }

  const stripeClient = getStripe()
  const subscription = await stripeClient.subscriptions.retrieve(subscriptionId)

  if (carriesApiTierSubscriptionIdentity(subscription)) {
    // API tier retry/grace/revocation is handled by customer.subscription.*
    // through the atomic API entitlement ledger. Never mutate the Pro tables.
    logger.info('API tier payment failure left to subscription event authority', {
      invoiceId: invoice.id,
      subscriptionId,
    })
    return
  }

  const identity = parseRecurringProCheckoutMetadata(subscription.metadata)
  const invoiceIdentity = parseRecurringProCheckoutMetadata(
    invoice.parent?.subscription_details?.metadata
  )
  if (
    !carriesRecurringProCheckoutMarker(subscription.metadata) ||
    !identity ||
    !invoiceIdentity ||
    JSON.stringify(identity) !== JSON.stringify(invoiceIdentity)
  ) {
    await recordFailedInvoiceReview({
      invoice,
      event,
      reasonKey: 'failed_invoice_recurring_identity_invalid',
      reason:
        'A failed recurring Pro Invoice has legacy, malformed, or conflicting Checkout identity.',
      userId: identity?.userId ?? invoiceIdentity?.userId ?? null,
    })
    throw new Error(`Failed Invoice ${invoice.id} recurring Pro identity is invalid`)
  }

  try {
    const authority = await resolveSubscriptionEventStateAuthority(stripeClient, subscription, {
      ...stripeEntitlementAuthorityOptions(identity.userId),
      expectedLivemode: event.livemode,
    })
    const invoiceCustomer =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null
    if (
      authority.subscriptionStatus !== 'past_due' ||
      authority.currentInvoiceId !== invoice.id ||
      authority.subscriptionId !== subscriptionId ||
      authority.customerId !== invoiceCustomer ||
      authority.customerId !== identity.customerId ||
      authority.userId !== identity.userId ||
      authority.plan !== identity.plan ||
      authority.priceId !== identity.priceId
    ) {
      throw new Error(`Failed Invoice ${invoice.id} does not match exact subscription state`)
    }

    await assertRecurringProCheckoutCompleted({
      supabase: getSupabase(),
      identity,
      livemode: event.livemode,
      subscriptionId,
    })

    const { data: profile, error: profileError } = await getSupabase()
      .from('user_profiles')
      .select('id, stripe_customer_id')
      .eq('id', authority.userId)
      .maybeSingle()

    if (profileError) {
      throw new Error(`Failed to find failed payment owner: ${profileError.message}`)
    }
    if (
      !profile ||
      profile.id !== authority.userId ||
      profile.stripe_customer_id !== authority.customerId
    ) {
      throw new Error(`Failed Invoice ${invoice.id} owner identity does not match`)
    }

    const { data: existingFailure, error: existingFailureError } = await getSupabase()
      .from('payment_history')
      .select('user_id, stripe_invoice_id, amount, currency, status')
      .eq('stripe_invoice_id', invoice.id)
      .maybeSingle()
    if (existingFailureError) {
      throw new Error(`Failed to inspect payment failure history: ${existingFailureError.message}`)
    }

    if (existingFailure) {
      if (
        existingFailure.user_id !== authority.userId ||
        existingFailure.stripe_invoice_id !== invoice.id ||
        existingFailure.amount !== invoice.amount_due ||
        existingFailure.currency !== invoice.currency ||
        existingFailure.status !== 'failed'
      ) {
        throw new Error(`Failed Invoice ${invoice.id} conflicts with durable payment history`)
      }
    } else {
      const { error: historyErr } = await getSupabase()
        .from('payment_history')
        .insert({
          user_id: authority.userId,
          stripe_invoice_id: invoice.id,
          amount: invoice.amount_due,
          currency: invoice.currency,
          status: 'failed',
          created_at: new Date(event.created * 1000).toISOString(),
        })
      if (historyErr) {
        logger.error('Failed to record payment failure', { error: historyErr })
        throw new Error(`Failed to record payment failure: ${historyErr.message}`)
      }
    }

    const willRetry = !!invoice.next_payment_attempt
    sendNotification(
      getSupabase(),
      {
        user_id: profile.id,
        type: 'subscription_expiring',
        title: willRetry ? 'Payment failed — please update your card' : 'Pro payment failed',
        message: willRetry
          ? 'We could not charge your card. We will retry automatically over the next few days — update your payment method in Settings to keep your Pro access.'
          : 'Your Pro payment failed and retries are exhausted. Update your payment method in Settings to restore Pro.',
        reference_id: `payment_failed_${invoice.id}`,
      },
      'stripe-payment-failed',
      { deduplicate: true, dedupWindowSeconds: 604800 }
    )

    logger.info(`Exact payment failure recorded for user ${profile.id}`, {
      invoiceId: invoice.id,
      subscriptionId,
      eventId: event.id,
    })
  } catch (error) {
    await recordFailedInvoiceReview({
      invoice,
      event,
      reasonKey:
        error instanceof StripeAuthorityError
          ? `failed_invoice_authority_${error.code}`
          : 'failed_invoice_authority_conflict',
      reason: error instanceof Error ? error.message : 'Failed Invoice authority is uncertain.',
      userId: identity.userId,
      context:
        error instanceof StripeAuthorityError
          ? { authority_error: error.toReviewPayload() }
          : { error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}

export async function handlePaymentActionRequired(invoice: Stripe.Invoice) {
  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || ''
  if (!customerId) {
    logger.warn('Payment action required but invoice has no customer', { invoiceId: invoice.id })
    return
  }

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()
  if (!profile) {
    logger.warn('Payment action required but no user found', { customerId, invoiceId: invoice.id })
    return
  }

  await deliverNotification(
    getSupabase(),
    {
      user_id: profile.id,
      type: 'subscription_expiring',
      title: 'Payment verification required',
      message:
        'Your bank requires an extra verification step. Open Settings and complete payment verification to keep your Pro access.',
      reference_id: `payment_action_required_${invoice.id}`,
    },
    { deduplicate: true, dedupWindowSeconds: 604800 }
  )
  logger.info('Payment action required notification sent', {
    userId: profile.id,
    invoiceId: invoice.id,
  })
}

export async function handleInvoiceFinalizationFailed(invoice: Stripe.Invoice) {
  const failureReason = invoice.last_finalization_error?.message || 'Unknown finalization error'
  logger.error('Stripe invoice finalization failed', {
    invoiceId: invoice.id,
    reason: failureReason,
  })
  const { sendRateLimitedAlert } = await import('@/lib/alerts/send-alert')
  await sendRateLimitedAlert(
    {
      title: 'Stripe invoice finalization failed',
      message: `Invoice could not be finalized: ${failureReason}`,
      level: 'critical',
      details: { invoiceId: invoice.id },
    },
    `stripe:invoice-finalization:${invoice.id}`,
    6 * 60 * 60 * 1000
  )
}
