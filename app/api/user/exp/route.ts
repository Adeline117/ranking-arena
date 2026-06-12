/**
 * 用户经验值 API
 * GET /api/user/exp - 查询当前等级信息
 *
 * The POST (award exp) handler was removed: it had no callers anywhere in the
 * app, and its daily-cap bookkeeping depended on the exp_transactions table
 * which was intentionally dropped from prod (phase1_drop_dead_tables).
 */

export const runtime = 'edge'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { getLevelInfo } from '@/lib/utils/user-level'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 获取或创建用户等级记录
    let { data: levelData } = await supabase
      .from('user_levels')
      .select('user_id, exp, level, daily_exp_earned, daily_exp_date, is_pro, pro_expires_at')
      .eq('user_id', user.id)
      .single()

    if (!levelData) {
      // Lazy initialization — safe with onConflict for concurrent requests
      const { data: newLevel } = await supabase
        .from('user_levels')
        .upsert({ user_id: user.id, exp: 0, level: 1 }, { onConflict: 'user_id' })
        .select()
        .single()
      levelData = newLevel
    }

    const info = getLevelInfo(levelData?.exp ?? 0)

    return success({
      ...info,
      dailyExpEarned: levelData?.daily_exp_earned ?? 0,
      dailyExpDate: levelData?.daily_exp_date,
      isPro: levelData?.is_pro ?? false,
      proExpiresAt: levelData?.pro_expires_at,
    })
  } catch (error) {
    return handleError(error)
  }
}
