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
} from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { hasFeatureAccess } from '@/lib/types/premium'
import _logger from '@/lib/logger'

export const runtime = 'nodejs'

interface PercentileData {
  overall: number      // 总分百分位
  return: number       // 收益分百分位
  drawdown: number     // 回撤分百分位
  stability: number    // 稳定分百分位
  totalInCategory: number  // 同类交易员总数
}

/**
 * Calculate percentile using COUNT queries instead of fetching all rows.
 * Returns the percentage of traders with a lower score.
 */
async function calculatePercentileSQL(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  column: string,
  myScore: number | null,
  categoryFilter: string,
): Promise<number> {
  if (myScore == null) return 50

  // Count traders with score below mine
  // Estimated is fine — the final display is a rounded whole-number
  // percentile (e.g. "Top 12%"), not an exact rank. Running 2 exact
  // counts × 4 score columns = 8 serial scans of leaderboard_ranks
  // (~300k rows) per profile view previously blew through the 30s
  // budget under cron load.
  const { count: belowCount } = await supabase
    .from('leaderboard_ranks')
    .select('id', { count: 'estimated', head: true })
    .eq('season_id', '90D')
    .ilike('source', `%${categoryFilter}%`)
    .not(column, 'is', null)
    .lt(column, myScore)

  // Count total traders with this score (estimated — same rationale)
  const { count: totalCount } = await supabase
    .from('leaderboard_ranks')
    .select('id', { count: 'estimated', head: true })
    .eq('season_id', '90D')
    .ilike('source', `%${categoryFilter}%`)
    .not(column, 'is', null)

  if (!totalCount || totalCount === 0) return 50
  return Math.round(((belowCount ?? 0) / totalCount) * 100)
}

/**
 * GET - 获取交易员在同类中的百分位排名
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 获取用户订阅等级
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()

    const tier = subscription?.tier || 'free'

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

    // Get trader scores from leaderboard_ranks
    const { data: traderScores, error: traderError } = await supabase
      .from('leaderboard_ranks')
      .select('arena_score, return_score, drawdown_score, stability_score')
      .eq('source', resolved.platform)
      .eq('source_trader_id', resolved.traderKey)
      .eq('season_id', '90D')
      .maybeSingle()

    if (traderError || !traderScores) {
      return error('Trader not found', 404)
    }

    // 确定同类类型（futures/spot/web3）
    let categoryFilter: string
    if (resolved.platform.includes('web3')) {
      categoryFilter = 'web3'
    } else if (resolved.platform.includes('spot')) {
      categoryFilter = 'spot'
    } else {
      categoryFilter = 'futures'
    }

    // Get total count in category — estimated (see comment in
    // calculatePercentileSQL above; this is the "you're ranked X out of
    // ~N futures traders" display, approximate N is fine)
    const { count: totalInCategory } = await supabase
      .from('leaderboard_ranks')
      .select('id', { count: 'estimated', head: true })
      .eq('season_id', '90D')
      .ilike('source', `%${categoryFilter}%`)
      .not('arena_score', 'is', null)

    if (!totalInCategory || totalInCategory === 0) {
      return success({
        percentile: {
          overall: 50,
          return: 50,
          drawdown: 50,
          stability: 50,
          totalInCategory: 0,
        }
      })
    }

    // Calculate all percentiles in parallel using COUNT queries (not fetching all rows)
    const [overall, returnPct, drawdown, stability] = await Promise.all([
      calculatePercentileSQL(supabase, 'arena_score', traderScores.arena_score, categoryFilter),
      calculatePercentileSQL(supabase, 'return_score', traderScores.return_score, categoryFilter),
      calculatePercentileSQL(supabase, 'drawdown_score', traderScores.drawdown_score, categoryFilter),
      calculatePercentileSQL(supabase, 'stability_score', traderScores.stability_score, categoryFilter),
    ])

    const percentile: PercentileData = {
      overall,
      return: returnPct,
      drawdown,
      stability,
      totalInCategory,
    }

    return success({ percentile, category: categoryFilter })
  } catch (err: unknown) {
    return handleError(err)
  }
}
