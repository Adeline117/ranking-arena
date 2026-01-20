/**
 * 交易员对比 API
 * Pro 会员功能：批量获取多个交易员数据用于对比
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  error,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { hasFeatureAccess, getFeatureLimits } from '@/lib/types/premium'

export const runtime = 'nodejs'

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
}

/**
 * GET - 获取多个交易员的对比数据
 * Query params: ids=trader1,trader2,trader3 (最多5个)
 */
export async function GET(request: NextRequest) {
  // 限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
  if (rateLimitResponse) return rateLimitResponse

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
    if (!hasFeatureAccess(tier, 'trader_comparison')) {
      return error('此功能需要 Pro 会员', 403)
    }

    // 检查配额
    const limits = getFeatureLimits(tier)
    // 可以在这里检查 comparisonReportsPerMonth 配额

    // 获取查询参数
    const { searchParams } = new URL(request.url)
    const idsParam = searchParams.get('ids')

    if (!idsParam) {
      return error('缺少 ids 参数', 400)
    }

    const traderIds = idsParam.split(',').map(id => id.trim()).filter(Boolean)

    if (traderIds.length === 0) {
      return error('至少需要一个交易员 ID', 400)
    }

    if (traderIds.length > MAX_TRADERS_TO_COMPARE) {
      return error(`最多只能对比 ${MAX_TRADERS_TO_COMPARE} 个交易员`, 400)
    }

    // 查询交易员数据
    const { data: traders, error: queryError } = await supabase
      .from('trader_sources')
      .select(`
        source_trader_id,
        source,
        roi,
        roi_7d,
        roi_30d,
        pnl,
        max_drawdown,
        win_rate,
        trades_count,
        arena_score,
        return_score,
        drawdown_score,
        stability_score,
        avatar_url
      `)
      .in('source_trader_id', traderIds)

    if (queryError) {
      console.error('[compare] 查询失败:', queryError)
      return error('获取交易员数据失败', 500)
    }

    // 获取关注数
    const { data: followCounts } = await supabase
      .from('trader_follows')
      .select('trader_id')
      .in('trader_id', traderIds)

    const followerMap = new Map<string, number>()
    if (followCounts) {
      for (const f of followCounts) {
        followerMap.set(f.trader_id, (followerMap.get(f.trader_id) || 0) + 1)
      }
    }

    // 格式化返回数据
    const compareData: TraderCompareData[] = (traders || []).map(t => ({
      id: t.source_trader_id,
      handle: t.source_trader_id, // 使用 source_trader_id 作为 handle
      source: t.source,
      roi: t.roi || 0,
      roi_7d: t.roi_7d,
      roi_30d: t.roi_30d,
      pnl: t.pnl,
      max_drawdown: t.max_drawdown,
      win_rate: t.win_rate,
      trades_count: t.trades_count,
      arena_score: t.arena_score,
      return_score: t.return_score,
      drawdown_score: t.drawdown_score,
      stability_score: t.stability_score,
      avatar_url: t.avatar_url,
      followers: followerMap.get(t.source_trader_id) || 0,
    }))

    // 按请求的 ID 顺序排序
    const sortedData = traderIds
      .map(id => compareData.find(t => t.id === id))
      .filter(Boolean) as TraderCompareData[]

    return success({
      traders: sortedData,
      requestedIds: traderIds,
      foundCount: sortedData.length,
    })
  } catch (err) {
    return handleError(err)
  }
}
