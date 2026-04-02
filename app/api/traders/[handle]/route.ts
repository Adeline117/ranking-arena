/**
 * 获取交易员详情 API
 *
 * 性能优化：
 * - 并行查询所有数据
 * - 内存缓存（5分钟TTL）
 * - 减少数据库往返
 *
 * 数据包括：
 * - 基本信息、绩效数据
 * - 资产偏好（7D/30D/90D）
 * - 收益率曲线（7D/30D/90D）
 * - 仓位历史记录
 * - 项目表现详细数据（夏普比率、跟单者盈亏等）
 * - tracked_since（Arena 首次追踪时间）
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { z } from 'zod'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import { createLogger } from '@/lib/utils/logger'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, handleError, withCache } from '@/lib/api/response'

// 输入验证 schema（支持字母、数字、下划线、连字符、点、中文、0x 地址）
const handleSchema = z.string().min(1).max(255)

const logger = createLogger('trader-api')

// Next.js 缓存配置
export const revalidate = 300 // 5分钟，与 Cache-Control s-maxage 一致

// 缓存键前缀
const CACHE_PREFIX = 'trader:'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  const startTime = Date.now()

  try {
    const { handle: rawHandle } = await params

    const parsed = handleSchema.safeParse(rawHandle)
    if (!parsed.success) {
      throw ApiError.validation('Invalid handle parameter')
    }
    const handle = parsed.data

    const decodedHandle = decodeURIComponent(handle)

    // Accept optional ?source= param to disambiguate traders with same handle across exchanges
    const sourceParam = request.nextUrl.searchParams.get('source') || ''
    const cacheKey = `${CACHE_PREFIX}${decodedHandle.toLowerCase()}${sourceParam ? `:${sourceParam}` : ''}`

    // 检查缓存
    const cached = getServerCache<Record<string, unknown>>(cacheKey)
    if (cached) {
      const cachedData = await cached
      return apiSuccess({ ...cachedData, cached: true })
    }

    const supabase = getSupabaseAdmin()

    // ── Unified data layer: resolveTrader → getTraderDetail ──
    const resolved = await resolveTrader(supabase, {
      handle: decodedHandle,
      platform: sourceParam || undefined,
    })

    if (!resolved) {
      logger.warn(`No trader found for handle: ${decodedHandle}`)
      throw ApiError.notFound(`Trader not found: ${decodedHandle}`)
    }

    const detail = await getTraderDetail(supabase, {
      platform: resolved.platform,
      traderKey: resolved.traderKey,
    })

    if (!detail) {
      throw ApiError.notFound(`No data for trader: ${decodedHandle}`)
    }

    const data = toTraderPageData(detail)

    // 缓存结果
    setServerCache(cacheKey, data, CacheTTL.MEDIUM)

    const duration = Date.now() - startTime
    const response = apiSuccess({ ...data as Record<string, unknown>, cached: false, fetchTime: duration })
    return withCache(response, { maxAge: 300, staleWhileRevalidate: 600 })

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Trader API error', { error: errorMessage })
    return handleError(error, 'trader-detail')
  }
}
