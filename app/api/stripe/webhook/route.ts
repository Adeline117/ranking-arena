import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { stripe, constructWebhookEvent, SUBSCRIPTION_STATUS_MAP } from '@/lib/stripe'
import { joinProOfficialGroup, leaveProOfficialGroup } from '@/app/api/pro-official-group/route'

// 创建服务端 Supabase 客户端
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// 禁用 body 解析，因为我们需要原始 body 来验证签名
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
      console.warn(`[Webhook] Retry ${i + 1}/${maxRetries} failed:`, error)
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
      console.error('Webhook signature verification failed:', err)
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 400 }
      )
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
        console.log(`Unhandled event type: ${event.type}`)
    }

    return NextResponse.json({ received: true })

  } catch (error) {
    console.error('Webhook error:', error)
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

  console.log('[Webhook] Checkout completed:', { userId, plan, customerId, sessionId: session.id })

  if (!userId) {
    console.error('[Webhook] No userId in session metadata:', session.metadata)
    return
  }

  // 使用重试机制更新 user_profiles
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
    console.log(`[Webhook] Updated user_profiles for ${userId}, tier: pro`)
  })

  // 获取订阅信息
  const subscriptionId = session.subscription as string
  if (subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      await updateUserSubscription(userId, subscription, plan || 'monthly')
    } catch (err) {
      console.error('[Webhook] Failed to retrieve subscription:', err)
    }
  }

  // 自动加入 Pro 会员官方群
  try {
    const joinResult = await joinProOfficialGroup(userId)
    if (joinResult.success) {
      console.log(`[Webhook] User ${userId} joined Pro official group: ${joinResult.groupId}`)
    } else {
      console.warn(`[Webhook] Failed to join Pro official group: ${joinResult.message}`)
    }
  } catch (joinError) {
    console.error('[Webhook] Error joining Pro official group:', joinError)
  }

  console.log(`[Webhook] Checkout completed for user ${userId}, plan: ${plan}`)
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
    console.error('No user found for customer:', customerId)
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
      console.log(`[Webhook] User ${profile.id} left Pro official group`)
    }
  } catch (leaveError) {
    console.error('[Webhook] Error leaving Pro official group:', leaveError)
  }

  console.log(`Subscription canceled for user ${profile.id}`)
}

// 处理付款成功
async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  const invoiceData = invoice as any
  const subscriptionId = invoiceData.subscription as string
  
  if (!subscriptionId) return

  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const customerId = invoice.customer as string

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
      stripe_payment_intent_id: invoiceData.payment_intent as string,
      amount: invoice.amount_paid,
      currency: invoice.currency,
      status: 'succeeded',
      created_at: new Date().toISOString(),
    })

  console.log(`Payment succeeded for user ${profile.id}, amount: ${invoice.amount_paid}`)
}

// 处理付款失败
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) return

  // 记录失败的付款
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

  // 可以在这里发送通知给用户

  console.log(`Payment failed for user ${profile.id}`)
}

// 更新用户订阅信息
async function updateUserSubscription(
  userId: string, 
  subscription: Stripe.Subscription,
  plan: string
) {
  const subscriptionData = subscription as any
  const status = SUBSCRIPTION_STATUS_MAP[subscription.status] || subscription.status
  const currentPeriodEnd = new Date(subscriptionData.current_period_end * 1000)
  const currentPeriodStart = new Date(subscriptionData.current_period_start * 1000)

  console.log(`[Webhook] updateUserSubscription: userId=${userId}, status=${status}, plan=${plan}`)

  // 更新或创建订阅记录
  const { error: subscriptionError } = await supabase
    .from('subscriptions')
    .upsert({
      user_id: userId,
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer as string,
      status: status,
      tier: 'pro',
      plan: plan,
      current_period_start: currentPeriodStart.toISOString(),
      current_period_end: currentPeriodEnd.toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id',
    })

  if (subscriptionError) {
    console.error('[Webhook] Failed to upsert subscriptions:', subscriptionError)
  } else {
    console.log(`[Webhook] Subscriptions table updated for user ${userId}`)
  }

  // 更新用户 profile 的订阅 tier
  const { error: profileError } = await supabase
    .from('user_profiles')
    .update({
      subscription_tier: status === 'active' ? 'pro' : 'free',
      stripe_customer_id: subscription.customer as string,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)

  if (profileError) {
    console.error('[Webhook] Failed to update user_profiles:', profileError)
  } else {
    console.log(`[Webhook] user_profiles updated for user ${userId}, tier: ${status === 'active' ? 'pro' : 'free'}`)
  }
}
