/**
 * 群组订阅 API
 * 处理付费群组的订阅操作
 */

import { NextRequest } from 'next/server'
import Stripe from 'stripe'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  error,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET - 获取用户在指定群组的订阅状态
 */
export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    const groupId = searchParams.get('group_id')

    if (!groupId) {
      return error('group_id is required', 400)
    }

    // 获取订阅信息
    const { data: subscription, error: subError } = await supabase
      .from('group_subscriptions')
      .select('id, tier, status, expires_at, price_paid')
      .eq('user_id', user.id)
      .eq('group_id', groupId)
      .in('status', ['active', 'trialing'])
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (subError) {
      logger.error('[group-subscribe] Error fetching subscription:', subError)
      return error('Failed to fetch subscription', 500)
    }

    // 获取群组信息
    const { data: group, error: groupError } = await supabase
      .from('groups')
      .select('id, name, is_premium_only, subscription_price_monthly, subscription_price_yearly, original_price_monthly, original_price_yearly, allow_trial, trial_days')
      .eq('id', groupId)
      .single()

    if (groupError || !group) {
      return error('Group not found', 404)
    }

    return success({
      group: {
        id: group.id,
        name: group.name,
        is_premium_only: group.is_premium_only,
        price_monthly: group.subscription_price_monthly,
        price_yearly: group.subscription_price_yearly,
        original_price_monthly: group.original_price_monthly,
        original_price_yearly: group.original_price_yearly,
        allow_trial: group.allow_trial,
        trial_days: group.trial_days,
      },
      subscription: subscription ? {
        id: subscription.id,
        tier: subscription.tier,
        status: subscription.status,
        expires_at: subscription.expires_at,
        price_paid: subscription.price_paid,
      } : null,
      is_subscribed: !!subscription,
    })
  } catch (e: unknown) {
    return handleError(e)
  }
}

/**
 * POST - 创建群组订阅
 */
export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    const groupId = validateString(body.group_id, { required: true, fieldName: 'group_id' })
    const tier = validateString(body.tier, { required: true, fieldName: 'tier' }) as 'monthly' | 'yearly' | 'trial'
    const paymentReference = body.payment_reference || null
    const paymentProvider = body.payment_provider || null

    // 验证订阅类型
    if (!['monthly', 'yearly', 'trial'].includes(tier)) {
      return error('Invalid tier. Must be monthly, yearly, or trial', 400)
    }

    // 获取群组信息
    const { data: group, error: groupError } = await supabase
      .from('groups')
      .select('id, is_premium_only, subscription_price_monthly, subscription_price_yearly, allow_trial, trial_days')
      .eq('id', groupId)
      .single()

    if (groupError || !group) {
      return error('Group not found', 404)
    }

    // Paid tiers require a verified Stripe payment — trial is free and allowed without payment
    if (tier !== 'trial') {
      const stripeSecret = process.env.STRIPE_SECRET_KEY
      if (!stripeSecret) {
        // Stripe not configured: lock down paid subscriptions entirely
        logger.error('[group-subscribe] STRIPE_SECRET_KEY not set; refusing paid subscription')
        return error('Paid subscriptions are not available at this time', 503)
      }

      const checkoutSessionId: string | undefined = body.checkout_session_id
      const paymentIntentId: string | undefined = body.payment_intent_id

      if (!checkoutSessionId && !paymentIntentId) {
        return error(
          'A valid checkout_session_id or payment_intent_id is required for paid subscriptions',
          400
        )
      }

      const stripe = new Stripe(stripeSecret, { apiVersion: '2026-02-25.clover' })

      try {
        if (checkoutSessionId) {
          const session = await stripe.checkout.sessions.retrieve(checkoutSessionId)
          if (session.payment_status !== 'paid') {
            return error('Payment not completed. Please complete payment before subscribing.', 402)
          }
          // Ensure the session belongs to this user (metadata or client_reference_id)
          const sessionUserId = session.client_reference_id || session.metadata?.user_id
          if (sessionUserId && sessionUserId !== user.id) {
            return error('Payment session does not belong to this user', 403)
          }
          // Ensure the session is for the correct group
          const sessionGroupId = session.metadata?.group_id
          if (sessionGroupId && sessionGroupId !== groupId) {
            return error('Payment session is for a different group', 400)
          }
        } else if (paymentIntentId) {
          const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
          if (intent.status !== 'succeeded') {
            return error('Payment not completed. Please complete payment before subscribing.', 402)
          }
          const intentUserId = intent.metadata?.user_id
          if (intentUserId && intentUserId !== user.id) {
            return error('Payment intent does not belong to this user', 403)
          }
          const intentGroupId = intent.metadata?.group_id
          if (intentGroupId && intentGroupId !== groupId) {
            return error('Payment intent is for a different group', 400)
          }
        }
      } catch (stripeError: unknown) {
        logger.error('[group-subscribe] Stripe verification failed:', stripeError)
        return error('Failed to verify payment. Please try again.', 402)
      }
    }

    // 检查是否已有有效订阅
    const { data: existingSubscription } = await supabase
      .from('group_subscriptions')
      .select('id, status, expires_at')
      .eq('user_id', user.id)
      .eq('group_id', groupId)
      .in('status', ['active', 'trialing'])
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (existingSubscription) {
      return error('You already have an active subscription to this group', 400)
    }

    // 计算价格和过期时间
    let pricePaid = 0
    let expiresAt: Date
    const now = new Date()

    switch (tier) {
      case 'monthly':
        pricePaid = group.subscription_price_monthly || 9.9
        expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) // 30 days
        break
      case 'yearly':
        pricePaid = group.subscription_price_yearly || 99.9
        expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) // 365 days
        break
      case 'trial':
        if (!group.allow_trial) {
          return error('This group does not allow trial subscriptions', 400)
        }
        // 检查是否已经使用过试用
        const { data: pastTrial } = await supabase
          .from('group_subscriptions')
          .select('id')
          .eq('user_id', user.id)
          .eq('group_id', groupId)
          .eq('tier', 'trial')
          .maybeSingle()

        if (pastTrial) {
          return error('You have already used your trial for this group', 400)
        }
        pricePaid = 0
        expiresAt = new Date(now.getTime() + (group.trial_days || 7) * 24 * 60 * 60 * 1000)
        break
      default:
        return error('Invalid tier', 400)
    }

    // 创建订阅
    const { data: subscription, error: subError } = await supabase
      .from('group_subscriptions')
      .insert({
        group_id: groupId,
        user_id: user.id,
        tier,
        status: tier === 'trial' ? 'trialing' : 'active',
        price_paid: pricePaid,
        starts_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        payment_provider: paymentProvider,
        payment_reference: paymentReference,
      })
      .select()
      .single()

    if (subError) {
      logger.error('[group-subscribe] Error creating subscription:', subError)
      return error('Failed to create subscription', 500)
    }

    // 自动加入群组成员（如果还不是）
    const { error: memberError } = await supabase
      .from('group_members')
      .upsert(
        {
          group_id: groupId,
          user_id: user.id,
          role: 'member',
        },
        { onConflict: 'group_id,user_id' }
      )

    if (memberError) {
      logger.warn('[group-subscribe] Error adding member:', memberError)
      // 不阻止订阅成功
    }

    return success({
      subscription: {
        id: subscription.id,
        tier: subscription.tier,
        status: subscription.status,
        expires_at: subscription.expires_at,
        price_paid: subscription.price_paid,
      },
      message: tier === 'trial' ? 'Trial started!' : 'Subscription successful!',
    }, 201)
  } catch (e: unknown) {
    return handleError(e)
  }
}

/**
 * DELETE - 取消群组订阅
 */
export async function DELETE(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    const subscriptionId = validateString(searchParams.get('id'), { required: true, fieldName: 'id' })

    // 获取订阅并验证所有权
    const { data: subscription, error: fetchError } = await supabase
      .from('group_subscriptions')
      .select('id, user_id, status')
      .eq('id', subscriptionId)
      .single()

    if (fetchError || !subscription) {
      return error('Subscription not found', 404)
    }

    if (subscription.user_id !== user.id) {
      return error('You can only cancel your own subscriptions', 403)
    }

    if (subscription.status === 'cancelled') {
      return error('Subscription is already cancelled', 400)
    }

    // 更新为已取消（保留到期日，用户可以继续使用直到过期）
    const { error: updateError } = await supabase
      .from('group_subscriptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', subscriptionId)

    if (updateError) {
      logger.error('[group-subscribe] Error cancelling subscription:', updateError)
      return error('Failed to cancel subscription', 500)
    }

    return success({ message: 'Subscription cancelled. You can continue using until the end of the current period.' })
  } catch (e: unknown) {
    return handleError(e)
  }
}
