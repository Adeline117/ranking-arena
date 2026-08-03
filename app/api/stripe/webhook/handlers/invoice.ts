import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { getSupabase, logger, type StripeWebhookEventContext } from './shared'
import { sendNotification } from '@/lib/data/notifications'
import { getApiPlanFromPriceId, getProPlanFromPriceId } from './stripe-price-identity'
import {
  applyExactRecurringInvoiceFailure,
  applyExactRecurringInvoicePayment,
  recordRecurringAuthorityReview,
} from '@/lib/stripe/recurring-entitlement'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  resolveExactRecurringInvoicePriceId,
  StripeAuthorityError,
} from '@/lib/stripe/entitlement-authority'
import { applyExactApiTierInvoicePayment } from './api-tier-payment'

export type StripePaidInvoiceEventContext = StripeWebhookEventContext & {
  type: 'invoice.paid' | 'invoice.payment_succeeded'
}

function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const subscriptionData = invoice.parent?.subscription_details?.subscription
  return typeof subscriptionData === 'string' ? subscriptionData : subscriptionData?.id || null
}

type RecurringInvoiceProductClassification = 'api_tier' | 'b2c_pro' | 'manual_review'

async function classifyRecurringInvoiceProduct(
  invoice: Stripe.Invoice,
  event: StripeWebhookEventContext
): Promise<RecurringInvoiceProductClassification> {
  const subscriptionId = subscriptionIdFromInvoice(invoice)
  if (!subscriptionId) return 'b2c_pro'
  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null
  if (
    !customerId ||
    invoice.livemode !== event.livemode ||
    !Number.isSafeInteger(invoice.created) ||
    invoice.created <= 0 ||
    invoice.created > event.created
  ) {
    return 'b2c_pro'
  }
  try {
    // Classify the immutable historical Invoice, not the Subscription's
    // mutable current metadata/item. The helper walks every line page and
    // rejects hidden/proration/extra lines before an API Price can win.
    const priceId = await resolveExactRecurringInvoicePriceId(stripe, invoice, event.livemode)
    const { data, error } = await getSupabaseAdmin().rpc(
      'classify_recurring_invoice_product_authority_atomic',
      {
        p_livemode: event.livemode,
        p_event_id: event.id,
        p_invoice_id: invoice.id,
        p_stripe_customer_id: customerId,
        p_stripe_subscription_id: subscriptionId,
        p_stripe_price_id: priceId,
      }
    )
    if (error) {
      throw new Error(`Recurring Invoice product classification failed: ${error.message}`)
    }
    if (
      !data ||
      Array.isArray(data) ||
      typeof data !== 'object' ||
      typeof data.status !== 'string' ||
      Object.keys(data).length !== 1
    ) {
      throw new Error('Recurring Invoice product classification returned an invalid result')
    }
    if (data.status === 'api_tier' || data.status === 'b2c_pro') return data.status
    if (data.status === 'manual_review') return 'manual_review'
    if (data.status !== 'not_found') {
      throw new Error(`Recurring Invoice product classification returned ${data.status}`)
    }
    const apiMatch = getApiPlanFromPriceId(priceId) !== null
    const proPlan = getProPlanFromPriceId(priceId)
    const b2cMatch = proPlan === 'monthly' || proPlan === 'yearly'
    if (apiMatch !== b2cMatch) return apiMatch ? 'api_tier' : 'b2c_pro'

    await recordRecurringAuthorityReview({
      supabase: getSupabaseAdmin(),
      objectType: 'invoice',
      objectId: invoice.id,
      event,
      error: new StripeAuthorityError({
        code: apiMatch ? 'ambiguous_product' : 'unsupported_product',
        stage: 'product',
        message: apiMatch
          ? 'Current API and B2C configuration both claim one recurring Price.'
          : 'No durable or current product authority claims this recurring Price.',
        objectIds: { invoiceId: invoice.id, subscriptionId },
        details: { priceId, apiMatch, b2cMatch },
      }),
    })
    return 'manual_review'
  } catch (error) {
    // Ordinary B2C authority persists the exact failure as a durable review.
    // Returning false here avoids a classifier-only retry loop and never
    // silently delegates an ambiguous Invoice to the API writer.
    if (error instanceof StripeAuthorityError) return 'b2c_pro'
    throw error
  }
}

export async function handlePaymentSucceeded(
  invoice: Stripe.Invoice,
  event: StripePaidInvoiceEventContext
) {
  const product = await classifyRecurringInvoiceProduct(invoice, event)
  if (product === 'manual_review') {
    logger.warn('Recurring Invoice product authority conflict was durably queued for review', {
      invoiceId: invoice.id,
      subscriptionId: subscriptionIdFromInvoice(invoice),
      eventId: event.id,
    })
    return
  }
  if (product === 'api_tier') {
    const outcome = await applyExactApiTierInvoicePayment({
      stripe,
      supabase: getSupabaseAdmin(),
      invoice,
      event,
    })
    logger.info('API tier paid invoice reached durable payment authority', {
      invoiceId: invoice.id,
      subscriptionId: subscriptionIdFromInvoice(invoice),
      eventId: event.id,
      status: outcome.status,
      reviewCode: outcome.reviewCode,
    })
    return
  }

  const outcome = await applyExactRecurringInvoicePayment({
    stripe,
    supabase: getSupabaseAdmin(),
    invoice,
    event,
    eventType: event.type,
  })
  logger.info('Ordinary B2C Pro paid invoice reached durable authority', {
    invoiceId: invoice.id,
    eventId: event.id,
    status: outcome.status,
    reviewCode: outcome.reviewCode,
  })
}

export async function handlePaymentFailed(
  invoice: Stripe.Invoice,
  event: StripeWebhookEventContext
) {
  const product = await classifyRecurringInvoiceProduct(invoice, event)
  if (product === 'manual_review') {
    logger.warn('Recurring Invoice product authority conflict was durably queued for review', {
      invoiceId: invoice.id,
      subscriptionId: subscriptionIdFromInvoice(invoice),
      eventId: event.id,
    })
    return
  }
  if (product === 'api_tier') {
    logger.info('API tier payment failure left to API subscription authority', {
      invoiceId: invoice.id,
      subscriptionId: subscriptionIdFromInvoice(invoice),
    })
    return
  }

  const outcome = await applyExactRecurringInvoiceFailure({
    stripe,
    supabase: getSupabaseAdmin(),
    invoice,
    event,
  })
  const authority = outcome.authority
  if (authority?.kind === 'recurring_invoice_failure') {
    const willRetry = authority.nextPaymentAttempt !== null
    sendNotification(
      getSupabase(),
      {
        user_id: authority.userId,
        type: 'subscription_expiring',
        title: willRetry ? 'Payment failed — please update your card' : 'Pro payment failed',
        message: willRetry
          ? 'We could not charge your card. We will retry automatically — update your payment method in Settings to keep your Pro access.'
          : 'Your Pro payment failed. Update your payment method in Settings to restore Pro.',
        reference_id: `payment_failed_${invoice.id}`,
      },
      'stripe-payment-failed'
    )
  }
  logger.info('Ordinary B2C Pro failed invoice recorded without entitlement mutation', {
    invoiceId: invoice.id,
    eventId: event.id,
    status: outcome.status,
    reviewCode: outcome.reviewCode,
  })
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
