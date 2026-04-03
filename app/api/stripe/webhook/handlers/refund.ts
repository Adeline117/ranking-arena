import Stripe from 'stripe'
import { leaveProOfficialGroup } from '@/app/api/pro-official-group/route'
import { getSupabase, logger } from './shared'

export async function handleChargeRefunded(charge: Stripe.Charge) {
  const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id
  if (!customerId) {
    logger.warn('Charge refunded without customer ID', { chargeId: charge.id })
    return
  }

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id, subscription_tier')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) {
    logger.warn('Refund processed but no user found', { customerId, chargeId: charge.id })
    return
  }

  try {
    await getSupabase()
      .from('payment_history')
      .insert({
        user_id: profile.id,
        stripe_payment_intent_id: charge.payment_intent as string,
        amount: -(charge.amount_refunded || 0),
        currency: charge.currency,
        status: 'refunded',
        created_at: new Date().toISOString(),
      })
  } catch (err: unknown) {
    logger.error('Failed to record refund', { error: err })
  }

  if (charge.refunded && charge.amount === charge.amount_refunded) {
    const { data: subscription } = await getSupabase()
      .from('subscriptions')
      .select('id, status')
      .eq('user_id', profile.id)
      .eq('status', 'active')
      .single()

    // Cancel active subscription if exists
    if (subscription) {
      await getSupabase()
        .from('subscriptions')
        .update({ status: 'canceled', canceled_at: new Date().toISOString() })
        .eq('id', subscription.id)
      logger.info(`Subscription ${subscription.id} canceled due to full refund`)
    }

    // Downgrade user to free tier
    await getSupabase()
      .from('user_profiles')
      .update({
        subscription_tier: 'free',
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile.id)

    try {
      await leaveProOfficialGroup(profile.id)
    } catch (leaveError) {
      logger.error('Error leaving Pro group after refund', { error: leaveError })
    }

    logger.info(`User ${profile.id} downgraded to free after full refund`)
  }

  logger.info('Charge refunded', { userId: profile.id, chargeId: charge.id, amount: charge.amount_refunded })
}

export async function handleRefundUpdated(refund: Stripe.Refund) {
  logger.info('Refund updated', { refundId: refund.id, status: refund.status })

  if (refund.status === 'failed') {
    logger.warn('Refund failed', { refundId: refund.id, reason: refund.failure_reason })
  }
}
