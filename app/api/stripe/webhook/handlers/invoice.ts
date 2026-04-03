import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { getSupabase, logger } from './shared'

export async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  const subscriptionData = invoice.parent?.subscription_details?.subscription
  const subscriptionId = typeof subscriptionData === 'string'
    ? subscriptionData
    : subscriptionData?.id || null

  if (!subscriptionId) return

  const _subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || ''

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) return

  // Upsert payment record (handles webhook retries)
  const { error: historyErr } = await getSupabase()
    .from('payment_history')
    .upsert({
      user_id: profile.id,
      stripe_invoice_id: invoice.id,
      stripe_payment_intent_id: null,
      amount: invoice.amount_paid,
      currency: invoice.currency,
      status: 'succeeded',
      created_at: new Date().toISOString(),
    }, { onConflict: 'stripe_invoice_id' })
  if (historyErr) logger.error('Failed to record payment', { error: historyErr, invoiceId: invoice.id })
  else logger.info(`Payment succeeded for user ${profile.id}`, { amount: invoice.amount_paid })
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

  const { error: historyErr } = await getSupabase()
    .from('payment_history')
    .upsert({
      user_id: profile.id,
      stripe_invoice_id: invoice.id,
      amount: invoice.amount_due,
      currency: invoice.currency,
      status: 'failed',
      created_at: new Date().toISOString(),
    }, { onConflict: 'stripe_invoice_id' })
  if (historyErr) logger.error('Failed to record payment failure', { error: historyErr })

  const subscriptionData = invoice.parent?.subscription_details?.subscription
  const subscriptionId = typeof subscriptionData === 'string'
    ? subscriptionData
    : subscriptionData?.id || null
  if (subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      if (subscription.status === 'past_due') {
        await getSupabase()
          .from('subscriptions')
          .update({
            status: 'past_due',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscriptionId)
      }
    } catch (err: unknown) {
      logger.error('Failed to update subscription status on payment failure', { error: err })
    }
  }

  logger.info(`Payment failed for user ${profile.id}`, { invoiceId: invoice.id })
}
