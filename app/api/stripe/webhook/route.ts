import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { stripe, constructWebhookEvent, SUBSCRIPTION_STATUS_MAP } from '@/lib/stripe'
import { joinProOfficialGroup, leaveProOfficialGroup } from '@/app/api/pro-official-group/route'
import { createLogger } from '@/lib/utils/logger'
import { mintMembershipNFT, isMintingConfigured } from '@/lib/web3/mint'

// 懒加载 Supabase Admin 客户端
let _supabase: SupabaseClient | null = null
function getSupabase() {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceKey) {
      throw new Error('Supabase credentials not configured (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)')
    }
    _supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    })
  }
  return _supabase
}

// Lazy-initialized reference - all helper functions use this
// Safe: initialized on first access, not at module load time
const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop: string) {
    const client = getSupabase()
    const value = (client as unknown as Record<string, unknown>)[prop]
    if (typeof value === 'function') {
      return value.bind(client)
    }
    return value
  },
})

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
    } catch (error: unknown) {
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
  // 前置校验：确保 Stripe 环境变量已配置
  if (!process.env.STRIPE_SECRET_KEY) {
    logger.error('STRIPE_SECRET_KEY is not configured')
    return NextResponse.json(
      { error: 'Payment system not configured' },
      { status: 503 }
    )
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    logger.error('STRIPE_WEBHOOK_SECRET is not configured')
    return NextResponse.json(
      { error: 'Webhook not configured' },
      { status: 503 }
    )
  }

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
    } catch (err: unknown) {
      logger.error('Webhook signature verification failed', { error: err })
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

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
        // Handle tip payments
        if (session.metadata?.type === 'tip') {
          await handleTipPaymentCompleted(session)
        } else {
          await handleCheckoutComplete(session)
        }
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

      // 退款处理
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        await handleChargeRefunded(charge)
        break
      }

      case 'charge.refund.updated': {
        const refund = event.data.object as Stripe.Refund
        await handleRefundUpdated(refund)
        break
      }

      // 试用期即将结束通知
      case 'customer.subscription.trial_will_end': {
        const subscription = event.data.object as Stripe.Subscription
        await handleTrialWillEnd(subscription)
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

  } catch (error: unknown) {
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

    // 自动铸造 NFT 会员证
    await mintNFTForUser(userId, plan || 'monthly')

    logger.info(`Checkout completed for user ${userId}`, { plan, subscriptionId })
  } catch (err: unknown) {
    logger.error('Failed to process checkout completion', { error: err })
    // 即使获取订阅失败，也尝试更新 user_profiles（作为降级方案）
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

// 处理订阅更新
async function handleSubscriptionUpdate(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string
  
  // 通过 customerId 查找用户
  const { data: profile } = await getSupabase()
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
  
  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) {
    return
  }

  // 更新用户订阅状态为已取消
  await getSupabase()
    .from('subscriptions')
    .update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', profile.id)
    .eq('stripe_subscription_id', subscription.id)

  // 更新用户 tier 为 free
  await getSupabase()
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

  const _subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || ''

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) return

  // 记录付款历史
  await getSupabase()
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

  const { data: profile } = await getSupabase()
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
    await getSupabase()
      .from('payment_history')
      .insert({
        user_id: profile.id,
        stripe_invoice_id: invoice.id,
        amount: invoice.amount_due,
        currency: invoice.currency,
        status: 'failed',
        created_at: new Date().toISOString(),
      })
  } catch (err: unknown) {
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
        await getSupabase()
          .from('subscriptions')
          .update({
            status: 'past_due',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscriptionId)
      }
    } catch (err: unknown) {
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
  // 兼容不同 Stripe API 版本获取周期信息
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

  // Use transactional RPC to update subscription and profile atomically
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
      // Fallback to separate updates if RPC not yet deployed
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

// 处理打赏支付完成
async function handleTipPaymentCompleted(session: Stripe.Checkout.Session) {
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
    tipId,
    postId,
    fromUserId,
    toUserId,
    amountCents,
    sessionId: session.id,
  })

  // 更新打赏记录状态
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

  // 发送通知给帖子作者
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

// 处理退款
async function handleChargeRefunded(charge: Stripe.Charge) {
  const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id
  if (!customerId) {
    logger.warn('Charge refunded without customer ID', { chargeId: charge.id })
    return
  }

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id, subscription_tier')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) {
    logger.warn('Refund processed but no user found', { customerId, chargeId: charge.id })
    return
  }

  // 记录退款
  try {
    await getSupabase()
      .from('payment_history')
      .insert({
        user_id: profile.id,
        stripe_payment_intent_id: charge.payment_intent as string,
        amount: -(charge.amount_refunded || 0),
        currency: charge.currency,
        status: 'refunded',
        created_at: new Date().toISOString(),
      })
  } catch (err: unknown) {
    logger.error('Failed to record refund', { error: err })
  }

  // 如果是全额退款且与订阅相关，降级用户
  if (charge.refunded && charge.amount === charge.amount_refunded) {
    // 检查是否有活跃订阅
    const { data: subscription } = await getSupabase()
      .from('subscriptions')
      .select('id, status')
      .eq('user_id', profile.id)
      .eq('status', 'active')
      .single()

    if (!subscription) {
      // 没有活跃订阅，降级用户
      await getSupabase()
        .from('user_profiles')
        .update({
          subscription_tier: 'free',
          updated_at: new Date().toISOString(),
        })
        .eq('id', profile.id)

      // 离开 Pro 群
      try {
        await leaveProOfficialGroup(profile.id)
      } catch (leaveError) {
        logger.error('Error leaving Pro group after refund', { error: leaveError })
      }

      logger.info(`User ${profile.id} downgraded to free after full refund`)
    }
  }

  logger.info('Charge refunded', { userId: profile.id, chargeId: charge.id, amount: charge.amount_refunded })
}

// 处理退款状态更新
async function handleRefundUpdated(refund: Stripe.Refund) {
  logger.info('Refund updated', { refundId: refund.id, status: refund.status })

  // 如果退款失败，可以在这里处理
  if (refund.status === 'failed') {
    logger.warn('Refund failed', { refundId: refund.id, reason: refund.failure_reason })
  }
}

// 自动铸造 NFT 给用户
async function mintNFTForUser(userId: string, plan: string) {
  // 检查 NFT 铸造是否配置
  if (!isMintingConfigured()) {
    logger.info('NFT minting not configured, skipping', { userId })
    return
  }

  try {
    // 获取用户钱包地址
    const { data: profile } = await getSupabase()
      .from('user_profiles')
      .select('wallet_address')
      .eq('id', userId)
      .single()

    if (!profile?.wallet_address) {
      logger.info('User has no wallet address, NFT minting skipped', { userId })
      // 发送通知提醒用户链接钱包
      await getSupabase()
        .from('notifications')
        .insert({
          user_id: userId,
          type: 'nft_pending',
          title: '链接钱包领取 NFT 会员证',
          body: '您已成功订阅 Pro 会员！链接钱包后即可获得 NFT 会员证明。',
          data: { plan },
        })
      return
    }

    // 铸造 NFT
    const mintPlan = plan === 'yearly' ? 'yearly' : 'monthly'
    const result = await mintMembershipNFT(profile.wallet_address, mintPlan)

    if (result.success) {
      logger.info('NFT minted successfully', {
        userId,
        walletAddress: profile.wallet_address,
        tokenId: result.tokenId?.toString(),
        txHash: result.txHash,
      })

      // 记录 NFT 铸造信息
      await getSupabase()
        .from('user_profiles')
        .update({
          nft_token_id: result.tokenId?.toString(),
          nft_minted_at: new Date().toISOString(),
        })
        .eq('id', userId)

      // 发送成功通知
      await getSupabase()
        .from('notifications')
        .insert({
          user_id: userId,
          type: 'nft_minted',
          title: 'NFT 会员证已铸造',
          body: `您的 Arena Pro NFT 会员证已成功铸造到钱包 ${profile.wallet_address.slice(0, 6)}...${profile.wallet_address.slice(-4)}`,
          data: {
            tokenId: result.tokenId?.toString(),
            txHash: result.txHash,
            plan,
          },
        })
    } else {
      logger.error('NFT minting failed', { userId, error: result.error })
      // 记录失败，稍后可以重试
      await getSupabase()
        .from('nft_mint_queue')
        .upsert({
          user_id: userId,
          wallet_address: profile.wallet_address,
          plan: mintPlan,
          status: 'pending',
          error: result.error,
          created_at: new Date().toISOString(),
        }, { onConflict: 'user_id', ignoreDuplicates: true })
    }
  } catch (err) {
    logger.error('Error in mintNFTForUser', { userId, error: err })
  }
}

// 处理试用期即将结束
async function handleTrialWillEnd(subscription: Stripe.Subscription) {
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

  // 发送站内通知
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
