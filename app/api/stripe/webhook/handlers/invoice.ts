import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { getSupabase, logger } from './shared'
import { sendNotification } from '@/lib/data/notifications'

export async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  const subscriptionData = invoice.parent?.subscription_details?.subscription
  const subscriptionId =
    typeof subscriptionData === 'string' ? subscriptionData : subscriptionData?.id || null

  if (!subscriptionId) return

  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || ''

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id, subscription_tier')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) return

  // Upsert payment record (handles webhook retries)
  const { error: historyErr } = await getSupabase().from('payment_history').upsert(
    {
      user_id: profile.id,
      stripe_invoice_id: invoice.id,
      stripe_payment_intent_id: null,
      amount: invoice.amount_paid,
      currency: invoice.currency,
      status: 'succeeded',
      created_at: new Date().toISOString(),
    },
    { onConflict: 'stripe_invoice_id' }
  )
  if (historyErr)
    logger.error('Failed to record payment', { error: historyErr, invoiceId: invoice.id })
  else logger.info(`Payment succeeded for user ${profile.id}`, { amount: invoice.amount_paid })

  // S-1 FIX: Restore Pro tier if the subscription is now active.
  // After a past_due → active recovery, customer.subscription.updated may be
  // delayed or lost. This ensures the user gets Pro access back immediately
  // on successful payment, without relying solely on that event.
  if (subscription.status === 'active' && profile.subscription_tier !== 'pro') {
    const { error: restoreErr } = await getSupabase()
      .from('user_profiles')
      .update({ subscription_tier: 'pro', updated_at: new Date().toISOString() })
      .eq('id', profile.id)
    if (restoreErr) {
      logger.error('Failed to restore Pro tier after payment', {
        error: restoreErr.message,
        userId: profile.id,
      })
    } else {
      logger.info(`Restored Pro tier for user ${profile.id} after successful payment`)
    }

    // Also ensure subscriptions table reflects active status
    await getSupabase()
      .from('subscriptions')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('user_id', profile.id)
      .eq('stripe_subscription_id', subscriptionId)
  }
}

export async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id, subscription_tier')
    .eq('stripe_customer_id', customerId)
    .single()

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
  if (historyErr) logger.error('Failed to record payment failure', { error: historyErr })

  const subscriptionData = invoice.parent?.subscription_details?.subscription
  const subscriptionId =
    typeof subscriptionData === 'string' ? subscriptionData : subscriptionData?.id || null
  if (subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      if (subscription.status === 'past_due') {
        // 2026-07-11:只标 past_due,不再立即降级。此前首次扣款失败即
        // profile→free,而 Stripe smart-retries 常在几天内恢复(handlePaymentSucceeded
        // 会复权),期间用户无解释失去 Pro、也不知该换卡。真正的降级由
        // handleSubscriptionCanceled 在 Stripe 耗尽重试真取消时执行。这里给宽限期 +
        // 通知用户更新支付方式。
        await getSupabase()
          .from('subscriptions')
          .update({
            status: 'past_due',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscriptionId)

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
    }
  }

  logger.info(`Payment failed for user ${profile.id}`, { invoiceId: invoice.id })
}
