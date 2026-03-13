/**
 * 跟单配置 API
 * GET    /api/copy-trade/config?traderId=xxx - 获取跟单配置
 * POST   /api/copy-trade/config              - 创建/更新跟单配置
 * DELETE /api/copy-trade/config?id=xxx       - 删除跟单配置
 */

import { NextResponse } from 'next/server'
import { withApiMiddleware, createErrorResponse } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('copy-trade-config-api')

export const dynamic = 'force-dynamic'

/**
 * GET /api/copy-trade/config
 * 获取当前用户的跟单配置
 * 可选参数: traderId - 筛选特定交易员的配置
 */
export const GET = withApiMiddleware(
  async ({ user, supabase, request }) => {
    if (!user) {
      return createErrorResponse('Unauthorized', 401)
    }

    const traderId = request.nextUrl.searchParams.get('traderId')

    let query = supabase
      .from('copy_trade_configs')
      .select('id, user_id, trader_id, exchange, settings, active, created_at, updated_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (traderId) {
      query = query.eq('trader_id', traderId)
    }

    const { data, error } = await query

    if (error) {
      logger.error('Failed to fetch copy trade config', error)
      return createErrorResponse('Failed to fetch copy trade config', 500)
    }

    return NextResponse.json({ configs: data })
  },
  { requireAuth: true, name: 'copy-trade-config-get' }
)

/**
 * POST /api/copy-trade/config
 * 创建或更新跟单配置
 */
export const POST = withApiMiddleware(
  async ({ user, supabase, request }) => {
    if (!user) {
      return createErrorResponse('Unauthorized', 401)
    }

    const body = await request.json()
    const { traderId, exchange, settings, active, id } = body

    if (!traderId || !exchange) {
      return createErrorResponse('Missing required parameters: traderId, exchange', 400)
    }

    // 验证 settings 结构
    const validSettings = {
      maxPositionSize: Number(settings?.maxPositionSize) || 0,
      leverageLimit: Number(settings?.leverageLimit) || 10,
      stopLossPercent: Number(settings?.stopLossPercent) || 0,
      takeProfitPercent: Number(settings?.takeProfitPercent) || 0,
      proportionalSize: Number(settings?.proportionalSize) || 100,
      maxDailyLoss: Number(settings?.maxDailyLoss) || 0,
      maxOpenPositions: Number(settings?.maxOpenPositions) || 0,
      allowedPairs: Array.isArray(settings?.allowedPairs) ? settings.allowedPairs : [],
      blockedPairs: Array.isArray(settings?.blockedPairs) ? settings.blockedPairs : [],
    }

    if (id) {
      // 更新
      const { data, error } = await supabase
        .from('copy_trade_configs')
        .update({
          exchange,
          settings: validSettings,
          active: Boolean(active),
        })
        .eq('id', id)
        .eq('user_id', user.id)
        .select()
        .single()

      if (error) {
        logger.error('Failed to update copy trade config', error)
        return createErrorResponse('Failed to update copy trade config', 500)
      }

      return NextResponse.json({ config: data })
    }

    // 创建
    const { data, error } = await supabase
      .from('copy_trade_configs')
      .upsert(
        {
          user_id: user.id,
          trader_id: traderId,
          exchange,
          settings: validSettings,
          active: Boolean(active),
        },
        { onConflict: 'user_id,trader_id,exchange' }
      )
      .select()
      .single()

    if (error) {
      logger.error('Failed to create copy trade config', error)
      return createErrorResponse('Failed to create copy trade config', 500)
    }

    return NextResponse.json({ config: data })
  },
  { requireAuth: true, name: 'copy-trade-config-post' }
)

/**
 * DELETE /api/copy-trade/config?id=xxx
 * 删除跟单配置
 */
export const DELETE = withApiMiddleware(
  async ({ user, supabase, request }) => {
    if (!user) {
      return createErrorResponse('Unauthorized', 401)
    }

    const id = request.nextUrl.searchParams.get('id')
    if (!id) {
      return createErrorResponse('Missing id parameter', 400)
    }

    const { error } = await supabase
      .from('copy_trade_configs')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) {
      logger.error('Failed to delete copy trade config', error)
      return createErrorResponse('Failed to delete copy trade config', 500)
    }

    return NextResponse.json({ success: true })
  },
  { requireAuth: true, name: 'copy-trade-config-delete' }
)
