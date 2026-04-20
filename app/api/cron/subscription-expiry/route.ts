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
    nftChecked: 0,
    errors: [] as string[],
  }

  // ============================================
  // 1. 发送即将过期提醒 (7 天内过期)
  // ============================================
  const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const { data: expiringSubscriptions } = await supabase
    .from('subscriptions')
    .select('user_id, current_period_end, plan, cancel_at_period_end')
    .eq('status', 'active')
    .eq('cancel_at_period_end', true)
    .lt('current_period_end', sevenDaysLater.toISOString())
    .gt('current_period_end', now.toISOString())

  if (expiringSubscriptions && expiringSubscriptions.length > 0) {
    const expiringUserIds = expiringSubscriptions.map(s => s.user_id)
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const { data: existingNotifs } = await supabase
      .from('notifications')
      .select('user_id')
      .in('user_id', expiringUserIds)
      .eq('type', 'subscription_expiring')
      .gte('created_at', threeDaysAgo)
    const alreadyNotified = new Set(existingNotifs?.map(n => n.user_id) || [])

    const toInsert = expiringSubscriptions
      .filter(sub => !alreadyNotified.has(sub.user_id))
      .map(sub => {
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
      const { error: insertErr } = await supabase.from('notifications').insert(toInsert)
      if (insertErr) {
        results.errors.push(`Batch expiring reminder error: ${insertErr.message}`)
      } else {
        results.expiringReminders = toInsert.length
      }
    }
  }

  // ============================================
  // 2. 自动降级已过期用户
  // ============================================
  const { data: expiredSubscriptions } = await supabase
    .from('subscriptions')
    .select('user_id, stripe_subscription_id, plan')
    .eq('status', 'active')
    .neq('plan', 'lifetime') // Never expire lifetime plans
    .lt('current_period_end', now.toISOString())

  if (expiredSubscriptions && expiredSubscriptions.length > 0) {
    const expiredUserIds = expiredSubscriptions.map(s => s.user_id)

    try {
      // Batch UPDATE subscriptions → expired
      const { error: subErr } = await supabase
        .from('subscriptions')
        .update({
          status: 'expired',
          updated_at: now.toISOString(),
        })
        .in('user_id', expiredUserIds)
        .eq('status', 'active')

      if (subErr) {
        results.errors.push(`Batch subscription update error: ${subErr.message}`)
      }

      // Batch UPDATE user_profiles → free tier
      const { error: profileErr } = await supabase
        .from('user_profiles')
        .update({
          subscription_tier: 'free',
          updated_at: now.toISOString(),
        })
        .in('id', expiredUserIds)

      if (profileErr) {
        results.errors.push(`Batch profile downgrade error: ${profileErr.message}`)
      }

      // Batch INSERT notifications
      const notifications = expiredSubscriptions.map(sub => ({
        user_id: sub.user_id,
        type: 'subscription_expired',
        title: 'Pro 会员已到期',
        body: '您的 Pro 会员已到期，账号已降级为免费用户。如需恢复 Pro 功能，请前往会员中心重新订阅。',
        data: {},
      }))
      const { error: notifErr } = await supabase.from('notifications').insert(notifications)
      if (notifErr) {
        results.errors.push(`Batch notification insert error: ${notifErr.message}`)
      }

      // Batch DELETE group_members for pro group
      const proGroupId = process.env.PRO_OFFICIAL_GROUP_ID || ''
      if (proGroupId) {
        const { error: groupErr } = await supabase
          .from('group_members')
          .delete()
          .in('user_id', expiredUserIds)
          .eq('group_id', proGroupId)

        if (groupErr) {
          results.errors.push(`Batch group member removal error: ${groupErr.message}`)
        }
      }

      results.downgraded = expiredSubscriptions.length
      logger.info(`Batch downgraded ${expiredSubscriptions.length} users due to subscription expiry`)
    } catch (err) {
      results.errors.push(`Batch downgrade error: ${err}`)
    }
  }

  // ============================================
  // 3. 检查 NFT 会员有效期
  // ============================================
  const { data: nftUsers } = await supabase
    .from('user_profiles')
    .select('id, wallet_address, subscription_tier')
    .not('wallet_address', 'is', null)
    .eq('subscription_tier', 'pro')

  if (nftUsers && nftUsers.length > 0) {
    const validNftUsers = nftUsers.filter(u => u.wallet_address)

    // Check NFT membership with concurrency limit of 5
    const NFT_CONCURRENCY = 5
    const nftResults: { user: typeof validNftUsers[number]; hasValidNFT: boolean }[] = []

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
    const nftUserIds = nftResults.filter(r => !r.hasValidNFT).map(r => r.user.id)

    if (nftUserIds.length > 0) {
      const { data: activeSubUsers } = await supabase
        .from('subscriptions')
        .select('user_id')
        .in('user_id', nftUserIds)
        .eq('status', 'active')

      const usersWithActiveSub = new Set(activeSubUsers?.map(s => s.user_id) || [])

      // Users to downgrade: no valid NFT AND no active subscription
      const toDowngrade = nftResults
        .filter(r => !r.hasValidNFT && !usersWithActiveSub.has(r.user.id))

      if (toDowngrade.length > 0) {
        const downgradeIds = toDowngrade.map(r => r.user.id)

        // Batch UPDATE user_profiles → free tier
        const { error: profileErr } = await supabase
          .from('user_profiles')
          .update({
            subscription_tier: 'free',
            updated_at: now.toISOString(),
          })
          .in('id', downgradeIds)

        if (profileErr) {
          results.errors.push(`Batch NFT profile downgrade error: ${profileErr.message}`)
        }

        // Batch INSERT notifications
        const nftNotifications = toDowngrade.map(r => ({
          user_id: r.user.id,
          type: 'nft_expired',
          title: 'NFT 会员已过期',
          body: '您的 NFT 会员证已过期，账号已降级为免费用户。如需继续使用 Pro 功能，请续费或重新购买 NFT。',
          data: { walletAddress: r.user.wallet_address },
        }))
        const { error: notifErr } = await supabase.from('notifications').insert(nftNotifications)
        if (notifErr) {
          results.errors.push(`Batch NFT notification insert error: ${notifErr.message}`)
        }

        results.downgraded += toDowngrade.length
        logger.info(`Batch downgraded ${toDowngrade.length} users due to NFT expiry`)
      }
    }
  }

  logger.info('Subscription expiry check completed', results)
  const processed = results.expiringReminders + results.downgraded + results.nftChecked
  return { count: processed, ...results }
})
