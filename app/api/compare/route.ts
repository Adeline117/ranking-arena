/**
 * 交易员对比 API
 * Pro 会员功能：批量获取多traders allowed for comparison数据用于对比
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
import { hasFeatureAccess, getFeatureLimits } from '@/lib/types/premium'
import logger from '@/lib/logger'

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
 * GET - 获取多traders allowed for comparison的对比数据
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
      return error('Pro membership required', 403)
    }

    // 检查配额
    const _limits = getFeatureLimits(tier)
    // 可以在这里检查 comparisonReportsPerMonth 配额

    // 获取查询参数
    const { searchParams } = new URL(request.url)
    const idsParam = searchParams.get('ids')

    if (!idsParam) {
      return error('Missing ids parameter', 400)
    }

    const traderIds = idsParam.split(',').map(id => id.trim()).filter(Boolean)

    if (traderIds.length === 0) {
      return error('At least one trader ID is required', 400)
    }

    if (traderIds.length > MAX_TRADERS_TO_COMPARE) {
      return error(`Maximum ${MAX_TRADERS_TO_COMPARE} traders allowed for comparison`, 400)
    }

    // 查询交易员来源信息 (handle, avatar_url)
    const { data: sources, error: sourcesError } = await supabase
      .from('trader_sources')
      .select('source_trader_id, source, handle, avatar_url')
      .in('source_trader_id', traderIds)

    if (sourcesError) {
      logger.error('[compare] 查询 trader_sources Failed:', sourcesError)
      return error('Failed to fetch trader data', 500)
    }

    // 查询交易员快照数据 (performance metrics)
    const { data: snapshots, error: snapshotsError } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, source, roi, pnl, win_rate, max_drawdown, trades_count, arena_score, profitability_score, risk_control_score, execution_score, arena_score_v3')
      .in('source_trader_id', traderIds)
      .order('captured_at', { ascending: false })

    if (snapshotsError) {
      logger.error('[compare] 查询 trader_snapshots Failed:', snapshotsError)
      return error('Failed to fetch trader data', 500)
    }

    // Deduplicate snapshots - keep latest per trader
    const snapshotMap = new Map<string, typeof snapshots[0]>()
    for (const snap of (snapshots || [])) {
      if (!snapshotMap.has(snap.source_trader_id)) {
        snapshotMap.set(snap.source_trader_id, snap)
      }
    }

    // Build source map
    const sourceMap = new Map<string, typeof sources[0]>()
    for (const src of (sources || [])) {
      if (!sourceMap.has(src.source_trader_id)) {
        sourceMap.set(src.source_trader_id, src)
      }
    }

    // Fallback: query leaderboard_ranks for display_name when trader_sources has no handle
    const missingHandleIds = traderIds.filter(id => {
      const src = sourceMap.get(id)
      return !src?.handle
    })
    if (missingHandleIds.length > 0) {
      const { data: lrRows } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, display_name, source, avatar_url')
        .in('source_trader_id', missingHandleIds)
        .not('display_name', 'is', null)
        .limit(missingHandleIds.length)
      for (const lr of (lrRows || [])) {
        if (!sourceMap.has(lr.source_trader_id)) {
          sourceMap.set(lr.source_trader_id, {
            source_trader_id: lr.source_trader_id,
            source: lr.source,
            handle: lr.display_name,
            avatar_url: lr.avatar_url,
          })
        } else {
          const existing = sourceMap.get(lr.source_trader_id)!
          if (!existing.handle && lr.display_name) {
            existing.handle = lr.display_name
          }
          if (!existing.avatar_url && lr.avatar_url) {
            existing.avatar_url = lr.avatar_url
          }
        }
      }
    }

    // 获取关注数 — per-trader count queries in parallel (max 5 traders)
    const followerMap = new Map<string, number>()
    const countResults = await Promise.all(
      traderIds.map(async (id) => {
        const { count } = await supabase
          .from('trader_follows')
          .select('id', { count: 'exact', head: true })
          .eq('trader_id', id)
        return { id, count: count || 0 }
      })
    )
    for (const { id, count } of countResults) {
      followerMap.set(id, count)
    }

    // 格式化返回数据
    const compareData: TraderCompareData[] = traderIds
      .map(id => {
        const src = sourceMap.get(id)
        const snap = snapshotMap.get(id)
        if (!src && !snap) return null
        return {
          id,
          handle: src?.handle || id,
          source: src?.source || snap?.source || '',
          roi: snap?.roi || 0,
          pnl: snap?.pnl,
          max_drawdown: snap?.max_drawdown,
          win_rate: snap?.win_rate,
          trades_count: snap?.trades_count,
          arena_score: snap?.arena_score_v3 || snap?.arena_score,
          avatar_url: src?.avatar_url,
          followers: followerMap.get(id) || 0,
        }
      })
      .filter(Boolean) as TraderCompareData[]

    // 按请求的 ID 顺序排序
    const sortedData = traderIds
      .map(id => compareData.find(t => t.id === id))
      .filter(Boolean) as TraderCompareData[]

    return success({
      traders: sortedData,
      requestedIds: traderIds,
      foundCount: sortedData.length,
    })
  } catch (err: unknown) {
    return handleError(err)
  }
}
