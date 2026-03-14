/**
 * 交易员聚合 API
 * 一次请求获取交易员的所有数据
 *
 * GET /api/traders/[handle]/full
 *
 * 返回:
 * - trader: 基本信息
 * - performance: 各时间段表现数据
 * - stats: 详细统计
 * - portfolio: 当前持仓
 * - positions: 历史仓位
 * - equityCurve: 收益曲线
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import logger from '@/lib/logger'
import { getOrSetWithLock } from '@/lib/cache'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, handleError, withCache } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { handle } = await params

    if (!handle) {
      throw ApiError.validation('Missing handle parameter')
    }

    const cacheKey = `trader:full:${handle}`
    const data = await getOrSetWithLock(
      cacheKey,
      async () => {
        return await fetchTraderFull(handle)
      },
      { ttl: 60, lockTtl: 10 }
    )

    if (!data) {
      throw ApiError.notFound('Trader not found')
    }

    const response = apiSuccess(data)
    return withCache(response, { maxAge: 60, staleWhileRevalidate: 300 })
  } catch (error: unknown) {
    logger.error('[API] 交易员聚合数据获取Failed:', error)
    return handleError(error, 'trader-full')
  }
}

async function fetchTraderFull(handle: string) {
    const supabase = getSupabaseAdmin()

    // 1. Resolve trader identity via unified layer
    const resolved = await resolveTrader(supabase, { handle })
    if (!resolved) {
      return null
    }

    // 2. Get full trader detail via unified layer
    const detail = await getTraderDetail(supabase, {
      platform: resolved.platform,
      traderKey: resolved.traderKey,
    })

    if (!detail) {
      return null
    }

    // 3. Convert to legacy response format via toTraderPageData bridge
    const pageData = toTraderPageData(detail)

    // 4. Return in the original response shape
    return {
        trader: {
          id: resolved.traderKey,
          handle: resolved.handle || resolved.traderKey,
          nickname: resolved.handle,
          avatar_url: resolved.avatarUrl,
          source: resolved.platform,
          source_trader_id: resolved.traderKey,
          bio: null,
          trading_since: detail.trackedSince,
          created_at: null,
          updated_at: detail.trader.lastUpdated,
        },
        performance: pageData.performance,
        stats: pageData.stats,
        portfolio: (pageData.portfolio as unknown[]) || [],
        positions: (pageData.positionHistory as unknown[]) || [],
        equityCurve: (pageData.equityCurve as Record<string, unknown>)?.['30D'] || [],
        assetBreakdown: (pageData.assetBreakdown as Record<string, unknown>)?.['30D'] || [],
    }
}
