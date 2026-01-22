import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { stripe, constructWebhookEvent, SUBSCRIPTION_STATUS_MAP } from '@/lib/stripe'
import { joinProOfficialGroup, leaveProOfficialGroup } from '@/app/api/pro-official-group/route'
import { createLogger } from '@/lib/utils/logger'

// 创建服务端 Supabase 客户端
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// 禁用 body 解析，因为我们需要原始 body 来验证签名
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const logger = createLogger('stripe-webhook')

// 带重试的数据库操作
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 1000
): Promise<T> {
  let lastError: Error | null = null
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error as Error
      logger.warn(`Retry ${i + 1}/${maxRetries} failed`, { error })
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)))
      }
    }
  }
  throw lastError
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.text()
    const signature = request.headers.get('stripe-signature')

    if (!signature) {
      return NextResponse.json(
        { error: 'Missing stripe-signature header' },
        { status: 400 }
      )
    }

    // 验证 Webhook 签名
    let event: Stripe.Event

    try {
      event = constructWebhookEvent(body, signature)
    } catch (err) {
      logger.error('Webhook signature verification failed', { error: err })
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 400 }
      )
    }

    // 幂等性检查：检查事件是否已处理
    const { data: existingEvent } = await supabase
      .from('stripe_events')
      .select('id')
      .eq('event_id', event.id)
      .single()

    if (existingEvent) {
      logger.info(`Event ${event.id} already processed, skipping`, { type: event.type })
      return NextResponse.json({ received: true, skipped: true })
    }

    // 处理不同的事件类型
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        await handleCheckoutComplete(session)
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        await handleSubscriptionUpdate(subscription)
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        await handleSubscriptionCanceled(subscription)
        break
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        await handlePaymentSucceeded(invoice)
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        await handlePaymentFailed(invoice)
        break
      }

      default:
        logger.info(`Unhandled event type: ${event.type}`)
    }

    // 记录已处理的事件（实现幂等性）
    try {
      await supabase
        .from('stripe_events')
        .insert({
          event_id: event.id,
          event_type: event.type,
          processed_at: new Date().toISOString(),
          // 不存储完整 payload 以节省空间，仅在需要审计时启用
          // payload: event.data.object,
        })
    } catch (insertError) {
      // 插入失败不应阻止响应成功（可能是并发导致的唯一约束冲突）
      logger.warn('Failed to record processed event', { eventId: event.id, error: insertError })
    }

    return NextResponse.json({ received: true })

  } catch (error) {
    logger.error('Webhook error', { error })
    return NextResponse.json(
      { error: 'Webhook handler failed' },
      { status: 500 }
    )
  }
}

// 处理 Checkout 完成
async function handleCheckoutComplete(session: Stripe.Checkout.Session) {
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
    subscription: session.subscription 
  })

  if (!userId) {
    logger.error('No userId in session metadata', { metadata: session.metadata })
    return
  }

  // 检查支付状态 - 只有已支付才更新订阅
  if (session.payment_status !== 'paid') {
    logger.warn(`Payment not completed for session ${session.id}`, { status: session.payment_status })
    return
  }

  // 检查是否为订阅模式
  if (session.mode !== 'subscription') {
    logger.warn(`Session ${session.id} is not a subscription`, { mode: session.mode })
    return
  }

  // 获取订阅信息
  const subscriptionId = session.subscription as string
  if (!subscriptionId) {
    logger.error('No subscription ID in checkout session')
    return
  }

  try {
    // 先获取订阅详情，确保订阅存在且有效
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    
    // 检查订阅状态
    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      logger.warn(`Subscription ${subscriptionId} is not active`, { status: subscription.status })
      return
    }

    // 更新订阅记录（这会同时更新 subscriptions 表和 user_profiles）
    await updateUserSubscription(userId, subscription, plan || 'monthly')

    // 自动加入 Pro 会员官方群
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

    logger.info(`Checkout completed for user ${userId}`, { plan, subscriptionId })
  } catch (err) {
    logger.error('Failed to process checkout completion', { error: err })
    // 即使获取订阅失败，也尝试更新 user_profiles（作为降级方案）
    await withRetry(async () => {
      const { error: profileError } = await supabase
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

// 处理订阅更新
async function handleSubscriptionUpdate(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string
  
  // 通过 customerId 查找用户
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) {
    logger.error('No user found for customer', { customerId })
    return
  }

  // 判断订阅计划
  const priceId = subscription.items.data[0]?.price.id
  const plan = priceId === process.env.STRIPE_PRICE_YEARLY_ID ? 'yearly' : 'monthly'

  await updateUserSubscription(profile.id, subscription, plan)
}

// 处理订阅取消
async function handleSubscriptionCanceled(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string
  
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) {
    return
  }

  // 更新用户订阅状态为已取消
  await supabase
    .from('subscriptions')
    .update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', profile.id)
    .eq('stripe_subscription_id', subscription.id)

  // 更新用户 tier 为 free
  await supabase
    .from('user_profiles')
    .update({
      subscription_tier: 'free',
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id)

  // 离开 Pro 会员官方群
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

// 处理付款成功
async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  // Stripe Invoice 的 subscription 在 parent.subscription_details 下
  const subscriptionData = invoice.parent?.subscription_details?.subscription
  const subscriptionId = typeof subscriptionData === 'string'
    ? subscriptionData
    : subscriptionData?.id || null

  if (!subscriptionId) return

  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || ''

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) return

  // 记录付款历史
  await supabase
    .from('payment_history')
    .insert({
      user_id: profile.id,
      stripe_invoice_id: invoice.id,
      stripe_payment_intent_id: null,
      amount: invoice.amount_paid,
      currency: invoice.currency,
      status: 'succeeded',
      created_at: new Date().toISOString(),
    })

  logger.info(`Payment succeeded for user ${profile.id}`, { amount: invoice.amount_paid })
}

// 处理付款失败
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, subscription_tier')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) {
    logger.warn(`Payment failed but no user found for customer`, { customerId })
    return
  }

  // 记录失败的付款
  try {
    await supabase
      .from('payment_history')
      .insert({
        user_id: profile.id,
        stripe_invoice_id: invoice.id,
        amount: invoice.amount_due,
        currency: invoice.currency,
        status: 'failed',
        created_at: new Date().toISOString(),
      })
  } catch (err) {
    logger.error('Failed to record payment failure', { error: err })
  }

  // 如果订阅状态是 past_due，更新订阅状态但不取消 Pro 权限（给用户宽限期）
  const subscriptionData = invoice.parent?.subscription_details?.subscription
  const subscriptionId = typeof subscriptionData === 'string'
    ? subscriptionData
    : subscriptionData?.id || null
  if (subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      if (subscription.status === 'past_due') {
        // 更新订阅状态为 past_due，但保持 Pro 权限直到真正取消
        await supabase
          .from('subscriptions')
          .update({
            status: 'past_due',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscriptionId)
      }
    } catch (err) {
      logger.error('Failed to update subscription status on payment failure', { error: err })
    }
  }

  logger.info(`Payment failed for user ${profile.id}`, { invoiceId: invoice.id })
}

// 更新用户订阅信息
async function updateUserSubscription(
  userId: string,
  subscription: Stripe.Subscription,
  plan: string
) {
  const status = SUBSCRIPTION_STATUS_MAP[subscription.status] || subscription.status
  // 使用 billing_cycle_anchor 作为周期开始，cancel_at 或 trial_end 作为参考
  const billingAnchor = new Date(subscription.billing_cycle_anchor * 1000)
  const startDate = new Date(subscription.start_date * 1000)

  logger.info(`updateUserSubscription`, { userId, status, plan })

  // 使用重试机制更新订阅记录
  await withRetry(async () => {
    const { error: subscriptionError } = await supabase
      .from('subscriptions')
      .upsert({
        user_id: userId,
        stripe_subscription_id: subscription.id,
        stripe_customer_id: subscription.customer as string,
        status: status,
        tier: 'pro',
        plan: plan,
        current_period_start: startDate.toISOString(),
        current_period_end: billingAnchor.toISOString(),
        cancel_at_period_end: subscription.cancel_at_period_end,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id',
      })

    if (subscriptionError) {
      throw new Error(`Failed to upsert subscriptions: ${subscriptionError.message}`)
    }
    logger.info(`Subscriptions table updated for user ${userId}`)
  })

  // 使用重试机制更新用户 profile 的订阅 tier
  const shouldBePro = status === 'active' || status === 'trialing'
  await withRetry(async () => {
    const { error: profileError } = await supabase
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
    logger.info(`user_profiles updated for user ${userId}`, { tier: shouldBePro ? 'pro' : 'free' })
  })
}
