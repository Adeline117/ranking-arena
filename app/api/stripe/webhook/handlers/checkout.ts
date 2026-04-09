import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { joinProOfficialGroup } from '@/app/api/pro-official-group/route'
import { getSupabase, withRetry, logger } from './shared'
import { updateUserSubscription } from './subscription'
import { mintNFTForUser } from './nft'
import { sendAlert } from '@/lib/alerts/send-alert'
import { fireAndForget } from '@/lib/utils/logger'

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

  // Lifetime (one-time payment) vs subscription checkout
  if (session.mode === 'payment' && plan === 'lifetime') {
    await handleLifetimePayment(userId, customerId)
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

    // Celebrate every new paying subscriber on Telegram. Fire-and-forget so
    // this can never break the checkout flow. Retro 2026-04-09: CEO review
    // flagged that the first paying signal was invisible — this is the fix.
    fireAndForget(
      sendAlert({
        title: '🎉 New paying subscriber',
        message: `Plan: ${plan || 'monthly'} · Subscription: ${subscriptionId}`,
        level: 'info',
        details: {
          userId,
          plan: plan || 'monthly',
          subscriptionId,
          status: subscription.status,
        },
      }),
      'stripe-new-subscriber-alert',
    )
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

async function handleLifetimePayment(userId: string, customerId: string) {
  logger.info('Processing lifetime payment', { userId, customerId })

  await withRetry(async () => {
    // Update subscriptions table
    const { error: subError } = await getSupabase()
      .from('subscriptions')
      .upsert({
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: `lifetime_${userId}`,
        status: 'active',
        tier: 'pro',
        plan: 'lifetime',
        current_period_start: new Date().toISOString(),
        current_period_end: null,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id',
      })

    if (subError) {
      throw new Error(`Failed to upsert subscription: ${subError.message}`)
    }

    // Update user_profiles
    const { error: profileError } = await getSupabase()
      .from('user_profiles')
      .update({
        subscription_tier: 'pro',
        pro_plan: 'lifetime',
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)

    if (profileError) {
      throw new Error(`Failed to update user_profiles: ${profileError.message}`)
    }
  })

  // Join Pro official group
  try {
    const joinResult = await joinProOfficialGroup(userId)
    if (joinResult.success) {
      logger.info(`Lifetime user ${userId} joined Pro official group`)
    }
  } catch (joinError) {
    logger.error('Error joining Pro official group for lifetime user', { error: joinError })
  }

  await mintNFTForUser(userId, 'lifetime')

  logger.info(`Lifetime payment processed for user ${userId}`)

  // Celebrate the lifetime purchase on Telegram (same rationale as above).
  fireAndForget(
    sendAlert({
      title: '🎉 New lifetime subscriber',
      message: `User ${userId} bought a lifetime plan`,
      level: 'info',
      details: { userId, customerId, plan: 'lifetime' },
    }),
    'stripe-new-lifetime-alert',
  )
}
