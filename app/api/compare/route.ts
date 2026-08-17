/**
 * 交易员对比 API
 * Pro 会员功能：批量获取多traders allowed for comparison数据用于对比
 */

import { success, error } from '@/lib/api'
import { hasFeatureAccess, getFeatureLimits, PRO_FREE_PROMO } from '@/lib/types/premium'
import logger from '@/lib/logger'
import { resolveTrader } from '@/lib/data/unified'
import { mapLeaderboardRow } from '@/lib/data/trader/mappers'
import {
  fetchPublicProfileRankingRows,
  type PublicProfileRankingResult,
  type PublicProfileRankingScope,
  type PublicProfileRankingVisibility,
} from '@/lib/data/trader/public-profile-ranking'
import { withAuth } from '@/lib/api/middleware'
import {
  compareAccountKey,
  parseCompareAccounts,
  type CompareAccountRef,
} from '@/lib/compare/identity'

export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

const MAX_TRADERS_TO_COMPARE = 10
const COMPARE_RANKING_PERIODS = ['90D', '30D', '7D'] as const
const COMPARE_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate'

interface TraderCompareData {
  id: string
  handle: string | null
  source: string
  roi: number | null
  roi_7d: number | null
  roi_30d: number | null
  pnl: number | null
  max_drawdown: number | null
  win_rate: number | null
  trades_count: number | null
  arena_score: number | null
  return_score: number | null
  drawdown_score: number | null
  stability_score: number | null
  // v4 serving sub-scores (0-100 dimension percentiles) — the flagship breakdown
  profitability_score: number | null
  risk_control_score: number | null
  execution_score: number | null
  avatar_url?: string
  followers: number | null
  ranking_visibility: PublicProfileRankingVisibility
  ranking_visibility_reason: string | null
}

type ResolvedCompareTrader = {
  platform: string
  traderKey: string
  handle: string | null
  avatarUrl: string | null
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonEmptyStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function comparePublicCohortScope(resolved: ResolvedCompareTrader): PublicProfileRankingScope {
  return {
    source: resolved.platform,
    sourceTraderId: resolved.traderKey,
    periods: COMPARE_RANKING_PERIODS,
  }
}

function projectCurrentRankedCompareData(
  resolved: ResolvedCompareTrader,
  cohort: PublicProfileRankingResult
): TraderCompareData {
  const rowsByPeriod = new Map(
    cohort.rows.map((row) => [row.season_id, mapLeaderboardRow(row)] as const)
  )
  const current = rowsByPeriod.get('90D')
  const thirtyDay = rowsByPeriod.get('30D')
  const sevenDay = rowsByPeriod.get('7D')

  // Identity is not a ranking claim and may remain available without a
  // published row. Every metric below is null unless it survived the sealed
  // cohort proof for its exact current ranking period.
  return {
    id: resolved.traderKey,
    handle: current?.handle ?? resolved.handle ?? resolved.traderKey,
    source: resolved.platform,
    roi: finiteOrNull(current?.roi),
    roi_7d: finiteOrNull(sevenDay?.roi),
    roi_30d: finiteOrNull(thirtyDay?.roi),
    pnl: finiteOrNull(current?.pnl),
    max_drawdown: finiteOrNull(current?.maxDrawdown),
    win_rate: finiteOrNull(current?.winRate),
    trades_count: finiteOrNull(current?.tradesCount),
    arena_score: finiteOrNull(current?.arenaScore),
    return_score: finiteOrNull(current?.returnScore),
    drawdown_score: finiteOrNull(current?.drawdownScore),
    stability_score: finiteOrNull(current?.stabilityScore),
    profitability_score: finiteOrNull(current?.profitabilityScore),
    risk_control_score: finiteOrNull(current?.riskControlScore),
    execution_score: finiteOrNull(current?.executionScore),
    avatar_url: nonEmptyStringOrUndefined(current?.avatarUrl ?? resolved.avatarUrl),
    followers: finiteOrNull(current?.followers),
    ranking_visibility: cohort.rankingVisibility,
    ranking_visibility_reason: cohort.rankingVisibilityReason,
  }
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

    // ── Sealed current-ranking data only ──
    async function fetchTraderCompare(
      account: CompareAccountRef
    ): Promise<TraderCompareData | null> {
      const identity = compareAccountKey(account)
      const resolved = await resolveTrader(supabase, {
        handle: account.id,
        platform: account.source,
      })
      if (!resolved) return null

      const scope = comparePublicCohortScope(resolved)
      try {
        // Comparison output makes ranking claims. Read the sealed view on
        // every request instead of replaying a rank-bearing cache entry whose
        // membership may have been withdrawn since it was written.
        const cohort = await fetchPublicProfileRankingRows(supabase, scope)
        return projectCurrentRankedCompareData(resolved, cohort)
      } catch (err) {
        logger.warn(`[compare] Failed to read sealed ranking data for ${identity}:`, err)
        return projectCurrentRankedCompareData(resolved, {
          rows: [],
          rankingVisibility: 'unknown',
          rankingVisibilityReason: 'public_cohort_unavailable',
        })
      }
    }

    // Fetch all traders in parallel from the sealed current cohort.
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
      { 'Cache-Control': COMPARE_CACHE_CONTROL }
    )
  },
  { name: 'compare', rateLimit: 'authenticated' }
)
