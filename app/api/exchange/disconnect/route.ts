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
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { disconnectApiKey, isDisconnectableAccountExchange } from '@/lib/services/api-key-binder'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('exchange-disconnect')

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/exchange/disconnect
 * 断开用户与交易所的连接（软删除）
 */
export const DELETE = withApiMiddleware(
  async ({ user, request }) => {
    // 需要认证
    if (!user) {
      return createErrorResponse('Unauthorized', 401)
    }

    // 解析请求体
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return createErrorResponse('Invalid JSON body', 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return createErrorResponse('Invalid JSON body', 400)
    }
    const { exchange } = body as { exchange?: unknown }

    if (typeof exchange !== 'string' || exchange.trim().length === 0) {
      return createErrorResponse('Missing required parameter: exchange', 400)
    }
    const normalizedExchange = exchange.trim().toLowerCase()

    // Keep only exact historical base CEX keys disconnectable. In particular,
    // wallet sources (for example GMX) and guessed aliases never reach the RPC.
    if (!isDisconnectableAccountExchange(normalizedExchange)) {
      return createErrorResponse('Invalid exchange parameter', 400)
    }

    const result = await disconnectApiKey(getSupabaseAdmin(), user.id, normalizedExchange)

    if (!result.success) {
      if (result.errorCode === 'not_found') {
        return createErrorResponse('Exchange connection not found', 404)
      }
      logger.error('Failed to disconnect', { userId: user.id, exchange: normalizedExchange })
      return createErrorResponse('Failed to disconnect', 500)
    }

    logger.info('用户断开交易所连接', { userId: user.id, exchange: normalizedExchange })

    return {
      success: true,
      message: 'Disconnected successfully',
    }
  },
  {
    name: 'exchange-disconnect',
    requireAuth: true,
    rateLimit: 'sensitive', // 15次/分钟，敏感操作
  }
)
