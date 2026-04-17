import Stripe from 'stripe'
import { SUBSCRIPTION_STATUS_MAP } from '@/lib/stripe'
import { env } from '@/lib/env'
import { leaveProOfficialGroup } from '@/app/api/pro-official-group/route'
import { getSupabase, withRetry, logger } from './shared'

export async function handleSubscriptionUpdate(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) {
    logger.error('No user found for customer', { customerId })
    return
  }

  const priceId = subscription.items.data[0]?.price.id
  const lifetimePriceId = process.env.STRIPE_PRO_LIFETIME_PRICE_ID
  const plan = priceId === env.STRIPE_PRO_YEARLY_PRICE_ID ? 'yearly'
    : (lifetimePriceId && priceId === lifetimePriceId) ? 'lifetime'
    : 'monthly'

  await updateUserSubscription(profile.id, subscription, plan)
}

export async function handleSubscriptionCanceled(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) return

  const { error: subError } = await getSupabase()
    .from('subscriptions')
    .update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', profile.id)
    .eq('stripe_subscription_id', subscription.id)

  if (subError) {
    logger.error('Failed to update subscription status to canceled', { userId: profile.id, error: subError.message })
  }

  // Only downgrade if the cancelled subscription actually matched the user's active one
  // AND the user is not a lifetime plan holder
  const { data: currentProfile } = await getSupabase()
    .from('user_profiles')
    .select('pro_plan')
    .eq('id', profile.id)
    .single()
  if (currentProfile?.pro_plan === 'lifetime') {
    logger.info('Skipping downgrade for lifetime user on subscription cancel', { userId: profile.id })
  } else {
    const { error: profileError } = await getSupabase()
      .from('user_profiles')
      .update({
        subscription_tier: 'free',
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile.id)
    if (profileError) {
      logger.error('Failed to downgrade user tier to free', { userId: profile.id, error: profileError.message })
    }
  }

  try {
    const leftGroup = await leaveProOfficialGroup(profile.id)
    if (leftGroup) {
      logger.info(`User ${profile.id} left Pro official group`)
    }
  } catch (leaveError) {
    logger.error('Error leaving Pro official group', { error: leaveError })
  }

  logger.info(`Subscription canceled for user ${profile.id}`)
}

export async function handleTrialWillEnd(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id, email')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) {
    logger.warn('Trial ending but no user found', { customerId })
    return
  }

  try {
    const trialEndDate = subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toLocaleDateString('zh-CN')
      : '即将'

    await getSupabase()
      .from('notifications')
      .insert({
        user_id: profile.id,
        type: 'subscription',
        title: '试用期即将结束',
        body: `您的 Pro 会员试用期将于 ${trialEndDate} 结束。届时将开始正式计费，如需取消请前往设置页面。`,
        data: { subscriptionId: subscription.id },
      })

    logger.info(`Trial ending notification sent to user ${profile.id}`)
  } catch (err: unknown) {
    logger.error('Failed to send trial ending notification', { error: err })
  }
}

export async function updateUserSubscription(
  userId: string,
  subscription: Stripe.Subscription,
  plan: string
) {
  const status = SUBSCRIPTION_STATUS_MAP[subscription.status] || subscription.status
  const sub = subscription as unknown as Record<string, unknown>
  const itemPeriod = subscription.items?.data?.[0] as unknown as Record<string, unknown> | undefined
  const pStart = (sub.current_period_start ?? itemPeriod?.current_period_start) as number | undefined
  const pEnd = (sub.current_period_end ?? itemPeriod?.current_period_end) as number | undefined
  const periodStart = pStart
    ? new Date(pStart * 1000).toISOString()
    : new Date(subscription.start_date * 1000).toISOString()
  const periodEnd = pEnd
    ? new Date(pEnd * 1000).toISOString()
    : null

  logger.info(`updateUserSubscription`, { userId, status, plan, periodStart, periodEnd })

  await withRetry(async () => {
    const { error: rpcError } = await getSupabase().rpc('update_subscription_and_profile', {
      p_user_id: userId,
      p_tier: 'pro',
      p_status: status,
      p_stripe_sub_id: subscription.id,
      p_stripe_customer_id: subscription.customer as string,
      p_plan: plan,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_cancel_at_period_end: subscription.cancel_at_period_end,
    })

    if (rpcError) {
      logger.warn('RPC update_subscription_and_profile failed, using fallback', { error: rpcError.message })

      const { error: subscriptionError } = await getSupabase()
        .from('subscriptions')
        .upsert({
          user_id: userId,
          stripe_subscription_id: subscription.id,
          stripe_customer_id: subscription.customer as string,
          status: status,
          tier: 'pro',
          plan: plan,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: subscription.cancel_at_period_end,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'user_id',
        })

      if (subscriptionError) {
        throw new Error(`Failed to upsert subscriptions: ${subscriptionError.message}`)
      }

      const shouldBePro = status === 'active' || status === 'trialing'
      const { error: profileError } = await getSupabase()
        .from('user_profiles')
        .update({
          subscription_tier: shouldBePro ? 'pro' : 'free',
          stripe_customer_id: subscription.customer as string,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)

      if (profileError) {
        throw new Error(`Failed to update user_profiles: ${profileError.message}`)
      }
    }

    logger.info(`Subscription updated for user ${userId}`, { status, plan })
  })
}
