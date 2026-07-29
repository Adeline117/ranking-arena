/**
 * 订阅过期检查 Cron 任务
 *
 * 功能:
 * 1. 检查即将过期的订阅并发送提醒
 * 2. 自动降级已过期的用户
 *
 * 触发频率: 每天 UTC 0:00
 */

import { NextRequest } from 'next/server'
import { createLogger } from '@/lib/utils/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { withCron } from '@/lib/api/with-cron'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { getStripe, STRIPE_API_PRICE_IDS, STRIPE_PRICE_IDS } from '@/lib/stripe'
import { classifyActiveProSubscription } from '@/lib/stripe/reconciliation'
import { reconcileAllDueProEntitlementProjections } from '@/lib/stripe/projection-reconciliation'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const logger = createLogger('subscription-expiry')

export const GET = withCron('subscription-expiry', async (_request: NextRequest) => {
  const supabase: SupabaseClient<Database> = getSupabaseAdmin()
  const now = new Date()
  const results = {
    expiringReminders: 0,
    downgraded: 0,
    repaired: 0,
    projectionReconciled: 0,
    errors: [] as string[],
  }
  const stripe = getStripe()
  const configuredPrices = {
    monthly: STRIPE_PRICE_IDS.monthly,
    yearly: STRIPE_PRICE_IDS.yearly,
    apiStarter: STRIPE_API_PRICE_IDS.starter,
    apiPro: STRIPE_API_PRICE_IDS.pro,
  }

  // ============================================
  // 1. 发送即将过期提醒 (7 天内过期)
  // ============================================
  const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const { data: expiringSubscriptions, error: expiringQueryError } = await supabase
    .from('subscriptions')
    .select(
      'user_id, stripe_subscription_id, stripe_customer_id, current_period_end, plan, cancel_at_period_end'
    )
    .eq('status', 'active')
    .eq('cancel_at_period_end', true)
    .lt('current_period_end', sevenDaysLater.toISOString())
    .gt('current_period_end', now.toISOString())

  if (expiringQueryError) {
    results.errors.push(`Expiring subscription query failed: ${expiringQueryError.message}`)
  } else if (expiringSubscriptions && expiringSubscriptions.length > 0) {
    const verifiedExpiring: typeof expiringSubscriptions = []
    for (const local of expiringSubscriptions) {
      if (!local.stripe_subscription_id || !local.stripe_customer_id) {
        results.errors.push(`Cannot verify expiring subscription for ${local.user_id}`)
        continue
      }
      try {
        const subscription = await stripe.subscriptions.retrieve(local.stripe_subscription_id)
        const customerId =
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer.id
        const classification = classifyActiveProSubscription([subscription], configuredPrices)
        const periodEnd = subscription.items.data[0]?.current_period_end
        if (
          customerId === local.stripe_customer_id &&
          classification.kind === 'active' &&
          subscription.cancel_at_period_end &&
          periodEnd &&
          periodEnd * 1000 > now.getTime() &&
          periodEnd * 1000 < sevenDaysLater.getTime()
        ) {
          verifiedExpiring.push({
            ...local,
            current_period_end: new Date(periodEnd * 1000).toISOString(),
            plan: classification.plan,
          })
        }
      } catch (_error) {
        results.errors.push(`Stripe expiry-reminder verification failed for ${local.user_id}`)
      }
    }

    const expiringUserIds = verifiedExpiring.map((s) => s.user_id)
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const { data: existingNotifs } = await supabase
      .from('notifications')
      .select('user_id')
      .in('user_id', expiringUserIds)
      .eq('type', 'subscription_expiring')
      .gte('created_at', threeDaysAgo)
    const alreadyNotified = new Set(existingNotifs?.map((n) => n.user_id) || [])

    const toInsert = verifiedExpiring
      .filter((sub) => !alreadyNotified.has(sub.user_id))
      .map((sub) => {
        const expiryDate = new Date(sub.current_period_end!).toLocaleDateString('zh-CN')
        return {
          user_id: sub.user_id,
          type: 'subscription_expiring',
          title: 'Pro 会员即将到期',
          body: `您的 Pro 会员将于 ${expiryDate} 到期。如需继续使用 Pro 功能，请前往会员中心续费。`,
          data: {
            expiryDate: sub.current_period_end,
            plan: sub.plan,
          },
        }
      })

    if (toInsert.length > 0) {
      // Use sendNotification for built-in dedup (prevents duplicates on cron double-fire)
      const { sendNotification } = await import('@/lib/data/notifications')
      await Promise.allSettled(
        toInsert.map((n) =>
          sendNotification(
            supabase,
            {
              user_id: n.user_id,
              type: n.type as import('@/lib/data/notifications').NotificationType,
              title: n.title,
              message: n.body,
              reference_id: `sub_expiring_${n.user_id}`,
            },
            'subscription-expiry'
          )
        )
      )
      results.expiringReminders = toInsert.length
    }
  }

  // Expiry is derived from durable payment/trial/grant authority. The
  // service-role RPC updates the six-field profile projection and official
  // group membership in the same transactional authority boundary.
  try {
    const reconciliation = await reconcileAllDueProEntitlementProjections(supabase)
    results.projectionReconciled = reconciliation.processedCount
    logger.info('Subscription expiry projection reconciliation completed', reconciliation)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await sendRateLimitedAlert(
      {
        title: '订阅过期投影修复失败',
        message,
        level: 'critical',
        details: { error: message },
      },
      'subscription-expiry:projection-authority'
    )
    throw error
  }

  // Alert on errors — payment-critical, uses 15min cooldown via 'critical' level
  if (results.errors.length > 0) {
    await sendRateLimitedAlert(
      {
        title: '订阅过期处理出错',
        message: results.errors.join('\n'),
        level: 'critical',
        details: { errorCount: results.errors.length, downgraded: results.downgraded },
      },
      'subscription-expiry:errors'
    )
  }

  logger.info('Subscription expiry check completed', results)
  const processed = results.expiringReminders + results.projectionReconciled
  return { count: processed, ...results }
})
