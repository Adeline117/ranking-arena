/**
 * 交易员分位排名 API
 * Pro 会员功能：获取交易员在同类中的百分位排名
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  error,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { hasFeatureAccess, normalizeSubscriptionTier } from '@/lib/types/premium'
import { PUBLIC_ACTIVE_RANKING_SOURCES, SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { filterPublicRankingSources } from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

export const runtime = 'nodejs'

interface PercentileData {
  overall: number // 总分百分位
  return: number // 收益分百分位
  drawdown: number // 回撤分百分位
  stability: number // 稳定分百分位
  totalInCategory: number // 同类交易员总数
}

type PercentileCategory = 'futures' | 'spot' | 'web3'

const CATEGORY_SOURCES: Readonly<Record<PercentileCategory, readonly string[]>> = {
  futures: filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES).filter(
    (source) => (SOURCE_TYPE_MAP[source] || 'futures') === 'futures'
  ),
  spot: filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES).filter(
    (source) => SOURCE_TYPE_MAP[source] === 'spot'
  ),
  web3: filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES).filter(
    (source) => SOURCE_TYPE_MAP[source] === 'web3'
  ),
}

/**
 * Calculate percentile using COUNT queries instead of fetching all rows.
 * Returns the percentage of traders with a lower score.
 */
async function calculatePercentileSQL(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  column: string,
  myScore: number | null,
  categorySources: readonly string[],
  scoreCohortId: string
): Promise<{ percentile: number; total: number | null }> {
  if (myScore == null) return { percentile: 50, total: null }

  const belowQuery = supabase
    .from('leaderboard_ranks')
    .select('id', { count: 'estimated', head: true })
    .eq('season_id', '90D')
    .in('source', [...categorySources])
    .filter('rank_publication_id', 'eq', scoreCohortId)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .not(column, 'is', null)
    .lt(column, myScore)
  const totalQuery = supabase
    .from('leaderboard_ranks')
    .select('id', { count: 'estimated', head: true })
    .eq('season_id', '90D')
    .in('source', [...categorySources])
    .filter('rank_publication_id', 'eq', scoreCohortId)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .not(column, 'is', null)

  // Estimated counts are sufficient for a rounded percentile, but both counts
  // must still come from the same sealed cohort.
  const [{ count: belowCount, error: belowError }, { count: totalCount, error: totalError }] =
    await Promise.all([belowQuery, totalQuery])
  if (belowError || totalError) {
    throw new Error(
      `percentile count failed: ${belowError?.message ?? totalError?.message ?? 'unknown error'}`
    )
  }
  if (belowCount === null || totalCount === null) {
    throw new Error('percentile count returned ambiguous null authority')
  }
  if (totalCount === 0) return { percentile: 50, total: 0 }
  return {
    percentile: Math.round((belowCount / totalCount) * 100),
    total: totalCount,
  }
}

/**
 * GET - 获取交易员在同类中的百分位排名
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rl = await checkRateLimit(request, RateLimitPresets.read)
  if (rl) return rl

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 获取用户订阅等级
    const { data: subscription, error: subscriptionError } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()
    if (subscriptionError) {
      throw new Error(`subscription authority lookup failed: ${subscriptionError.message}`)
    }

    const tier = normalizeSubscriptionTier(subscription?.tier)

    // 检查是否有权限
    if (!hasFeatureAccess(tier, 'score_breakdown')) {
      return error('Pro membership required', 403)
    }

    // 解析参数
    const resolvedParams = await params
    const handle = decodeURIComponent(resolvedParams.handle)

    // Resolve trader via unified layer
    const resolved = await resolveTrader(supabase, { handle })
    if (!resolved) {
      return error('Trader not found', 404)
    }

    const sourceType = SOURCE_TYPE_MAP[resolved.platform] || 'futures'
    const category: PercentileCategory =
      sourceType === 'spot' ? 'spot' : sourceType === 'web3' ? 'web3' : 'futures'
    const categorySources = CATEGORY_SOURCES[category]
    if (categorySources.length === 0 || !categorySources.includes(resolved.platform)) {
      throw new Error('percentile source is outside its public category authority')
    }

    const sealedRead = await readSealedRankingGeneration(
      supabase,
      { season: '90D', sources: categorySources },
      async (publication) => {
        const { data: traderScores, error: traderError } = await supabase
          .from('leaderboard_ranks')
          // 三支柱模型 profitability/risk_control/execution = 旧命名 return/drawdown/stability
          .select(
            'arena_score, return_score:profitability_score, drawdown_score:risk_control_score, stability_score:execution_score'
          )
          .eq('source', resolved.platform)
          .eq('source_trader_id', resolved.traderKey)
          .eq('season_id', '90D')
          .filter('rank_publication_id', 'eq', publication.scoreCohortId)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .not('arena_score', 'is', null)
          .maybeSingle()
        if (traderError) {
          throw new Error(`trader percentile score lookup failed: ${traderError.message}`)
        }
        if (!traderScores) return null

        const [overall, returnPct, drawdown, stability] = await Promise.all([
          calculatePercentileSQL(
            supabase,
            'arena_score',
            traderScores.arena_score,
            categorySources,
            publication.scoreCohortId
          ),
          calculatePercentileSQL(
            supabase,
            'profitability_score',
            traderScores.return_score,
            categorySources,
            publication.scoreCohortId
          ),
          calculatePercentileSQL(
            supabase,
            'risk_control_score',
            traderScores.drawdown_score,
            categorySources,
            publication.scoreCohortId
          ),
          calculatePercentileSQL(
            supabase,
            'execution_score',
            traderScores.stability_score,
            categorySources,
            publication.scoreCohortId
          ),
        ])

        const percentile: PercentileData = {
          overall: overall.percentile,
          return: returnPct.percentile,
          drawdown: drawdown.percentile,
          stability: stability.percentile,
          totalInCategory: overall.total ?? 0,
        }
        return percentile
      },
      { timeoutMs: 20_000 }
    )

    if (!sealedRead.value) return error('Trader not found', 404)
    return success({ percentile: sealedRead.value, category })
  } catch (err: unknown) {
    return handleError(err)
  }
}
