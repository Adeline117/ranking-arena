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
import { hasFeatureAccess } from '@/lib/types/premium'
import logger from '@/lib/logger'

export const runtime = 'nodejs'

interface PercentileData {
  overall: number      // 总分百分位
  return: number       // 收益分百分位
  drawdown: number     // 回撤分百分位
  stability: number    // 稳定分百分位
  totalInCategory: number  // 同类交易员总数
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
      return error('此功能需要 Pro 会员', 403)
    }

    // 解析参数
    const resolvedParams = await params
    const handle = decodeURIComponent(resolvedParams.handle)

    // 获取该交易员的数据
    const { data: trader, error: traderError } = await supabase
      .from('trader_sources')
      .select('source_trader_id, source, arena_score, return_score, drawdown_score, stability_score')
      .eq('source_trader_id', handle)
      .maybeSingle()

    if (traderError || !trader) {
      return error('找不到该交易员', 404)
    }

    // 确定同类类型（futures/spot/web3）
    let categoryFilter: string
    if (trader.source.includes('web3')) {
      categoryFilter = 'web3'
    } else if (trader.source.includes('spot')) {
      categoryFilter = 'spot'
    } else {
      categoryFilter = 'futures'
    }

    // 获取同类交易员的分数分布
    const { data: categoryTraders, error: catError } = await supabase
      .from('trader_sources')
      .select('arena_score, return_score, drawdown_score, stability_score')
      .or(`source.ilike.%${categoryFilter}%`)
      .not('arena_score', 'is', null)

    if (catError) {
      logger.error('[percentile] 查询同类交易员失败:', catError)
      return error('获取分位数据失败', 500)
    }

    const totalInCategory = categoryTraders?.length || 0

    if (totalInCategory === 0) {
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

    // 计算百分位
    const calculatePercentile = (myScore: number | null, allScores: (number | null)[]): number => {
      if (myScore == null) return 50
      const validScores = allScores.filter(s => s != null) as number[]
      if (validScores.length === 0) return 50
      
      const countBelow = validScores.filter(s => s < myScore).length
      return Math.round((countBelow / validScores.length) * 100)
    }

    const percentile: PercentileData = {
      overall: calculatePercentile(trader.arena_score, categoryTraders.map(t => t.arena_score)),
      return: calculatePercentile(trader.return_score, categoryTraders.map(t => t.return_score)),
      drawdown: calculatePercentile(trader.drawdown_score, categoryTraders.map(t => t.drawdown_score)),
      stability: calculatePercentile(trader.stability_score, categoryTraders.map(t => t.stability_score)),
      totalInCategory,
    }

    return success({ percentile, category: categoryFilter })
  } catch (err: unknown) {
    return handleError(err)
  }
}
