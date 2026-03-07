import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { joinProOfficialGroup } from '@/app/api/pro-official-group/route'
import { getSupabase, withRetry, logger } from './shared'
import { updateUserSubscription } from './subscription'
import { mintNFTForUser } from './nft'

export async function handleCheckoutComplete(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId || session.metadata?.supabase_user_id
  const plan = session.metadata?.plan
  const customerId = session.customer as string

  logger.info('Checkout completed', {
    userId,
    plan,
    customerId,
    sessionId: session.id,
    paymentStatus: session.payment_status,
    mode: session.mode,
    subscription: session.subscription,
  })

  if (!userId) {
    logger.error('No userId in session metadata', { metadata: session.metadata })
    return
  }

  if (session.payment_status !== 'paid') {
    logger.warn(`Payment not completed for session ${session.id}`, { status: session.payment_status })
    return
  }

  if (session.mode !== 'subscription') {
    logger.warn(`Session ${session.id} is not a subscription`, { mode: session.mode })
    return
  }

  const subscriptionId = session.subscription as string
  if (!subscriptionId) {
    logger.error('No subscription ID in checkout session')
    return
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)

    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      logger.warn(`Subscription ${subscriptionId} is not active`, { status: subscription.status })
      return
    }

    await updateUserSubscription(userId, subscription, plan || 'monthly')

    try {
      const joinResult = await joinProOfficialGroup(userId)
      if (joinResult.success) {
        logger.info(`User ${userId} joined Pro official group`, { groupId: joinResult.groupId })
      } else {
        logger.warn(`Failed to join Pro official group`, { message: joinResult.message })
      }
    } catch (joinError) {
      logger.error('Error joining Pro official group', { error: joinError })
    }

    await mintNFTForUser(userId, plan || 'monthly')

    logger.info(`Checkout completed for user ${userId}`, { plan, subscriptionId })
  } catch (err: unknown) {
    logger.error('Failed to process checkout completion', { error: err })
    await withRetry(async () => {
      const { error: profileError } = await getSupabase()
        .from('user_profiles')
        .upsert({
          id: userId,
          subscription_tier: 'pro',
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'id',
        })

      if (profileError) {
        throw new Error(`Failed to update user_profiles: ${profileError.message}`)
      }
      logger.info(`Fallback: Updated user_profiles for ${userId}`, { tier: 'pro' })
    })
  }
}

export async function handleTipPaymentCompleted(session: Stripe.Checkout.Session) {
  const tipId = session.metadata?.tip_id
  const postId = session.metadata?.post_id
  const fromUserId = session.metadata?.from_user_id
  const toUserId = session.metadata?.to_user_id
  const amountCents = session.metadata?.amount_cents
  const paymentIntentId = session.payment_intent as string

  if (!tipId) {
    logger.warn('Tip payment completed without tip_id', { sessionId: session.id })
    return
  }

  logger.info('Tip payment completed', {
    tipId, postId, fromUserId, toUserId, amountCents, sessionId: session.id,
  })

  const { error: updateError } = await getSupabase()
    .from('tips')
    .update({
      status: 'completed',
      stripe_payment_intent_id: paymentIntentId,
      completed_at: new Date().toISOString(),
    })
    .eq('id', tipId)

  if (updateError) {
    logger.error('Failed to update tip status', { tipId, error: updateError.message })
    return
  }

  if (toUserId && fromUserId && postId) {
    try {
      const { data: fromProfile } = await getSupabase()
        .from('user_profiles')
        .select('handle')
        .eq('id', fromUserId)
        .single()

      await getSupabase()
        .from('notifications')
        .insert({
          user_id: toUserId,
          type: 'tip_received',
          title: '收到打赏',
          body: `${fromProfile?.handle || '用户'} 给你的帖子打赏了 $${(Number(amountCents) / 100).toFixed(2)}`,
          data: { tipId, postId, fromUserId, amount: amountCents },
        })
    } catch (notifError) {
      logger.warn('Failed to send tip notification', { error: notifError })
    }
  }

  logger.info('Tip recorded successfully', { tipId, amountCents })
}
