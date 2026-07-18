/**
 * 交易员对比 API
 * Pro 会员功能：批量获取多traders allowed for comparison数据用于对比
 */

import { success, error } from '@/lib/api'
import { hasFeatureAccess, getFeatureLimits, PRO_FREE_PROMO } from '@/lib/types/premium'
import logger from '@/lib/logger'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import { withAuth } from '@/lib/api/middleware'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import {
  compareAccountKey,
  parseCompareAccounts,
  type CompareAccountRef,
} from '@/lib/compare/identity'

export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

const MAX_TRADERS_TO_COMPARE = 10

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
  // v4 serving sub-scores (0-100 dimension percentiles) — the flagship breakdown
  profitability_score?: number
  risk_control_score?: number
  execution_score?: number
  avatar_url?: string
  followers?: number
  equity_curve?: Array<{ date: string; roi: number }>
}

/**
 * GET - 获取多traders allowed for comparison的对比数据
 * Query params: ids=trader1,trader2&platforms=bybit,binance_futures (最多10个)
 */
export const GET = withAuth(
  async ({ supabase, user, request }) => {
    // 获取用户订阅等级
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()

    const tier = subscription?.tier || 'free'

    // 检查是否有权限。2026-07-04 修 U6-1(二次):此前只查 subscriptions.tier,
    // 不认 PRO_FREE_PROMO 全站限免 → promo 期间所有非 Pro 用户(即全体)对比 API
    // 恒 403 → /compare 永远空。与 follow/groups 等路由一致,promo 期放行。
    if (!PRO_FREE_PROMO && !hasFeatureAccess(tier, 'trader_comparison')) {
      return error('Pro membership required', 403)
    }

    // 检查配额
    const _limits = getFeatureLimits(tier)
    // 可以在这里检查 comparisonReportsPerMonth 配额

    // 获取查询参数
    const { searchParams } = new URL(request.url)
    const idsParam = searchParams.get('ids')
    const platformsParam = searchParams.get('platforms')
    const parsedAccounts = parseCompareAccounts(idsParam, platformsParam)

    if (!parsedAccounts.ok) {
      const validationMessage: Record<typeof parsedAccounts.error, string> = {
        missing_ids:
          'Missing ids parameter. Usage: GET /api/compare?ids=trader1,trader2&platforms=bybit,binance_futures (max 10, Pro required)',
        missing_platforms:
          'Missing platforms parameter. Every trader ID must have an explicit platform.',
        empty_value: 'Trader IDs and platforms must not contain empty values.',
        length_mismatch: 'ids and platforms must contain the same number of values.',
        duplicate_account: 'Duplicate trader account in comparison.',
      }
      return error(validationMessage[parsedAccounts.error], 400)
    }

    const accounts = parsedAccounts.accounts
    if (accounts.length > MAX_TRADERS_TO_COMPARE) {
      return error(`Maximum ${MAX_TRADERS_TO_COMPARE} traders allowed for comparison`, 400)
    }

    // ── Unified data layer: resolve + fetch detail for each trader ──
    const includeEquity = searchParams.get('include_equity') === '1'

    // Cache per-trader compare data (60s) to avoid 25-55 queries on repeated comparisons
    async function fetchTraderCompare(
      account: CompareAccountRef
    ): Promise<TraderCompareData | null> {
      const identity = compareAccountKey(account)
      const cacheKey = `compare:trader:${encodeURIComponent(identity)}:eq=${includeEquity ? 1 : 0}`
      return tieredGetOrSet(
        cacheKey,
        async () => {
          const resolved = await resolveTrader(supabase, {
            handle: account.id,
            platform: account.source,
          })
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
              ? (pageData.equityCurve as Record<string, Array<{ date: string; roi: number }>>)?.[
                  '90D'
                ] || []
              : undefined

            return {
              id: resolved.traderKey,
              handle: (profile?.handle as string) || resolved.handle || resolved.traderKey,
              source: resolved.platform,
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
              // v4 serving sub-scores (0-100 percentiles) for the compare dimensions
              profitability_score: (perf?.profitability_score as number | null) ?? undefined,
              risk_control_score: (perf?.risk_control_score as number | null) ?? undefined,
              execution_score: (perf?.execution_score as number | null) ?? undefined,
              avatar_url: (profile?.avatar_url as string) || undefined,
              followers: (profile?.followers as number) || 0,
              ...(includeEquity ? { equity_curve: equityCurve } : {}),
            } as TraderCompareData
          } catch (err) {
            logger.warn(`[compare] Failed to fetch detail for ${identity}:`, err)
            return null
          }
        },
        'warm'
      ) // 60s TTL — trader data changes infrequently
    }

    // Fetch all traders in parallel with per-trader caching
    const detailResults = await Promise.all(accounts.map(fetchTraderCompare))

    // 按请求的复合身份顺序排序
    const sortedData = accounts
      .map((_, i) => detailResults[i])
      .filter(Boolean) as TraderCompareData[]
    const missingAccounts = accounts.filter((_, i) => detailResults[i] === null)

    return success(
      {
        traders: sortedData,
        missingAccounts,
        requestedIds: accounts.map((account) => account.id),
        requestedPlatforms: accounts.map((account) => account.source),
        requestedAccounts: accounts,
        foundCount: sortedData.length,
      },
      200,
      { 'Cache-Control': 'private, s-maxage=60, stale-while-revalidate=120' }
    )
  },
  { name: 'compare', rateLimit: 'authenticated' }
)
