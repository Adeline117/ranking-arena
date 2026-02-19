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

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { getOrSetWithLock } from '@/lib/cache'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    
    if (!handle) {
      return NextResponse.json({ error: 'Missing handle parameter' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    const cacheKey = `trader:full:${handle}`
    const data = await getOrSetWithLock(
      cacheKey,
      async () => {
        return await fetchTraderFull(handle)
      },
      { ttl: 60, lockTtl: 10 }
    )

    if (!data) {
      return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
    }

    const response = NextResponse.json({ success: true, data })
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
    return response
  } catch (error: unknown) {
    logger.error('[API] 交易员聚合数据获取Failed:', error)
    return NextResponse.json(
      { error: 'Server error' },
      { status: 500 }
    )
  }
}

async function fetchTraderFull(handle: string) {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 1. 获取交易员基本信息
    const { data: trader, error: traderError } = await supabase
      .from('trader_sources')
      .select('id, handle, nickname, avatar_url, source, source_trader_id, bio, trading_since, created_at, updated_at')
      .eq('handle', handle)
      .eq('is_active', true)
      .single()

    if (traderError || !trader) {
      return null
    }

    const { source, source_trader_id } = trader

    // 2. 并行获取所有数据
    const [
      performanceResult,
      statsResult,
      portfolioResult,
      positionsResult,
      equityCurveResult,
      assetBreakdownResult,
    ] = await Promise.all([
      // 表现数据 (从 trader_sources 获取)
      supabase
        .from('trader_sources')
        .select('roi_7d, roi_30d, roi_90d, pnl_7d, pnl_30d, pnl_90d, arena_score, win_rate, max_drawdown, sharpe_ratio, copiers, followers, aum')
        .eq('handle', handle)
        .single(),

      // 详细统计
      supabase
        .from('trader_stats_detail')
        .select('period, sharpe_ratio, max_drawdown, copiers_pnl, winning_positions, total_positions')
        .eq('source', source)
        .eq('source_trader_id', source_trader_id)
        .order('period', { ascending: true }),

      // 当前持仓
      supabase
        .from('trader_portfolio')
        .select('symbol, direction, invested_pct, entry_price, pnl, captured_at')
        .eq('source', source)
        .eq('source_trader_id', source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(20),

      // 历史仓位 (最近50条)
      supabase
        .from('trader_position_history')
        .select('symbol, direction, entry_price, close_price, pnl, roi_pct, open_time, close_time, leverage')
        .eq('source', source)
        .eq('source_trader_id', source_trader_id)
        .order('close_time', { ascending: false })
        .limit(50),

      // 收益曲线 (30天)
      supabase
        .from('trader_equity_curve')
        .select('data_date, roi_pct, pnl_usd')
        .eq('source', source)
        .eq('source_trader_id', source_trader_id)
        .eq('period', '30D')
        .order('data_date', { ascending: true }),

      // 资产分布
      supabase
        .from('trader_asset_breakdown')
        .select('symbol, weight_pct, pnl_contribution')
        .eq('source', source)
        .eq('source_trader_id', source_trader_id)
        .eq('period', '30D')
        .order('weight_pct', { ascending: false })
        .limit(10),
    ])

    // 3. 整理表现数据
    const performance = performanceResult.data ? {
      roi_7d: performanceResult.data.roi_7d,
      roi_30d: performanceResult.data.roi_30d,
      roi_90d: performanceResult.data.roi_90d,
      pnl_7d: performanceResult.data.pnl_7d,
      pnl_30d: performanceResult.data.pnl_30d,
      pnl_90d: performanceResult.data.pnl_90d,
      arena_score: performanceResult.data.arena_score,
      win_rate: performanceResult.data.win_rate,
      max_drawdown: performanceResult.data.max_drawdown,
      sharpe_ratio: performanceResult.data.sharpe_ratio,
      copiers: performanceResult.data.copiers,
      followers: performanceResult.data.followers,
      aum: performanceResult.data.aum,
    } : {}

    // 4. 整理统计数据
    const statsMap: Record<string, unknown> = {}
    if (statsResult.data) {
      for (const stat of statsResult.data) {
        statsMap[stat.period] = {
          sharpe_ratio: stat.sharpe_ratio,
          max_drawdown: stat.max_drawdown,
          copiers_pnl: stat.copiers_pnl,
          winning_positions: stat.winning_positions,
          total_positions: stat.total_positions,
          win_rate: stat.total_positions > 0 
            ? (stat.winning_positions / stat.total_positions * 100).toFixed(1) 
            : 0,
        }
      }
    }

    // 5. 返回聚合数据
    return {
        trader: {
          id: trader.id,
          handle: trader.handle,
          nickname: trader.nickname,
          avatar_url: trader.avatar_url,
          source: trader.source,
          source_trader_id: trader.source_trader_id,
          bio: trader.bio,
          trading_since: trader.trading_since,
          created_at: trader.created_at,
          updated_at: trader.updated_at,
        },
        performance,
        stats: statsMap,
        portfolio: portfolioResult.data || [],
        positions: positionsResult.data || [],
        equityCurve: equityCurveResult.data || [],
        assetBreakdown: assetBreakdownResult.data || [],
    }
}
