/**
 * 交易员变动提醒 API
 * Pro 会员功能：管理关注交易员的变动提醒配置
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { hasFeatureAccess } from '@/lib/types/premium'
import { createLogger } from '@/lib/utils/logger'

export const runtime = 'nodejs'

const logger = createLogger('trader-alerts')

// Zod schema for POST /api/trader-alerts
const TraderAlertSchema = z.object({
  trader_id: z.string().min(1, 'trader_id is required'),
  source: z.string().optional().nullable(),
  alert_roi_change: z.boolean().optional().default(true),
  roi_change_threshold: z.number().min(0).max(100).optional().default(10),
  alert_drawdown: z.boolean().optional().default(true),
  drawdown_threshold: z.number().min(0).max(100).optional().default(20),
  alert_pnl_change: z.boolean().optional().default(false),
  pnl_change_threshold: z.number().min(0).optional().default(5000),
  alert_score_change: z.boolean().optional().default(true),
  score_change_threshold: z.number().min(0).max(100).optional().default(5),
  alert_rank_change: z.boolean().optional().default(false),
  rank_change_threshold: z.number().min(0).optional().default(5),
  alert_new_position: z.boolean().optional().default(false),
  alert_price_above: z.boolean().optional().default(false),
  price_above_value: z.number().optional().nullable(),
  alert_price_below: z.boolean().optional().default(false),
  price_below_value: z.number().optional().nullable(),
  price_symbol: z.string().max(20).optional().nullable(),
  one_time: z.boolean().optional().default(false),
  enabled: z.boolean().optional().default(true),
})

/**
 * GET - 获取用户的提醒配置列表
 */
export const GET = withAuth(async ({ user, supabase, request }) => {
  // 获取用户订阅等级
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', user.id)
    .maybeSingle()

  const tier = subscription?.tier || 'free'

  // 检查是否有权限
  if (!hasFeatureAccess(tier, 'trader_alerts')) {
    return NextResponse.json({ success: false, error: 'Pro membership required' }, { status: 403 })
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
    throw new Error('Failed to fetch alert config')
  }

  return { alerts: alerts || [] }
}, { name: 'get-trader-alerts', rateLimit: 'authenticated' })

/**
 * POST - 创建或更新提醒配置
 */
export const POST = withAuth(async ({ user, supabase, request }) => {
  // 获取用户订阅等级
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', user.id)
    .maybeSingle()

  const tier = subscription?.tier || 'free'

  // 检查是否有权限
  if (!hasFeatureAccess(tier, 'trader_alerts')) {
    return NextResponse.json({ success: false, error: 'Pro membership required' }, { status: 403 })
  }

  const body = await request.json()
  const parsed = TraderAlertSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const config = parsed.data

  // Check existing config for this trader
  const { data: existing } = await supabase
    .from('trader_alerts')
    .select('id')
    .eq('user_id', user.id)
    .eq('trader_id', config.trader_id)
    .maybeSingle()

  // Enforce max 50 alerts per user
  // KEEP 'exact' — hard limit enforcement, scoped per-user via
  // (user_id) index. Must be accurate to block the 51st add.
  if (!existing) {
    const { count } = await supabase
      .from('trader_alerts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    if ((count ?? 0) >= 50) {
      return NextResponse.json({ success: false, error: 'Maximum 50 alerts. Delete some first.' }, { status: 400 })
    }
  }

  const alertData = {
    user_id: user.id,
    trader_id: config.trader_id,
    source: config.source || null,
    alert_roi_change: config.alert_roi_change,
    roi_change_threshold: config.roi_change_threshold,
    alert_drawdown: config.alert_drawdown,
    drawdown_threshold: config.drawdown_threshold,
    alert_pnl_change: config.alert_pnl_change,
    pnl_change_threshold: config.pnl_change_threshold,
    alert_score_change: config.alert_score_change,
    score_change_threshold: config.score_change_threshold,
    alert_rank_change: config.alert_rank_change,
    rank_change_threshold: config.rank_change_threshold,
    alert_new_position: config.alert_new_position,
    alert_price_above: config.alert_price_above,
    price_above_value: config.price_above_value ?? null,
    alert_price_below: config.alert_price_below,
    price_below_value: config.price_below_value ?? null,
    price_symbol: config.price_symbol ?? null,
    one_time: config.one_time,
    enabled: config.enabled,
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
      throw new Error('Failed to update alert config')
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
      throw new Error('Failed to create alert config')
    }
    result = data
  }

  return { alert: result, created: !existing }
}, { name: 'post-trader-alerts', rateLimit: 'authenticated' })

/**
 * DELETE - 删除提醒配置
 */
export const DELETE = withAuth(async ({ user, supabase, request }) => {
  const { searchParams } = new URL(request.url)
  const alertId = searchParams.get('id')
  const traderId = searchParams.get('trader_id')

  if (!alertId && !traderId) {
    return NextResponse.json({ success: false, error: 'Either id or trader_id is required' }, { status: 400 })
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
    throw new Error('Failed to delete alert config')
  }

  return { deleted: true }
}, { name: 'delete-trader-alerts', rateLimit: 'authenticated' })
