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

import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/utils/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkNFTMembership } from '@/lib/web3/nft'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const logger = createLogger('subscription-expiry')

// 验证 Cron 请求 (timing-safe)
function isAuthorized(req: NextRequest): boolean {
  return verifyCronSecret(req)
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const now = new Date()
  const results = {
    expiringReminders: 0,
    downgraded: 0,
    nftChecked: 0,
    errors: [] as string[],
  }

  const plog = await PipelineLogger.start('subscription-expiry')

  try {
    // ============================================
    // 1. 发送即将过期提醒 (7 天内过期)
    // ============================================
    const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

    const { data: expiringSubscriptions } = await supabase
      .from('subscriptions')
      .select('user_id, current_period_end, plan, cancel_at_period_end')
      .eq('status', 'active')
      .eq('cancel_at_period_end', true) // 只提醒已取消续费的用户
      .lt('current_period_end', sevenDaysLater.toISOString())
      .gt('current_period_end', now.toISOString())

    if (expiringSubscriptions && expiringSubscriptions.length > 0) {
      // Batch check: which users already got a reminder in the last 3 days
      const expiringUserIds = expiringSubscriptions.map(s => s.user_id)
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
      const { data: existingNotifs } = await supabase
        .from('notifications')
        .select('user_id')
        .in('user_id', expiringUserIds)
        .eq('type', 'subscription_expiring')
        .gte('created_at', threeDaysAgo)
      const alreadyNotified = new Set(existingNotifs?.map(n => n.user_id) || [])

      // Batch insert notifications for users who haven't been notified
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
      .select('user_id, stripe_subscription_id')
      .eq('status', 'active')
      .lt('current_period_end', now.toISOString())

    if (expiredSubscriptions && expiredSubscriptions.length > 0) {
      for (const sub of expiredSubscriptions) {
        try {
          // 更新订阅状态
          await supabase
            .from('subscriptions')
            .update({
              status: 'expired',
              updated_at: now.toISOString(),
            })
            .eq('user_id', sub.user_id)
            .eq('stripe_subscription_id', sub.stripe_subscription_id)

          // 降级用户
          await supabase
            .from('user_profiles')
            .update({
              subscription_tier: 'free',
              updated_at: now.toISOString(),
            })
            .eq('id', sub.user_id)

          // 发送降级通知
          await supabase.from('notifications').insert({
            user_id: sub.user_id,
            type: 'subscription_expired',
            title: 'Pro 会员已到期',
            body: '您的 Pro 会员已到期，账号已降级为免费用户。如需恢复 Pro 功能，请前往会员中心重新订阅。',
            data: {},
          })

          // 离开 Pro 群组
          await supabase
            .from('group_members')
            .delete()
            .eq('user_id', sub.user_id)
            .eq('group_id', process.env.PRO_OFFICIAL_GROUP_ID || '')

          results.downgraded++
          logger.info(`User ${sub.user_id} downgraded due to subscription expiry`)
        } catch (err) {
          results.errors.push(`Downgrade error for ${sub.user_id}: ${err}`)
        }
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
      for (const user of nftUsers) {
        if (!user.wallet_address) continue

        try {
          const hasValidNFT = await checkNFTMembership(user.wallet_address)
          results.nftChecked++

          // 检查用户是否有活跃的 Stripe 订阅
          const { data: activeSub } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .single()

          // 如果既没有有效 NFT 也没有活跃订阅，降级用户
          if (!hasValidNFT && !activeSub) {
            await supabase
              .from('user_profiles')
              .update({
                subscription_tier: 'free',
                updated_at: now.toISOString(),
              })
              .eq('id', user.id)

            await supabase.from('notifications').insert({
              user_id: user.id,
              type: 'nft_expired',
              title: 'NFT 会员已过期',
              body: '您的 NFT 会员证已过期，账号已降级为免费用户。如需继续使用 Pro 功能，请续费或重新购买 NFT。',
              data: { walletAddress: user.wallet_address },
            })

            results.downgraded++
            logger.info(`User ${user.id} downgraded due to NFT expiry`)
          }
        } catch (err) {
          results.errors.push(`NFT check error for ${user.id}: ${err}`)
        }
      }
    }

    logger.info('Subscription expiry check completed', results)

    const processed = results.expiringReminders + results.downgraded + results.nftChecked
    await plog.success(processed, results)

    return NextResponse.json({
      success: true,
      ...results,
      timestamp: now.toISOString(),
    })
  } catch (error) {
    logger.error('Subscription expiry check failed', { error })
    await plog.error(error)
    return NextResponse.json(
      { error: 'Failed to check subscription expiry' },
      { status: 500 }
    )
  }
}
