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
  const userId = session.metadata?.supabase_user_id
  const customerId = session.customer as string

  if (!userId) {
    log.warn('Checkout completed without user ID', { sessionId: session.id })
    return
  }

  log.info('Subscription checkout completed', { userId, customerId, sessionId: session.id })

  // 更新或创建订阅记录（实际订阅状态将由 subscription.created 事件更新）
  const { error } = await supabase
    .from('subscriptions')
    .upsert({
      user_id: userId,
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id',
    })

  if (error) {
    log.error('Failed to update subscription record', new Error(error.message), { userId })
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
  const userId = subscription.metadata?.supabase_user_id
  const customerId = subscription.customer as string

  if (!userId) {
    // 尝试从客户 ID 查找用户
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle()

    if (!existing) {
      log.warn('Subscription change without user mapping', { 
        subscriptionId: subscription.id,
        customerId,
      })
      return
    }
  }

  const priceId = subscription.items.data[0]?.price.id || ''
  const tier = getTierFromPriceId(priceId)
  const status = mapStripeStatus(subscription.status)

  log.info('Subscription changed', {
    userId,
    tier,
    status,
    subscriptionId: subscription.id,
  })

  // 获取订阅周期信息（从第一个订阅项目或订阅本身）
  const subscriptionItem = subscription.items?.data?.[0]
  const periodStart = (subscriptionItem as { current_period_start?: number })?.current_period_start || 
    (subscription as unknown as { current_period_start?: number }).current_period_start
  const periodEnd = (subscriptionItem as { current_period_end?: number })?.current_period_end ||
    (subscription as unknown as { current_period_end?: number }).current_period_end

  const { error } = await supabase
    .from('subscriptions')
    .upsert({
      user_id: userId,
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
    log.error('Failed to update subscription', new Error(error.message), { userId })
  }

  // Pro 会员自动加入官方群（auto-mute，不打扰用户）
  if (userId && tier === 'pro' && status === 'active') {
    try {
      const result = await joinProOfficialGroup(userId)
      if (result.success && result.groupId) {
        // 自动设置群消息免打扰
        await supabase
          .from('group_members')
          .update({ notifications_muted: true })
          .eq('group_id', result.groupId)
          .eq('user_id', userId)
        log.info('Pro member auto-joined official group (muted)', { userId, groupId: result.groupId })
      }
    } catch (joinError) {
      log.error('Failed to auto-join Pro group', joinError instanceof Error ? joinError : new Error(String(joinError)), { userId })
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

  // 获取用户 ID 以便从 Pro 群移除
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

  // 从 Pro 官方群移除
  if (subRecord?.user_id) {
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
