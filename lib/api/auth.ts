/**
 * API 身份验证工具
 * 提供统一的用户认证和订阅等级验证
 */

import { NextRequest } from 'next/server'
import { User } from '@supabase/supabase-js'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SubscriptionTier } from '@/lib/types/premium'
import { logger } from '@/lib/logger'

/**
 * 验证结果类型
 */
export type VerifyAuthResult =
  | { user: User; tier: SubscriptionTier }
  | { error: string; status: number }

/**
 * 验证用户身份并获取订阅等级
 * @param request NextRequest 对象
 * @returns 包含用户和订阅等级的对象，或错误信息
 */
export async function verifyAuth(
  request: NextRequest
): Promise<VerifyAuthResult> {
  try {
    // 1. 获取认证用户
    const user = await getAuthUser(request)
    if (!user) {
      return { error: '未授权', status: 401 }
    }

    // 2. 获取用户的订阅等级 - subscriptions table is the single source of truth
    const supabase = getSupabaseAdmin()
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('tier, status')
      .eq('user_id', user.id)
      .in('status', ['active', 'trialing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (subError) {
      logger.error('[verifyAuth] 获取订阅信息失败:', subError)
      return { error: '获取用户信息失败', status: 500 }
    }

    // 3. 返回用户和订阅等级
    const tier = (subscription?.tier || 'free') as SubscriptionTier
    return { user, tier }
  } catch (error: unknown) {
    logger.error('[verifyAuth] 验证失败:', error)
    return { error: '身份验证失败', status: 500 }
  }
}
