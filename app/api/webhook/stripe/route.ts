/**
 * Stripe Webhook 处理
 * 处理订阅创建、更新、取消等事件
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { logger } from '@/lib/utils/logger'
import { joinProOfficialGroup, leaveProOfficialGroup } from '@/app/api/pro-official-group/route'

export const dynamic = 'force-dynamic'

// 禁用 body 解析，因为我们需要原始请求体来验证签名
export const runtime = 'nodejs'

function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  return new Stripe(secretKey, {
    apiVersion: '2025-12-15.clover',
  })
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  
  if (!url || !serviceKey) {
    throw new Error('Supabase credentials not configured')
  }
  
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

// Stripe 订阅状态到我们系统状态的映射
function mapStripeStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
      return 'past_due'
    case 'canceled':
    case 'unpaid':
      return 'cancelled'
    case 'incomplete':
    case 'incomplete_expired':
      return 'expired'
    default:
      return 'expired'
  }
}

// 从价格 ID 获取订阅等级
function getTierFromPriceId(priceId: string): 'free' | 'pro' {
  if (priceId === process.env.STRIPE_PRO_MONTHLY_PRICE_ID || 
      priceId === process.env.STRIPE_PRO_YEARLY_PRICE_ID ||
      priceId === process.env.STRIPE_PRO_PRICE_ID) {
    return 'pro'
  }
  return 'free'
}

export async function POST(request: NextRequest) {
  const log = logger.withContext({ handler: 'stripe-webhook' })

  try {
    const stripe = getStripe()
    const supabase = getSupabase()

    // 获取原始请求体
    const body = await request.text()
    const signature = request.headers.get('stripe-signature')

    if (!signature) {
      log.warn('Missing Stripe signature')
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    if (!webhookSecret) {
      log.error('Webhook secret not configured', new Error('STRIPE_WEBHOOK_SECRET not set'))
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
    }

    // 验证 webhook 签名
    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      log.error('Webhook signature verification failed', error)
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
    }

    log.info('Received Stripe event', { type: event.type, id: event.id })

    // 处理不同的事件类型
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        await handleCheckoutCompleted(supabase, session, log)
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        await handleSubscriptionChange(supabase, subscription, log)
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        await handleSubscriptionDeleted(supabase, subscription, log)
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        await handlePaymentFailed(supabase, invoice, log)
        break
      }

      default:
        log.debug('Unhandled event type', { type: event.type })
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    log.error('Webhook processing error', err)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}

async function handleCheckoutCompleted(
  supabase: ReturnType<typeof getSupabase>,
  session: Stripe.Checkout.Session,
  log: ReturnType<typeof logger.withContext>
) {
  const paymentType = session.metadata?.type

  // 处理打赏支付
  if (paymentType === 'tip') {
    await handleTipPaymentCompleted(supabase, session, log)
    return
  }

  // 处理订阅支付
  const userId = session.metadata?.supabase_user_id || session.metadata?.userId
  const customerId = session.customer as string

  if (!userId) {
    log.warn('Checkout completed without user ID', { sessionId: session.id })
    return
  }

  // 检查支付状态
  if (session.payment_status !== 'paid') {
    log.warn('Checkout completed but payment not paid', { sessionId: session.id, status: session.payment_status })
    return
  }

  log.info('Subscription checkout completed', { userId, customerId, sessionId: session.id })

  // 更新订阅记录（设置 pro tier 和 active 状态）
  const { error } = await supabase
    .from('subscriptions')
    .upsert({
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: session.subscription as string || undefined,
      tier: 'pro',
      status: 'active',
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id',
    })

  if (error) {
    log.error('Failed to update subscription record', new Error(error.message), { userId })
  }

  // 同步更新 user_profiles.subscription_tier
  const { error: profileError } = await supabase
    .from('user_profiles')
    .update({
      subscription_tier: 'pro',
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)

  if (profileError) {
    log.error('Failed to update user_profiles tier', new Error(profileError.message), { userId })
  }
}

// 处理打赏支付完成
async function handleTipPaymentCompleted(
  supabase: ReturnType<typeof getSupabase>,
  session: Stripe.Checkout.Session,
  log: ReturnType<typeof logger.withContext>
) {
  const tipId = session.metadata?.tip_id
  const postId = session.metadata?.post_id
  const fromUserId = session.metadata?.from_user_id
  const toUserId = session.metadata?.to_user_id
  const amountCents = session.metadata?.amount_cents
  const paymentIntentId = session.payment_intent as string

  if (!tipId) {
    log.warn('Tip payment completed without tip_id', { sessionId: session.id })
    return
  }

  log.info('Tip payment completed', {
    tipId,
    postId,
    fromUserId,
    toUserId,
    amountCents,
    sessionId: session.id,
  })

  // 更新打赏记录状态
  const { error: updateError } = await supabase
    .from('tips')
    .update({
      status: 'completed',
      stripe_payment_intent_id: paymentIntentId,
      completed_at: new Date().toISOString(),
    })
    .eq('id', tipId)

  if (updateError) {
    log.error('Failed to update tip status', new Error(updateError.message), { tipId })
    return
  }

  // 可选：给帖子作者发送通知（如果有通知系统）
  // await sendTipNotification(supabase, { postId, fromUserId, toUserId, amountCents })

  log.info('Tip recorded successfully', { tipId, amountCents })
}

async function handleSubscriptionChange(
  supabase: ReturnType<typeof getSupabase>,
  subscription: Stripe.Subscription,
  log: ReturnType<typeof logger.withContext>
) {
  let resolvedUserId = subscription.metadata?.supabase_user_id || subscription.metadata?.userId
  const customerId = subscription.customer as string

  if (!resolvedUserId) {
    // 尝试从客户 ID 查找用户
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle()

    if (!existing) {
      // 再尝试从 user_profiles 查找
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .maybeSingle()

      if (!profile) {
        log.warn('Subscription change without user mapping', {
          subscriptionId: subscription.id,
          customerId,
        })
        return
      }
      resolvedUserId = profile.id
    } else {
      resolvedUserId = existing.user_id
    }
  }

  const priceId = subscription.items.data[0]?.price.id || ''
  const tier = getTierFromPriceId(priceId)
  const status = mapStripeStatus(subscription.status)

  log.info('Subscription changed', {
    userId: resolvedUserId,
    tier,
    status,
    subscriptionId: subscription.id,
  })

  // 兼容不同 Stripe API 版本获取周期信息
  const sub = subscription as unknown as Record<string, unknown>
  const itemPeriod = subscription.items?.data?.[0] as unknown as Record<string, unknown> | undefined
  const periodStart = (sub.current_period_start ?? itemPeriod?.current_period_start) as number | undefined
  const periodEnd = (sub.current_period_end ?? itemPeriod?.current_period_end) as number | undefined

  const { error } = await supabase
    .from('subscriptions')
    .upsert({
      user_id: resolvedUserId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      tier,
      status,
      current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id',
    })

  if (error) {
    log.error('Failed to update subscription', new Error(error.message), { userId: resolvedUserId })
  }

  // 同步更新 user_profiles.subscription_tier
  const shouldBePro = tier === 'pro' && (status === 'active' || status === 'trialing')
  const { error: profileError } = await supabase
    .from('user_profiles')
    .update({
      subscription_tier: shouldBePro ? 'pro' : 'free',
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', resolvedUserId)

  if (profileError) {
    log.error('Failed to update user_profiles tier', new Error(profileError.message), { userId: resolvedUserId })
  }

  // Pro 会员自动加入官方群（auto-mute，不打扰用户）
  if (resolvedUserId && tier === 'pro' && status === 'active') {
    try {
      const result = await joinProOfficialGroup(resolvedUserId)
      if (result.success && result.groupId) {
        await supabase
          .from('group_members')
          .update({ notifications_muted: true })
          .eq('group_id', result.groupId)
          .eq('user_id', resolvedUserId)
        log.info('Pro member auto-joined official group (muted)', { userId: resolvedUserId, groupId: result.groupId })
      }
    } catch (joinError) {
      log.error('Failed to auto-join Pro group', joinError instanceof Error ? joinError : new Error(String(joinError)), { userId: resolvedUserId })
    }
  }
}

async function handleSubscriptionDeleted(
  supabase: ReturnType<typeof getSupabase>,
  subscription: Stripe.Subscription,
  log: ReturnType<typeof logger.withContext>
) {
  const customerId = subscription.customer as string

  log.info('Subscription deleted', {
    subscriptionId: subscription.id,
    customerId,
  })

  // 获取用户 ID 以便更新 profile 和从 Pro 群移除
  const { data: subRecord } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  // 将用户降级为免费版
  const { error } = await supabase
    .from('subscriptions')
    .update({
      tier: 'free',
      status: 'cancelled',
      stripe_subscription_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId)

  if (error) {
    log.error('Failed to downgrade subscription', new Error(error.message), { customerId })
  }

  // 同步更新 user_profiles.subscription_tier
  if (subRecord?.user_id) {
    await supabase
      .from('user_profiles')
      .update({
        subscription_tier: 'free',
        updated_at: new Date().toISOString(),
      })
      .eq('id', subRecord.user_id)

    // 从 Pro 官方群移除
    try {
      await leaveProOfficialGroup(subRecord.user_id)
      log.info('Removed user from Pro official group', { userId: subRecord.user_id })
    } catch (leaveError) {
      log.error('Failed to remove from Pro group', leaveError instanceof Error ? leaveError : new Error(String(leaveError)), { userId: subRecord.user_id })
    }
  }
}

async function handlePaymentFailed(
  supabase: ReturnType<typeof getSupabase>,
  invoice: Stripe.Invoice,
  log: ReturnType<typeof logger.withContext>
) {
  const customerId = invoice.customer as string

  log.warn('Payment failed', {
    invoiceId: invoice.id,
    customerId,
    amount: invoice.amount_due,
  })

  // 更新订阅状态为 past_due
  const { error } = await supabase
    .from('subscriptions')
    .update({
      status: 'past_due',
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId)

  if (error) {
    log.error('Failed to update subscription status', new Error(error.message), { customerId })
  }
}
