/**
 * API 身份验证工具
 * 提供统一的用户认证和订阅等级验证
 */

import { NextRequest } from 'next/server'
import { User } from '@supabase/supabase-js'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SubscriptionTier } from '@/lib/types/premium'
import { logger } from '@/lib/logger'
import { getCanonicalSubscriptionTier } from '@/lib/premium/server-entitlement'

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
export async function verifyAuth(request: NextRequest): Promise<VerifyAuthResult> {
  try {
    // 1. 获取认证用户
    const user = await getAuthUser(request)
    if (!user) {
      return { error: '未授权', status: 401 }
    }

    // 2. Read canonical, fail-closed entitlement authority. Subscription and
    // profile rows are projections and are not authorization boundaries.
    const supabase = getSupabaseAdmin()
    const tier: SubscriptionTier = await getCanonicalSubscriptionTier(supabase, user.id)

    // 3. 返回用户和订阅等级
    return { user, tier }
  } catch (error: unknown) {
    logger.error('[verifyAuth] 验证失败:', error)
    return { error: '身份验证失败', status: 500 }
  }
}
