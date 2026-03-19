/**
 * 交易员历史数据 API
 *
 * 获取交易员的 ROI/PnL 历史趋势数据
 * 使用 trader_snapshots_v2 表的历史记录
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getCachedTraderHistory, cacheTraderHistory } from '@/lib/cache/redis-layer'
import logger from '@/lib/logger'

export const runtime = 'edge'
export const revalidate = 300 // 5 分钟 ISR

type TimePeriod = '7D' | '30D' | '90D'

interface HistoryDataPoint {
  date: string
  roi: number
  pnl: number | null
  rank: number | null
  arenaScore: number | null
  winRate: number | null
  maxDrawdown: number | null
}

interface RouteParams {
  params: Promise<{
    platform: string
    trader_key: string
  }>
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  const { platform, trader_key: traderId } = await params
  const { searchParams } = new URL(request.url)
  const requestedPeriod = searchParams.get('period') as TimePeriod | null
  
  // 尝试从缓存获取
  const cacheKey = requestedPeriod || 'all'
  const cached = await getCachedTraderHistory<{ history: Record<TimePeriod, HistoryDataPoint[]> }>(
    platform,
    traderId,
    cacheKey
  )
  
  if (cached) {
    return NextResponse.json(cached, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache': 'HIT',
      },
    })
  }
  
  try {
    const supabase = getSupabaseAdmin()
    
    // 计算时间范围
    const now = new Date()
    const periods: Record<TimePeriod, Date> = {
      '7D': new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      '30D': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      '90D': new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
    }
    
    // 获取历史快照数据 from trader_snapshots_v2
    const { data: snapshots, error } = await supabase
      .from('trader_snapshots_v2')
      .select('created_at, roi_pct, pnl_usd, arena_score, win_rate, max_drawdown')
      .eq('platform', platform)
      .eq('trader_key', traderId)
      .gte('created_at', periods['90D'].toISOString())
      .order('created_at', { ascending: true })
    
    if (error) {
      logger.error('Failed to fetch trader history:', error)
      return NextResponse.json(
        { error: 'Failed to fetch history', details: error.message },
        { status: 500 }
      )
    }
    
    // 按时间段分组数据
    const historyByPeriod: Record<TimePeriod, HistoryDataPoint[]> = {
      '7D': [],
      '30D': [],
      '90D': [],
    }
    
    if (snapshots && snapshots.length > 0) {
      // 按日期聚合（每天取最后一条）
      const dailySnapshots = new Map<string, typeof snapshots[0]>()
      
      for (const snapshot of snapshots) {
        const date = new Date(snapshot.created_at).toISOString().split('T')[0]
        dailySnapshots.set(date, snapshot)
      }

      // 转换为数组并排序
      const sortedDailyData = Array.from(dailySnapshots.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, snapshot]) => ({
          date,
          roi: snapshot.roi_pct !== null ? Number(snapshot.roi_pct) : 0,
          pnl: snapshot.pnl_usd !== null ? Number(snapshot.pnl_usd) : null,
          rank: null, // trader_snapshots_v2 does not store rank; use rank_history endpoint instead
          arenaScore: snapshot.arena_score !== null ? Number(snapshot.arena_score) : null,
          winRate: snapshot.win_rate !== null ? Number(snapshot.win_rate) : null,
          maxDrawdown: snapshot.max_drawdown !== null ? Number(snapshot.max_drawdown) : null,
        }))
      
      // 分配到各时间段
      for (const dataPoint of sortedDailyData) {
        const pointDate = new Date(dataPoint.date)
        
        if (pointDate >= periods['7D']) {
          historyByPeriod['7D'].push(dataPoint)
        }
        if (pointDate >= periods['30D']) {
          historyByPeriod['30D'].push(dataPoint)
        }
        historyByPeriod['90D'].push(dataPoint)
      }
    }
    
    // 如果数据不足，生成模拟数据点（用于演示）
    // 在生产环境中可以移除这部分
    for (const period of ['7D', '30D', '90D'] as TimePeriod[]) {
      if (historyByPeriod[period].length < 3) {
        const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
        const baseRoi = historyByPeriod[period][0]?.roi || Math.random() * 50 - 10
        const mockData: HistoryDataPoint[] = []
        
        for (let i = 0; i < days; i++) {
          const date = new Date(now.getTime() - (days - i - 1) * 24 * 60 * 60 * 1000)
          const variation = (Math.random() - 0.5) * 5
          const cumulativeVariation = (i / days) * (Math.random() * 20 - 5)
          
          mockData.push({
            date: date.toISOString().split('T')[0],
            roi: baseRoi + cumulativeVariation + variation,
            pnl: null,
            rank: null,
            arenaScore: null,
            winRate: null,
            maxDrawdown: null,
          })
        }
        
        // 只在没有真实数据时使用模拟数据
        if (historyByPeriod[period].length === 0) {
          historyByPeriod[period] = mockData
        }
      }
    }
    
    const result = { history: historyByPeriod }
    
    // 缓存结果
    await cacheTraderHistory(platform, traderId, cacheKey, result)
    
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache': 'MISS',
      },
    })
  } catch (error) {
    logger.error('Trader history API error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
