import Stripe from 'stripe'
import {
  SUBSCRIPTION_STATUS_MAP,
  STRIPE_API_PRICE_IDS,
  API_TIER_LIMITS,
  STRIPE_PRICE_IDS,
} from '@/lib/stripe'
import { env } from '@/lib/env'
import { leaveProOfficialGroup } from '@/app/api/pro-official-group/route'
import { getSupabase, withRetry, logger } from './shared'
import { sendNotification } from '@/lib/data/notifications'

export async function handleSubscriptionUpdate(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string

  const { data: profile, error: profileError } = await getSupabase()
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  if (profileError) {
    throw new Error(`Failed to find subscription owner: ${profileError.message}`)
  }
  if (!profile) {
    logger.warn('Subscription update: no user found for stripe_customer_id', { customerId })
    return
  }

  const priceId = subscription.items.data[0]?.price.id

  // Check if this is an API tier subscription
  const apiPlan = getApiPlanFromPriceId(priceId)
  if (apiPlan) {
    if (subscription.status === 'active' || subscription.status === 'trialing') {
      const dailyLimit = API_TIER_LIMITS[apiPlan] ?? 100
      await withRetry(async () => {
        const { error } = await getSupabase().rpc('update_user_api_tier', {
          p_user_id: profile.id,
          p_api_tier: apiPlan,
          p_stripe_subscription_id: subscription.id,
          p_daily_limit: dailyLimit,
        })
        if (error) throw new Error(`Failed to update API tier: ${error.message}`)
      })
      logger.info(`API tier updated for user ${profile.id}`, {
        apiPlan,
        status: subscription.status,
      })
    }
    return
  }

  // Regular Pro membership subscription — 显式白名单匹配,不再"未知 price 默认
  // monthly"(2026-07-11 审计:此前任何未知/误建/测试 price 都静默授 Pro monthly)。
  const plan = getProPlanFromPriceId(priceId)

  if (!plan) {
    // 未命中任何已知 price → 不授权,critical 告警人工核查(先 observe;确认 env
    // 无遗漏后可改为硬拒)。防误建/测试 price 静默铸造 Pro。
    logger.error('Subscription with UNKNOWN price — not granting Pro', {
      priceId,
      userId: profile.id,
      subscriptionId: subscription.id,
    })
    try {
      const { sendAlert } = await import('@/lib/alerts/send-alert')
      await sendAlert({
        level: 'critical',
        source: 'stripe',
        title: 'Unknown Stripe price — Pro NOT granted',
        message: `订阅 price ${priceId} 不在已知白名单(monthly/yearly/lifetime/api)。已跳过授权,请核查是否漏配 env price ID 或误建 product。`,
        details: { priceId, userId: profile.id, subscriptionId: subscription.id },
      })
    } catch {
      /* alert failure non-fatal */
    }
    throw new Error(`Cannot map Stripe price ${priceId || 'missing'} to a Pro plan`)
  }

  await updateUserSubscription(profile.id, subscription, plan)
}

export async function handleSubscriptionCanceled(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string

  const { data: profile, error: profileLookupError } = await getSupabase()
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  if (profileLookupError) {
    throw new Error(`Failed to find canceled subscription owner: ${profileLookupError.message}`)
  }
  if (!profile) {
    logger.warn('Subscription canceled: no user found for stripe_customer_id', { customerId })
    return
  }

  // Check if this is an API tier subscription cancellation
  const priceId = subscription.items.data[0]?.price.id
  const apiPlan = getApiPlanFromPriceId(priceId)
  if (apiPlan) {
    // Downgrade API tier back to free
    await withRetry(async () => {
      const { error } = await getSupabase().rpc('update_user_api_tier', {
        p_user_id: profile.id,
        p_api_tier: 'free',
        p_stripe_subscription_id: null,
        p_daily_limit: API_TIER_LIMITS.free,
      })
      if (error) throw new Error(`Failed to downgrade API tier: ${error.message}`)
    })
    logger.info(`API tier canceled for user ${profile.id}`, { previousPlan: apiPlan })
    return
  }

  // Regular Pro membership cancellation
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
    logger.error('Failed to update subscription status to canceled', {
      userId: profile.id,
      error: subError.message,
    })
    throw new Error(`Failed to cancel subscription record: ${subError.message}`)
  }

  // P-1 FIX: Only downgrade if the canceled subscription is still the user's
  // current one. If the user re-subscribed (new stripe_subscription_id replaced
  // the old one via upsert), a late-delivered `customer.subscription.deleted`
  // for the old sub must NOT downgrade them.
  const { data: currentSub, error: currentSubError } = await getSupabase()
    .from('subscriptions')
    .select('stripe_subscription_id, status')
    .eq('user_id', profile.id)
    .maybeSingle()

  if (currentSubError) {
    throw new Error(
      `Failed to verify current subscription before downgrade: ${currentSubError.message}`
    )
  }
  let downgradedToFree = false
  if (currentSub && currentSub.stripe_subscription_id !== subscription.id) {
    logger.info('Skipping profile downgrade — user has a newer subscription', {
      userId: profile.id,
      canceledSubId: subscription.id,
      currentSubId: currentSub.stripe_subscription_id,
    })
  } else {
    // Check lifetime plan holder
    const { data: currentProfile, error: currentProfileError } = await getSupabase()
      .from('user_profiles')
      .select('pro_plan')
      .eq('id', profile.id)
      .maybeSingle()
    if (currentProfileError) {
      throw new Error(`Failed to verify lifetime entitlement: ${currentProfileError.message}`)
    }
    if (currentProfile?.pro_plan === 'lifetime') {
      logger.info('Skipping downgrade for lifetime user on subscription cancel', {
        userId: profile.id,
      })
    } else {
      const { error: profileError } = await getSupabase()
        .from('user_profiles')
        .update({
          subscription_tier: 'free',
          updated_at: new Date().toISOString(),
        })
        .eq('id', profile.id)
      if (profileError) {
        logger.error('Failed to downgrade user tier to free', {
          userId: profile.id,
          error: profileError.message,
        })
        throw new Error(`Failed to downgrade user tier: ${profileError.message}`)
      }
      downgradedToFree = true
    }
  }

  if (downgradedToFree) {
    try {
      const leftGroup = await leaveProOfficialGroup(profile.id)
      if (leftGroup) {
        logger.info(`User ${profile.id} left Pro official group`)
      }
    } catch (leaveError) {
      logger.error('Error leaving Pro official group', { error: leaveError })
      throw leaveError
    }
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

  const trialEndDate = subscription.trial_end
    ? new Date(subscription.trial_end * 1000).toLocaleDateString('zh-CN')
    : '即将'

  sendNotification(
    getSupabase(),
    {
      user_id: profile.id,
      type: 'system',
      title: '试用期即将结束',
      message: `您的 Pro 会员试用期将于 ${trialEndDate} 结束。届时将开始正式计费，如需取消请前往设置页面。`,
      reference_id: `trial_ending_${subscription.id}`,
    },
    'stripe-trial-ending'
  )

  logger.info(`Trial ending notification sent to user ${profile.id}`)
}

export async function updateUserSubscription(
  userId: string,
  subscription: Stripe.Subscription,
  plan: string
) {
  const status = SUBSCRIPTION_STATUS_MAP[subscription.status] || subscription.status
  const sub = subscription as unknown as Record<string, unknown>
  const itemPeriod = subscription.items?.data?.[0] as unknown as Record<string, unknown> | undefined
  const pStart = (sub.current_period_start ?? itemPeriod?.current_period_start) as
    | number
    | undefined
  const pEnd = (sub.current_period_end ?? itemPeriod?.current_period_end) as number | undefined
  const periodStart = pStart
    ? new Date(pStart * 1000).toISOString()
    : new Date(subscription.start_date * 1000).toISOString()
  const periodEnd = pEnd ? new Date(pEnd * 1000).toISOString() : null

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
      logger.warn('RPC update_subscription_and_profile failed, using fallback', {
        error: rpcError.message,
      })

      const { error: subscriptionError } = await getSupabase()
        .from('subscriptions')
        .upsert(
          {
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
          },
          {
            onConflict: 'user_id',
          }
        )

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

/**
 * Check if a Stripe price ID belongs to an API tier subscription.
 * Returns the plan name ('starter' | 'pro') or null if not an API tier.
 */
function getApiPlanFromPriceId(priceId: string | undefined): string | null {
  if (!priceId) return null
  if (STRIPE_API_PRICE_IDS.starter && priceId === STRIPE_API_PRICE_IDS.starter) return 'starter'
  if (STRIPE_API_PRICE_IDS.pro && priceId === STRIPE_API_PRICE_IDS.pro) return 'pro'
  return null
}

export function getProPlanFromPriceId(
  priceId: string | undefined
): 'monthly' | 'yearly' | 'lifetime' | null {
  if (priceId === STRIPE_PRICE_IDS.yearly || priceId === env.STRIPE_PRO_YEARLY_PRICE_ID) {
    return 'yearly'
  }
  if (STRIPE_PRICE_IDS.lifetime && priceId === STRIPE_PRICE_IDS.lifetime) {
    return 'lifetime'
  }
  if (STRIPE_PRICE_IDS.monthly && priceId === STRIPE_PRICE_IDS.monthly) {
    return 'monthly'
  }
  return null
}
