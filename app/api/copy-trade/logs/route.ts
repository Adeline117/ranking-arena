/**
 * 跟单日志 API
 * GET /api/copy-trade/logs?configId=xxx&limit=50&offset=0
 */

import { NextResponse } from 'next/server'
import { withApiMiddleware, createErrorResponse } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('copy-trade-logs-api')

export const dynamic = 'force-dynamic'

/**
 * GET /api/copy-trade/logs
 * 获取跟单日志
 */
export const GET = withApiMiddleware(
  async ({ user, supabase, request }) => {
    if (!user) {
      return createErrorResponse('未授权', 401)
    }

    const configId = request.nextUrl.searchParams.get('configId')
    const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 100)
    const offset = Number(request.nextUrl.searchParams.get('offset')) || 0

    // 先验证 configId 属于当前用户
    if (configId) {
      const { data: config } = await supabase
        .from('copy_trade_configs')
        .select('id')
        .eq('id', configId)
        .eq('user_id', user.id)
        .single()

      if (!config) {
        return createErrorResponse('配置不存在或无权限', 404)
      }
    }

    let query = supabase
      .from('copy_trade_logs')
      .select('*, copy_trade_configs!inner(user_id)')
      .eq('copy_trade_configs.user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (configId) {
      query = query.eq('config_id', configId)
    }

    const { data, error } = await query

    if (error) {
      logger.error('获取跟单日志失败', error)
      return createErrorResponse('获取跟单日志失败', 500)
    }

    return NextResponse.json({ logs: data })
  },
  { requireAuth: true, name: 'copy-trade-logs-get' }
)
