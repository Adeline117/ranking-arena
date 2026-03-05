/**
 * 交易员变动提醒 API
 * Pro 会员功能：管理关注交易员的变动提醒配置
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  error,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { hasFeatureAccess } from '@/lib/types/premium'
import logger from '@/lib/logger'

export const runtime = 'nodejs'

// 提醒配置类型
interface TraderAlertConfig {
  id?: string
  trader_id: string
  source?: string
  alert_roi_change?: boolean
  roi_change_threshold?: number
  alert_drawdown?: boolean
  drawdown_threshold?: number
  alert_pnl_change?: boolean
  pnl_change_threshold?: number
  alert_score_change?: boolean
  score_change_threshold?: number
  alert_rank_change?: boolean
  rank_change_threshold?: number
  alert_new_position?: boolean
  alert_price_above?: boolean
  price_above_value?: number | null
  alert_price_below?: boolean
  price_below_value?: number | null
  price_symbol?: string | null
  one_time?: boolean
  enabled?: boolean
}

/**
 * GET - 获取用户的提醒配置列表
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 获取用户订阅等级
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()

    const tier = subscription?.tier || 'free'

    // 检查是否有权限
    if (!hasFeatureAccess(tier, 'trader_alerts')) {
      return error('Pro membership required', 403)
    }

    // 获取查询参数
    const { searchParams } = new URL(request.url)
    const traderId = searchParams.get('trader_id')

    let query = supabase
      .from('trader_alerts')
      .select('id, trader_id, source, alert_roi_change, roi_change_threshold, alert_drawdown, drawdown_threshold, alert_pnl_change, pnl_change_threshold, alert_score_change, score_change_threshold, alert_rank_change, rank_change_threshold, alert_new_position, alert_price_above, price_above_value, alert_price_below, price_below_value, price_symbol, one_time, enabled, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (traderId) {
      query = query.eq('trader_id', traderId)
    }

    const { data: alerts, error: queryError } = await query

    if (queryError) {
      logger.error('[trader-alerts] 查询Failed:', queryError)
      return error('Failed to fetch alert config', 500)
    }

    return success({ alerts: alerts || [] })
  } catch (err: unknown) {
    return handleError(err)
  }
}

/**
 * POST - 创建或更新提醒配置
 */
export async function POST(request: NextRequest) {
  // 限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 获取用户订阅等级
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()

    const tier = subscription?.tier || 'free'

    // 检查是否有权限
    if (!hasFeatureAccess(tier, 'trader_alerts')) {
      return error('Pro membership required', 403)
    }

    const body = await request.json()
    const config: TraderAlertConfig = body

    // 验证必填字段
    const traderId = validateString(config.trader_id, {
      required: true,
      fieldName: 'trader_id',
    })

    if (!traderId) {
      return error('Missing trader_id', 400)
    }

    // 检查是否已存在配置
    const { data: existing } = await supabase
      .from('trader_alerts')
      .select('id')
      .eq('user_id', user.id)
      .eq('trader_id', traderId)
      .maybeSingle()

    const alertData = {
      user_id: user.id,
      trader_id: traderId,
      source: config.source || null,
      alert_roi_change: config.alert_roi_change ?? true,
      roi_change_threshold: config.roi_change_threshold ?? 10,
      alert_drawdown: config.alert_drawdown ?? true,
      drawdown_threshold: config.drawdown_threshold ?? 20,
      alert_pnl_change: config.alert_pnl_change ?? false,
      pnl_change_threshold: config.pnl_change_threshold ?? 5000,
      alert_score_change: config.alert_score_change ?? true,
      score_change_threshold: config.score_change_threshold ?? 5,
      alert_rank_change: config.alert_rank_change ?? false,
      rank_change_threshold: config.rank_change_threshold ?? 5,
      alert_new_position: config.alert_new_position ?? false,
      alert_price_above: config.alert_price_above ?? false,
      price_above_value: config.price_above_value ?? null,
      alert_price_below: config.alert_price_below ?? false,
      price_below_value: config.price_below_value ?? null,
      price_symbol: config.price_symbol ?? null,
      one_time: config.one_time ?? false,
      enabled: config.enabled ?? true,
    }

    let result
    if (existing) {
      // 更新现有配置
      const { data, error: updateError } = await supabase
        .from('trader_alerts')
        .update(alertData)
        .eq('id', existing.id)
        .select()
        .single()

      if (updateError) {
        logger.error('[trader-alerts] 更新Failed:', updateError)
        return error('Failed to update alert config', 500)
      }
      result = data
    } else {
      // 创建新配置
      const { data, error: insertError } = await supabase
        .from('trader_alerts')
        .insert(alertData)
        .select()
        .single()

      if (insertError) {
        logger.error('[trader-alerts] 创建Failed:', insertError)
        return error('Failed to create alert config', 500)
      }
      result = data
    }

    return success({ alert: result, created: !existing })
  } catch (err: unknown) {
    return handleError(err)
  }
}

/**
 * DELETE - 删除提醒配置
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { searchParams } = new URL(request.url)
    const alertId = searchParams.get('id')
    const traderId = searchParams.get('trader_id')

    if (!alertId && !traderId) {
      return error('Either id or trader_id is required', 400)
    }

    let query = supabase
      .from('trader_alerts')
      .delete()
      .eq('user_id', user.id)

    if (alertId) {
      query = query.eq('id', alertId)
    } else if (traderId) {
      query = query.eq('trader_id', traderId)
    }

    const { error: deleteError } = await query

    if (deleteError) {
      logger.error('[trader-alerts] 删除Failed:', deleteError)
      return error('Failed to delete alert config', 500)
    }

    return success({ deleted: true })
  } catch (err: unknown) {
    return handleError(err)
  }
}
