import Stripe from 'stripe'
import { leaveProOfficialGroup } from '@/app/api/pro-official-group/route'
import { getSupabase, logger } from './shared'
import { getStripe } from '@/lib/stripe'

/**
 * 该退款 charge 是否就是 lifetime 那笔购买。charge/PI 上没有 plan 元数据
 * (session metadata 不传导),用 payment_intent 回查 checkout session 读
 * metadata.plan。查不到(网络/历史数据)返回 null,调用侧保守处理。
 */
async function isLifetimePurchaseCharge(charge: Stripe.Charge): Promise<boolean | null> {
  const pi =
    typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id
  if (!pi) return null
  try {
    const sessions = await getStripe().checkout.sessions.list({ payment_intent: pi, limit: 1 })
    const plan = sessions.data[0]?.metadata?.plan
    if (!plan) return null
    return plan === 'lifetime'
  } catch (err) {
    logger.error('Lifetime-charge lookup failed', {
      pi,
      error: err instanceof Error ? err.message : err,
    })
    return null
  }
}

export async function handleChargeRefunded(charge: Stripe.Charge) {
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

  // Record refund in payment_history (upsert to handle retries)
  const { error: historyErr } = await getSupabase()
    .from('payment_history')
    .upsert(
      {
        user_id: profile.id,
        stripe_payment_intent_id: charge.payment_intent as string,
        amount: -(charge.amount_refunded || 0),
        currency: charge.currency,
        status: 'refunded',
        created_at: new Date().toISOString(),
      },
      { onConflict: 'stripe_payment_intent_id' }
    )
  if (historyErr) {
    logger.error('Failed to record refund', { error: historyErr, chargeId: charge.id })
  }

  if (charge.refunded && charge.amount === charge.amount_refunded) {
    const { data: subscription } = await getSupabase()
      .from('subscriptions')
      .select('id, status')
      .eq('user_id', profile.id)
      .eq('status', 'active')
      .single()

    // Cancel active subscription if exists
    if (subscription) {
      await getSupabase()
        .from('subscriptions')
        .update({ status: 'canceled', canceled_at: new Date().toISOString() })
        .eq('id', subscription.id)
      logger.info(`Subscription ${subscription.id} canceled due to full refund`)
    }

    // Downgrade user to free tier — but NEVER downgrade lifetime plan holders
    // unless the refund is specifically for their lifetime purchase.
    // 2026-07-11 修:此前注释这么说、代码却无条件跳过 → 买 lifetime→退款→
    // 白嫖 Pro。现回查 checkout session 判定这笔是否 lifetime 购买;
    // 判定不了(null)时保守跳过降级但 error 级留痕(人工跟进,不静默)。
    const { data: currentProfile } = await getSupabase()
      .from('user_profiles')
      .select('pro_plan')
      .eq('id', profile.id)
      .single()
    const lifetimeCharge =
      currentProfile?.pro_plan === 'lifetime' ? await isLifetimePurchaseCharge(charge) : false
    if (currentProfile?.pro_plan === 'lifetime' && lifetimeCharge === true) {
      await getSupabase()
        .from('user_profiles')
        .update({
          subscription_tier: 'free',
          pro_plan: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', profile.id)
      logger.info('Lifetime purchase fully refunded — Pro revoked', {
        userId: profile.id,
        chargeId: charge.id,
      })
    } else if (currentProfile?.pro_plan === 'lifetime') {
      logger.error('Refund for lifetime holder NOT matched to lifetime charge — manual review', {
        userId: profile.id,
        chargeId: charge.id,
        lookup: lifetimeCharge === null ? 'lookup-failed' : 'other-charge',
      })
    } else {
      await getSupabase()
        .from('user_profiles')
        .update({
          subscription_tier: 'free',
          updated_at: new Date().toISOString(),
        })
        .eq('id', profile.id)
    }

    try {
      await leaveProOfficialGroup(profile.id)
    } catch (leaveError) {
      logger.error('Error leaving Pro group after refund', { error: leaveError })
    }

    logger.info(`User ${profile.id} downgraded to free after full refund`)
  }

  logger.info('Charge refunded', {
    userId: profile.id,
    chargeId: charge.id,
    amount: charge.amount_refunded,
  })
}

export async function handleRefundUpdated(refund: Stripe.Refund) {
  logger.info('Refund updated', { refundId: refund.id, status: refund.status })

  if (refund.status === 'failed') {
    logger.warn('Refund failed', { refundId: refund.id, reason: refund.failure_reason })
  }
}

/**
 * Chargeback / dispute (2026-07-11 上线审计:此前 webhook 完全不处理 dispute)。
 * 切 live 后首笔 chargeback:钱被划走 + $15 dispute fee,用户还留着 Pro,团队
 * 无感知。这里最小处置:记 payment_history + Telegram 告警(不自动撤权——
 * dispute 可能被商家赢回,撤权留人工在 Stripe Dashboard 判)。webhook 事件
 * 订阅需在 Stripe 后台加 charge.dispute.created(见 docs/STRIPE_GO_LIVE.md)。
 */
export async function handleChargeDisputeCreated(dispute: Stripe.Dispute) {
  const charge = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id
  logger.error('Chargeback/dispute created', {
    disputeId: dispute.id,
    chargeId: charge,
    amount: dispute.amount,
    reason: dispute.reason,
    status: dispute.status,
  })
  try {
    const { sendAlert } = await import('@/lib/alerts/send-alert')
    await sendAlert({
      level: 'critical',
      source: 'stripe',
      title: 'Chargeback / 支付争议',
      message: `收到 chargeback(${dispute.reason})，金额 ${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}。去 Stripe Dashboard 应诉或接受，并决定是否撤销该用户 Pro。`,
      details: { disputeId: dispute.id, chargeId: charge ?? '—', status: dispute.status },
    })
  } catch (err) {
    logger.error('dispute alert failed (non-fatal)', {
      error: err instanceof Error ? err.message : err,
    })
  }
}
