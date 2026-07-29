import Stripe from 'stripe'
import { getStripe, stripe } from '@/lib/stripe'
import { getSupabase, logger, type StripeWebhookEventContext } from './shared'
import { sendNotification } from '@/lib/data/notifications'
import { carriesApiTierSubscriptionIdentity } from './api-tier-identity'
import { getProPlanFromPriceId } from './stripe-price-identity'
import { StripeAuthorityError } from '@/lib/stripe/entitlement-authority'
import {
  recordApiTierInvoicePayment,
  resolveApiTierInvoicePaymentAuthority,
} from '@/lib/stripe/api-tier-payment'
import { activateRecurringInvoiceEntitlement } from '@/lib/stripe/recurring-entitlement'
import { recordStripeCheckoutManualReview } from '@/lib/stripe/lifetime-entitlement'
import { drainApiTierReversalActions } from '@/lib/stripe/api-tier-reversal-actions'
import type { Json } from '@/lib/supabase/database.types'

export type StripePaidInvoiceEventContext = StripeWebhookEventContext & {
  type: 'invoice.paid' | 'invoice.payment_succeeded'
}

const MAX_STRIPE_UNIX_SECONDS = 253_402_300_799

function exactOrdinaryProInvoiceCustomer(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription
): string {
  const invoiceCustomer =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || ''
  const subscriptionCustomer =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id || ''
  const item = subscription.items.data.length === 1 ? subscription.items.data[0] : null
  const plan = item?.quantity === 1 ? getProPlanFromPriceId(item.price.id) : null
  if (
    !invoiceCustomer ||
    invoiceCustomer !== subscriptionCustomer ||
    !item ||
    item.quantity !== 1 ||
    (plan !== 'monthly' && plan !== 'yearly')
  ) {
    throw new Error(`Invoice ${invoice.id} subscription is not an exact ordinary Pro subscription`)
  }
  return invoiceCustomer
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

  const { error: historyErr } = await getSupabase().from('payment_history').upsert(
    {
      user_id: profile.id,
      stripe_invoice_id: invoice.id,
      stripe_payment_intent_id: authority.paymentIntentId,
      amount: authority.amount,
      currency: authority.currency,
      status: 'succeeded',
      created_at: new Date().toISOString(),
    },
    { onConflict: 'stripe_invoice_id' }
  )
  if (historyErr) {
    logger.error('Failed to record payment', { error: historyErr, invoiceId: invoice.id })
    throw new Error(`Failed to record successful payment: ${historyErr.message}`)
  }
  logger.info('Recurring Pro Invoice payment reached a durable state', {
    userId: profile.id,
    invoiceId: invoice.id,
    amount: authority.amount,
    activationStatus: activation.status,
  })
}

export async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionData = invoice.parent?.subscription_details?.subscription
  const subscriptionId =
    typeof subscriptionData === 'string' ? subscriptionData : subscriptionData?.id || null
  const subscription = subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null

  if (!subscriptionId || !subscription) return

  if (carriesApiTierSubscriptionIdentity(subscription)) {
    // API tier retry/grace/revocation is handled by customer.subscription.*
    // through the atomic API entitlement ledger. Never mutate the Pro tables.
    logger.info('API tier payment failure left to subscription event authority', {
      invoiceId: invoice.id,
      subscriptionId,
    })
    return
  }

  const customerId = exactOrdinaryProInvoiceCustomer(invoice, subscription)

  const { data: profile, error: profileError } = await getSupabase()
    .from('user_profiles')
    .select('id, subscription_tier')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  if (profileError) {
    throw new Error(`Failed to find failed payment owner: ${profileError.message}`)
  }
  if (!profile) {
    logger.warn(`Payment failed but no user found for customer`, { customerId })
    return
  }

  const { error: historyErr } = await getSupabase().from('payment_history').upsert(
    {
      user_id: profile.id,
      stripe_invoice_id: invoice.id,
      amount: invoice.amount_due,
      currency: invoice.currency,
      status: 'failed',
      created_at: new Date().toISOString(),
    },
    { onConflict: 'stripe_invoice_id' }
  )
  if (historyErr) {
    logger.error('Failed to record payment failure', { error: historyErr })
    throw new Error(`Failed to record payment failure: ${historyErr.message}`)
  }

  if (subscriptionId) {
    try {
      if (subscription.status === 'past_due') {
        // 2026-07-11:只标 past_due,不再立即降级。此前首次扣款失败即
        // profile→free,而 Stripe smart-retries 常在几天内恢复(handlePaymentSucceeded
        // 会复权),期间用户无解释失去 Pro、也不知该换卡。真正的降级由
        // handleSubscriptionCanceled 在 Stripe 耗尽重试真取消时执行。这里给宽限期 +
        // 通知用户更新支付方式。
        const { error: statusError } = await getSupabase()
          .from('subscriptions')
          .update({
            status: 'past_due',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscriptionId)
        if (statusError) {
          throw new Error(`Failed to mark subscription past due: ${statusError.message}`)
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
          'stripe-payment-failed'
        )

        logger.info(`Marked past_due (grace, no downgrade) + notified user`, {
          customerId,
          subscriptionId,
          willRetry,
        })
      }
    } catch (err: unknown) {
      logger.error('Failed to update subscription status on payment failure', { error: err })
      throw err
    }
  }

  logger.info(`Payment failed for user ${profile.id}`, { invoiceId: invoice.id })
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

  await sendNotification(
    getSupabase(),
    {
      user_id: profile.id,
      type: 'subscription_expiring',
      title: 'Payment verification required',
      message:
        'Your bank requires an extra verification step. Open Settings and complete payment verification to keep your Pro access.',
      reference_id: `payment_action_required_${invoice.id}`,
    },
    'stripe-payment-action-required'
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
