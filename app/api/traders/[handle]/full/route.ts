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
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, handleError } from '@/lib/api/response'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

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

    // getTraderDetail seals all three ranking windows. Do not wrap it in a
    // generic cross-request cache: that cache cannot prove its generations are
    // still current after any 7D/30D/90D publication advances.
    const data = await fetchTraderFull(handle)

    if (!data) {
      throw ApiError.notFound('Trader not found')
    }

    return apiSuccess(data, 200, NO_STORE_HEADERS)
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
