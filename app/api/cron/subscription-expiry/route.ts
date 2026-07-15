/**
 * 订阅过期检查 Cron 任务
 *
 * 功能:
 * 1. 检查即将过期的订阅并发送提醒
 * 2. 自动降级已过期的用户
 * 3. 检查 NFT 会员有效期
 *
 * 触发频率: 每天 UTC 0:00
 */

import { NextRequest } from 'next/server'
import { createLogger } from '@/lib/utils/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkNFTMembership } from '@/lib/web3/nft'
import { withCron } from '@/lib/api/with-cron'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { getStripe, STRIPE_API_PRICE_IDS, STRIPE_PRICE_IDS } from '@/lib/stripe'
import { classifyActiveProSubscription, getProPlan } from '@/lib/stripe/reconciliation'
import { updateUserSubscription } from '@/app/api/stripe/webhook/handlers/subscription'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const logger = createLogger('subscription-expiry')

export const GET = withCron('subscription-expiry', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const now = new Date()
  const results = {
    expiringReminders: 0,
    downgraded: 0,
    repaired: 0,
    nftChecked: 0,
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

  // ============================================
  // 2. 自动降级已过期用户
  // ============================================
  const { data: expiredSubscriptions, error: expiredQueryError } = await supabase
    .from('subscriptions')
    .select('user_id, stripe_subscription_id, stripe_customer_id, plan')
    .eq('status', 'active')
    .or('plan.is.null,plan.neq.lifetime') // Never expire lifetime; NULL plan must still expire (三值逻辑洞 2026-07-11)
    .lt('current_period_end', now.toISOString())

  if (expiredQueryError) {
    results.errors.push(`Expired subscription query failed: ${expiredQueryError.message}`)
  } else if (expiredSubscriptions && expiredSubscriptions.length > 0) {
    const expiredUserIds = expiredSubscriptions.map((s) => s.user_id)
    const { data: expiredProfiles, error: expiredProfilesError } = await supabase
      .from('user_profiles')
      .select('id, pro_plan, wallet_address')
      .in('id', expiredUserIds)

    if (expiredProfilesError) {
      results.errors.push(`Expired profile query failed: ${expiredProfilesError.message}`)
    } else {
      const profileByUser = new Map((expiredProfiles || []).map((profile) => [profile.id, profile]))
      const confirmedExpired: typeof expiredSubscriptions = []

      for (const local of expiredSubscriptions) {
        const profile = profileByUser.get(local.user_id)
        if (
          profile?.pro_plan === 'lifetime' ||
          !local.stripe_subscription_id ||
          !local.stripe_customer_id
        ) {
          results.errors.push(`Cannot verify expired subscription for ${local.user_id}`)
          continue
        }

        try {
          const stripeSubscriptions = await stripe.subscriptions.list({
            customer: local.stripe_customer_id,
            status: 'all',
            limit: 100,
          })
          const classification = classifyActiveProSubscription(
            stripeSubscriptions.data,
            configuredPrices
          )

          if (classification.kind === 'active') {
            await updateUserSubscription(
              local.user_id,
              classification.subscription,
              classification.plan
            )
            results.repaired++
            continue
          }
          if (classification.kind === 'unknown-active-price') {
            results.errors.push(`Unknown active Stripe price for ${local.user_id}`)
            continue
          }

          const endedSubscription = stripeSubscriptions.data.find(
            (subscription) => subscription.id === local.stripe_subscription_id
          )
          const endedPlan = getProPlan(endedSubscription?.items.data[0]?.price.id, configuredPrices)
          if (!endedSubscription || !endedPlan) {
            results.errors.push(`No verified ended Pro subscription for ${local.user_id}`)
            continue
          }

          if (profile?.wallet_address) {
            try {
              if (await checkNFTMembership(profile.wallet_address)) {
                results.nftChecked++
                continue
              }
              results.nftChecked++
            } catch (_error) {
              results.errors.push(`NFT fallback verification failed for ${local.user_id}`)
              continue
            }
          }

          await updateUserSubscription(local.user_id, endedSubscription, endedPlan)
          confirmedExpired.push(local)
        } catch (_error) {
          results.errors.push(`Stripe expiration verification failed for ${local.user_id}`)
        }
      }

      // Send notifications with dedup (prevents duplicates on cron double-fire)
      const { sendNotification: sendNotif } = await import('@/lib/data/notifications')
      await Promise.allSettled(
        confirmedExpired.map((sub) =>
          sendNotif(
            supabase,
            {
              user_id: sub.user_id,
              type: 'subscription_expired' as import('@/lib/data/notifications').NotificationType,
              title: 'Pro 会员已到期',
              message:
                '您的 Pro 会员已到期，账号已降级为免费用户。如需恢复 Pro 功能，请前往会员中心重新订阅。',
              reference_id: `sub_expired_${sub.user_id}`,
            },
            'subscription-expiry'
          )
        )
      )
      // sendNotification handles errors internally (fire-and-forget with dedup)

      // Batch DELETE group_members for pro group
      const proGroupId = process.env.PRO_OFFICIAL_GROUP_ID || ''
      const confirmedExpiredUserIds = confirmedExpired.map((subscription) => subscription.user_id)
      if (proGroupId && confirmedExpiredUserIds.length > 0) {
        const { error: groupErr } = await supabase
          .from('group_members')
          .delete()
          .in('user_id', confirmedExpiredUserIds)
          .eq('group_id', proGroupId)

        if (groupErr) {
          results.errors.push(`Batch group member removal error: ${groupErr.message}`)
        }
      }

      results.downgraded = confirmedExpired.length
      logger.info(`Downgraded ${confirmedExpired.length} Stripe-verified expired subscriptions`)
    }
  }

  // ============================================
  // 3. 检查 NFT 会员有效期
  // ============================================
  const { data: nftUsers } = await supabase
    .from('user_profiles')
    .select('id, wallet_address, subscription_tier, stripe_customer_id, pro_plan')
    .not('wallet_address', 'is', null)
    .eq('subscription_tier', 'pro')

  if (nftUsers && nftUsers.length > 0) {
    const validNftUsers = nftUsers.filter((u) => u.wallet_address)

    // Check NFT membership with concurrency limit of 5
    const NFT_CONCURRENCY = 5
    const nftResults: { user: (typeof validNftUsers)[number]; hasValidNFT: boolean }[] = []

    for (let i = 0; i < validNftUsers.length; i += NFT_CONCURRENCY) {
      const batch = validNftUsers.slice(i, i + NFT_CONCURRENCY)
      const batchResults = await Promise.all(
        batch.map(async (user) => {
          try {
            const hasValidNFT = await checkNFTMembership(user.wallet_address!)
            results.nftChecked++
            return { user, hasValidNFT }
          } catch (err) {
            results.errors.push(`NFT check error for ${user.id}: ${err}`)
            return null
          }
        })
      )
      for (const r of batchResults) {
        if (r) nftResults.push(r)
      }
    }

    // Batch query: find which of these users have active subscriptions
    const nftUserIds = nftResults.filter((r) => !r.hasValidNFT).map((r) => r.user.id)

    if (nftUserIds.length > 0) {
      const { data: activeSubUsers, error: activeSubUsersError } = await supabase
        .from('subscriptions')
        .select('user_id, stripe_customer_id')
        .in('user_id', nftUserIds)
        .in('status', ['active', 'trialing'])

      if (activeSubUsersError) {
        results.errors.push(
          `Active subscription query for NFT fallback failed: ${activeSubUsersError.message}`
        )
      } else {
        const localActiveByUser = new Map(
          (activeSubUsers || []).map((subscription) => [subscription.user_id, subscription])
        )
        const toDowngrade: typeof nftResults = []

        for (const result of nftResults.filter((item) => !item.hasValidNFT)) {
          if (result.user.pro_plan === 'lifetime') continue

          const localActive = localActiveByUser.get(result.user.id)
          const customerId = result.user.stripe_customer_id || localActive?.stripe_customer_id
          if (!customerId) {
            if (localActive) {
              results.errors.push(`Cannot verify Stripe fallback for NFT user ${result.user.id}`)
              continue
            }
            toDowngrade.push(result)
            continue
          }

          try {
            const stripeSubscriptions = await stripe.subscriptions.list({
              customer: customerId,
              status: 'all',
              limit: 100,
            })
            const classification = classifyActiveProSubscription(
              stripeSubscriptions.data,
              configuredPrices
            )
            if (classification.kind === 'active') {
              await updateUserSubscription(
                result.user.id,
                classification.subscription,
                classification.plan
              )
              results.repaired++
              continue
            }
            if (classification.kind === 'unknown-active-price') {
              results.errors.push(`Unknown active Stripe price for NFT user ${result.user.id}`)
              continue
            }
            toDowngrade.push(result)
          } catch (_error) {
            results.errors.push(`Stripe NFT fallback verification failed for ${result.user.id}`)
          }
        }

        if (toDowngrade.length > 0) {
          const downgradeIds = toDowngrade.map((r) => r.user.id)

          // Batch UPDATE user_profiles → free tier
          const { error: profileErr } = await supabase
            .from('user_profiles')
            .update({
              subscription_tier: 'free',
              pro_plan: null,
              updated_at: now.toISOString(),
            })
            .in('id', downgradeIds)

          if (profileErr) {
            results.errors.push(`Batch NFT profile downgrade error: ${profileErr.message}`)
          } else {
            // Send NFT expiry notifications with dedup
            const { sendNotification: sendNftNotif } = await import('@/lib/data/notifications')
            await Promise.allSettled(
              toDowngrade.map((r) =>
                sendNftNotif(
                  supabase,
                  {
                    user_id: r.user.id,
                    type: 'nft_expired' as import('@/lib/data/notifications').NotificationType,
                    title: 'NFT 会员已过期',
                    message:
                      '您的 NFT 会员证已过期，账号已降级为免费用户。如需继续使用 Pro 功能，请续费或重新购买 NFT。',
                    reference_id: `nft_expired_${r.user.id}`,
                  },
                  'subscription-expiry'
                )
              )
            )

            const proGroupId = process.env.PRO_OFFICIAL_GROUP_ID || ''
            if (proGroupId) {
              const { error: groupError } = await supabase
                .from('group_members')
                .delete()
                .in('user_id', downgradeIds)
                .eq('group_id', proGroupId)
              if (groupError) {
                results.errors.push(`NFT Pro group removal error: ${groupError.message}`)
              }
            }

            results.downgraded += toDowngrade.length
            logger.info(`Batch downgraded ${toDowngrade.length} users due to NFT expiry`)
          }
        }
      }
    }
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
  const processed = results.expiringReminders + results.downgraded + results.nftChecked
  return { count: processed, ...results }
})
