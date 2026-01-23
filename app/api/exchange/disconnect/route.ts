/**
 * 断开交易所连接 API
 * DELETE /api/exchange/disconnect
 *
 * 请求体：
 * {
 *   exchange: 'binance' | 'bybit' | 'bitget' | ...
 * }
 */

import { withApiMiddleware, createErrorResponse } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('exchange-disconnect')

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/exchange/disconnect
 * 断开用户与交易所的连接（软删除）
 */
export const DELETE = withApiMiddleware(
  async ({ user, supabase, request }) => {
    // 需要认证
    if (!user) {
      return createErrorResponse('未授权', 401)
    }

    // 解析请求体
    const body = await request.json()
    const { exchange } = body

    if (!exchange) {
      return createErrorResponse('缺少必要参数：exchange', 400)
    }

    // 验证 exchange 参数
    const validExchanges = ['binance', 'bybit', 'bitget', 'mexc', 'okx', 'kucoin', 'coinex', 'gmx']
    if (!validExchanges.includes(exchange.toLowerCase())) {
      return createErrorResponse('无效的交易所参数', 400)
    }

    // 软删除：设置为非活跃
    const { error: updateError } = await supabase
      .from('user_exchange_connections')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)
      .eq('exchange', exchange.toLowerCase())

    if (updateError) {
      logger.error('断开连接失败', { error: updateError, userId: user.id, exchange })
      return createErrorResponse('断开连接失败', 500)
    }

    logger.info('用户断开交易所连接', { userId: user.id, exchange })

    return {
      success: true,
      message: '已断开连接',
    }
  },
  {
    name: 'exchange-disconnect',
    requireAuth: true,
    rateLimit: 'sensitive', // 15次/分钟，敏感操作
  }
)
