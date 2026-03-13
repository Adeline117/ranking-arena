/**
 * 用户经验值 API
 * GET /api/user/exp - 查询当前等级信息
 * POST /api/user/exp - 增加经验值
 */

export const runtime = 'edge'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { getLevelInfo, getExpForAction, EXP_ACTIONS } from '@/lib/utils/user-level'

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
      const { data: newLevel } = await supabase
        .from('user_levels')
        .insert({ user_id: user.id, exp: 0, level: 1 })
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

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()
    const action = validateString(body.action)

    if (!action || !EXP_ACTIONS.find((a) => a.key === action)) {
      return new Response(JSON.stringify({ error: 'Invalid operation type' }), { status: 400 })
    }

    const today = new Date().toISOString().split('T')[0]

    // 获取或创建用户等级记录
    let { data: levelData } = await supabase
      .from('user_levels')
      .select('user_id, exp, level, daily_exp_earned, daily_exp_date')
      .eq('user_id', user.id)
      .single()

    if (!levelData) {
      const { data: newLevel } = await supabase
        .from('user_levels')
        .insert({ user_id: user.id, exp: 0, level: 1, daily_exp_date: today })
        .select()
        .single()
      levelData = newLevel!
    }

    // 重置日计数（如果是新的一天）
    let dailyEarned = levelData.daily_exp_earned ?? 0
    if (levelData.daily_exp_date !== today) {
      dailyEarned = 0
    }

    // 查询今日该action已获得的EXP
    const { data: todayTransactions } = await supabase
      .from('exp_transactions')
      .select('exp_amount')
      .eq('user_id', user.id)
      .eq('action', action)
      .gte('created_at', `${today}T00:00:00Z`)

    const todayActionExp = todayTransactions?.reduce((sum, t) => sum + t.exp_amount, 0) ?? 0
    const expToAdd = getExpForAction(action, todayActionExp)

    if (expToAdd === 0) {
      return success({ message: 'Daily experience limit reached for this action', added: 0 })
    }

    const newExp = (levelData.exp ?? 0) + expToAdd
    const newLevel = getLevelInfo(newExp)

    // 更新等级和记录交易
    await Promise.all([
      supabase
        .from('user_levels')
        .upsert({
          user_id: user.id,
          exp: newExp,
          level: newLevel.level,
          daily_exp_earned: dailyEarned + expToAdd,
          daily_exp_date: today,
          updated_at: new Date().toISOString(),
        }),
      supabase.from('exp_transactions').insert({
        user_id: user.id,
        action,
        exp_amount: expToAdd,
      }),
    ])

    return success({
      added: expToAdd,
      ...newLevel,
    })
  } catch (error) {
    return handleError(error)
  }
}
