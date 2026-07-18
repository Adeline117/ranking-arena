import Stripe from 'stripe'
import { stripe, API_TIER_LIMITS } from '@/lib/stripe'
import { joinProOfficialGroup } from '@/app/api/pro-official-group/route'
import { getSupabase, withRetry, logger } from './shared'
import { getProPlanFromPriceId, updateUserSubscription } from './subscription'
import { mintNFTForUser } from './nft'
import { sendAlert } from '@/lib/alerts/send-alert'
import { fireAndForget } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'

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
    throw new Error(`Checkout ${session.id} cannot be mapped to a user`)
  }

  // API tier subscription checkout
  if (session.metadata?.type === 'api_tier') {
    const apiPlan = session.metadata.api_plan
    if (!apiPlan || !['starter', 'pro'].includes(apiPlan)) {
      logger.error('Invalid api_plan in metadata', { metadata: session.metadata })
      throw new Error(`Checkout ${session.id} has invalid API plan metadata`)
    }
    const subscriptionId = session.subscription as string
    if (!subscriptionId || session.payment_status !== 'paid') {
      logger.warn('API checkout completed without a paid subscription', {
        sessionId: session.id,
        subscriptionId,
        paymentStatus: session.payment_status,
      })
      return
    }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    if (subscription.status !== 'active') {
      logger.warn('API checkout subscription is not active', {
        subscriptionId,
        status: subscription.status,
      })
      return
    }
    await handleApiTierActivation(userId, apiPlan, subscriptionId)
    return
  }

  // Lifetime (one-time payment) vs subscription checkout
  if (session.mode === 'payment' && plan === 'lifetime') {
    if (session.payment_status !== 'paid') {
      logger.warn('Lifetime checkout completed without payment', {
        sessionId: session.id,
        paymentStatus: session.payment_status,
      })
      return
    }
    await handleLifetimePayment(userId, customerId)
    return
  }

  if (session.mode !== 'subscription') {
    logger.warn(`Session ${session.id} is not a subscription`, { mode: session.mode })
    if (session.payment_status === 'paid') {
      throw new Error(`Paid checkout ${session.id} has no supported product mapping`)
    }
    return
  }

  const subscriptionId = session.subscription as string
  if (!subscriptionId) {
    logger.error('No subscription ID in checkout session')
    throw new Error(`Checkout ${session.id} is missing its subscription ID`)
  }

  // If user already has an active subscription with a DIFFERENT stripe_subscription_id,
  // cancel the new one automatically to prevent double billing
  const { data: existingSub, error: existingSubError } = await getSupabase()
    .from('subscriptions')
    .select('stripe_subscription_id, status')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .maybeSingle()

  if (existingSubError) {
    throw new Error(`Failed to check existing subscription: ${existingSubError.message}`)
  }

  if (
    existingSub?.stripe_subscription_id &&
    existingSub.stripe_subscription_id !== subscriptionId
  ) {
    // Cancel the NEW subscription to keep the existing one
    await stripe.subscriptions.cancel(subscriptionId)
    logger.warn('Duplicate subscription detected and cancelled', {
      userId,
      existing: existingSub.stripe_subscription_id,
      cancelled: subscriptionId,
    })
    return // Don't update DB with the cancelled subscription
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)

    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      logger.warn(`Subscription ${subscriptionId} is not active`, { status: subscription.status })
      return
    }

    const priceId = subscription.items.data[0]?.price.id
    const authoritativePlan = getProPlanFromPriceId(priceId)
    if (!authoritativePlan || authoritativePlan === 'lifetime') {
      throw new Error(`Cannot map Stripe price ${priceId || 'missing'} to a subscription plan`)
    }
    if (plan && plan !== authoritativePlan) {
      throw new Error(
        `Checkout plan metadata ${plan} does not match Stripe price plan ${authoritativePlan}`
      )
    }

    await updateUserSubscription(userId, subscription, authoritativePlan)

    try {
      const joinResult = await joinProOfficialGroup(userId)
      if (joinResult.success) {
        logger.info(`User ${userId} joined Pro official group`, { groupId: joinResult.groupId })
      } else {
        throw new Error(`Failed to join Pro official group: ${joinResult.message}`)
      }
    } catch (joinError) {
      logger.error('Error joining Pro official group', { error: joinError })
      throw joinError
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
      'stripe-new-subscriber-alert'
    )
  } catch (err: unknown) {
    logger.error('Failed to process checkout completion', { error: err })
    // Never convert a technical failure into Pro access. Re-throw so the
    // route marks this event failed and Stripe can retry the authoritative
    // subscription lookup and atomic DB update.
    throw err
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
    throw new Error(`Paid tip checkout ${session.id} is missing tip_id`)
  }

  logger.info('Tip payment completed', {
    tipId,
    postId,
    fromUserId,
    toUserId,
    amountCents,
    sessionId: session.id,
  })

  const { data: updatedTip, error: updateError } = await getSupabase()
    .from('tips')
    .update({
      status: 'completed',
      stripe_payment_intent_id: paymentIntentId,
      completed_at: new Date().toISOString(),
    })
    .eq('id', tipId)
    .select('id')
    .maybeSingle()

  if (updateError) {
    logger.error('Failed to update tip status', { tipId, error: updateError.message })
    throw new Error(`Failed to mark tip completed: ${updateError.message}`)
  }
  if (!updatedTip) {
    throw new Error(`Failed to mark tip completed: tip ${tipId} was not found`)
  }

  if (toUserId && fromUserId && postId) {
    const { data: fromProfile } = await getSupabase()
      .from('user_profiles')
      .select('handle')
      .eq('id', fromUserId)
      .single()

    sendNotification(
      getSupabase(),
      {
        user_id: toUserId,
        type: 'tip_received',
        title: '收到打赏',
        message: `${fromProfile?.handle || '用户'} 给你的帖子打赏了 $${(Number(amountCents) / 100).toFixed(2)}`,
        actor_id: fromUserId,
        link: `/post/${postId}`,
        reference_id: tipId,
      },
      'stripe-tip'
    )
  }

  logger.info('Tip recorded successfully', { tipId, amountCents })
}

export async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId || session.metadata?.supabase_user_id
  const plan = session.metadata?.plan

  logger.warn('Checkout session expired (abandoned)', {
    userId,
    plan,
    sessionId: session.id,
    customerEmail: session.customer_details?.email,
    amountTotal: session.amount_total,
  })

  // Record abandonment for funnel analysis
  if (userId) {
    const supabase = getSupabase()
    await supabase
      .from('payment_history')
      .insert({
        user_id: userId,
        status: 'abandoned',
        amount: session.amount_total ?? 0,
        currency: session.currency ?? 'usd',
      })
      .then(({ error }) => {
        if (error) logger.warn('Failed to record checkout abandonment', { error: error.message })
      })
  }

  // Alert team about abandoned checkout
  fireAndForget(
    sendAlert({
      title: '⚠️ Checkout abandoned',
      message: `Plan: ${plan || 'unknown'} · User: ${userId || 'anonymous'} · Amount: $${((session.amount_total ?? 0) / 100).toFixed(2)}`,
      level: 'warning',
      details: {
        userId,
        plan: plan || 'unknown',
        sessionId: session.id,
        email: session.customer_details?.email,
      },
    }),
    'stripe-checkout-abandoned-alert'
  )
}

async function handleLifetimePayment(userId: string, customerId: string) {
  logger.info('Processing lifetime payment', { userId, customerId })

  await withRetry(async () => {
    const { error } = await getSupabase().rpc('activate_lifetime_membership', {
      p_user_id: userId,
      p_stripe_customer_id: customerId,
    })
    if (error) throw new Error(`Failed to activate lifetime membership: ${error.message}`)
  })

  // Join Pro official group
  try {
    const joinResult = await joinProOfficialGroup(userId)
    if (joinResult.success) {
      logger.info(`Lifetime user ${userId} joined Pro official group`)
    } else {
      throw new Error(`Failed to join Pro official group: ${joinResult.message}`)
    }
  } catch (joinError) {
    logger.error('Error joining Pro official group for lifetime user', { error: joinError })
    throw joinError
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
    'stripe-new-lifetime-alert'
  )
}

export async function handleApiTierActivation(
  userId: string,
  apiPlan: string,
  stripeSubscriptionId: string
) {
  const dailyLimit = API_TIER_LIMITS[apiPlan] ?? 100

  logger.info('Activating API tier', { userId, apiPlan, dailyLimit, stripeSubscriptionId })

  await withRetry(async () => {
    const { error } = await getSupabase().rpc('update_user_api_tier', {
      p_user_id: userId,
      p_api_tier: apiPlan,
      p_stripe_subscription_id: stripeSubscriptionId,
      p_daily_limit: dailyLimit,
    })

    if (error) {
      throw new Error(`Failed to update API tier: ${error.message}`)
    }
  })

  logger.info(`API tier activated for user ${userId}`, { apiPlan })

  fireAndForget(
    sendAlert({
      title: '🎉 New API subscriber',
      message: `Plan: ${apiPlan} · User: ${userId}`,
      level: 'info',
      details: { userId, apiPlan, stripeSubscriptionId },
    }),
    'stripe-new-api-subscriber-alert'
  )
}
