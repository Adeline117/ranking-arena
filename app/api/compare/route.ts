/**
 * 交易员对比 API
 * Pro 会员功能：批量获取多traders allowed for comparison数据用于对比
 */

import {
  requireAuth,
  success,
  error,
  handleError,
} from '@/lib/api'
import { hasFeatureAccess, getFeatureLimits } from '@/lib/types/premium'
import logger from '@/lib/logger'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import { withPublic } from '@/lib/api/middleware'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'

export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

const MAX_TRADERS_TO_COMPARE = 5

interface TraderCompareData {
  id: string
  handle: string | null
  source: string
  roi: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  max_drawdown?: number
  win_rate?: number
  trades_count?: number
  arena_score?: number
  return_score?: number
  drawdown_score?: number
  stability_score?: number
  avatar_url?: string
  followers?: number
  equity_curve?: Array<{ date: string; roi: number }>
}

/**
 * GET - 获取多traders allowed for comparison的对比数据
 * Query params: ids=trader1,trader2,trader3 (最多5个)
 */
export const GET = withPublic(async ({ supabase, request }) => {
    const user = await requireAuth(request)

    // 获取用户订阅等级
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()

    const tier = subscription?.tier || 'free'

    // 检查是否有权限
    if (!hasFeatureAccess(tier, 'trader_comparison')) {
      return error('Pro membership required', 403)
    }

    // 检查配额
    const _limits = getFeatureLimits(tier)
    // 可以在这里检查 comparisonReportsPerMonth 配额

    // 获取查询参数
    const { searchParams } = new URL(request.url)
    const idsParam = searchParams.get('ids')

    if (!idsParam) {
      return error('Missing ids parameter. Usage: GET /api/compare?ids=trader1,trader2 (max 5, Pro required)', 400)
    }

    const traderIds = idsParam.split(',').map(id => id.trim()).filter(Boolean)

    if (traderIds.length === 0) {
      return error('At least one trader ID is required', 400)
    }

    if (traderIds.length > MAX_TRADERS_TO_COMPARE) {
      return error(`Maximum ${MAX_TRADERS_TO_COMPARE} traders allowed for comparison`, 400)
    }

    // ── Unified data layer: resolve + fetch detail for each trader ──
    const includeEquity = searchParams.get('include_equity') === '1'

    // Cache per-trader compare data (60s) to avoid 25-55 queries on repeated comparisons
    async function fetchTraderCompare(traderId: string): Promise<TraderCompareData | null> {
      const cacheKey = `compare:trader:${traderId}:eq=${includeEquity ? 1 : 0}`
      return tieredGetOrSet(cacheKey, async () => {
        const resolved = await resolveTrader(supabase, { handle: traderId })
        if (!resolved) return null
        try {
          const detail = await getTraderDetail(supabase, {
            platform: resolved.platform,
            traderKey: resolved.traderKey,
          })
          if (!detail) return null
          const pageData = toTraderPageData(detail)
          const perf = pageData.performance as Record<string, unknown> | null
          const profile = pageData.profile as Record<string, unknown> | null
          const equityCurve: Array<{ date: string; roi: number }> | undefined = includeEquity
            ? ((pageData.equityCurve as Record<string, Array<{ date: string; roi: number }>>)?.['90D'] || [])
            : undefined

          return {
            id: traderId,
            handle: (profile?.handle as string) || traderId,
            source: (profile?.source as string) || resolved.platform,
            roi: (perf?.roi_90d as number) ?? 0,
            roi_7d: perf?.roi_7d as number | undefined,
            roi_30d: perf?.roi_30d as number | undefined,
            pnl: perf?.pnl as number | undefined,
            max_drawdown: perf?.max_drawdown as number | undefined,
            win_rate: perf?.win_rate as number | undefined,
            trades_count: perf?.trades_count as number | undefined,
            arena_score: perf?.arena_score as number | undefined,
            return_score: perf?.return_score as number | undefined,
            drawdown_score: perf?.drawdown_score as number | undefined,
            stability_score: perf?.stability_score as number | undefined,
            avatar_url: (profile?.avatar_url as string) || undefined,
            followers: (profile?.followers as number) || 0,
            ...(includeEquity ? { equity_curve: equityCurve } : {}),
          } as TraderCompareData
        } catch (err) {
          logger.warn(`[compare] Failed to fetch detail for ${traderId}:`, err)
          return null
        }
      }, 'warm') // 60s TTL — trader data changes infrequently
    }

    // Fetch all traders in parallel with per-trader caching
    const detailResults = await Promise.all(traderIds.map(fetchTraderCompare))

    // 按请求的 ID 顺序排序
    const sortedData = traderIds
      .map((id, i) => detailResults[i])
      .filter(Boolean) as TraderCompareData[]

    return success({
      traders: sortedData,
      requestedIds: traderIds,
      foundCount: sortedData.length,
    }, 200, { 'Cache-Control': 'private, s-maxage=60, stale-while-revalidate=120' })
}, { name: 'compare', rateLimit: 'authenticated' })
