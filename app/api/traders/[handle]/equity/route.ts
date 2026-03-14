/**
 * 获取交易员资金曲线数据 API
 *
 * 从 trader_snapshots_v2 表聚合历史 ROI 数据，构建资金曲线
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import logger from '@/lib/logger'

export const revalidate = 60 // 1分钟，与 Cache-Control s-maxage 一致

interface EquityDataPoint {
  time: string
  value: number
}

interface PnLDataPoint {
  time: string
  value: number
}

interface DrawdownDataPoint {
  time: string
  value: number
}

interface SnapshotRow {
  roi: number | null
  pnl: number | null
  captured_at: string // mapped from created_at
  season_id: string | null // mapped from window
}

// 生成资金曲线数据
function generateEquityCurve(snapshots: SnapshotRow[], startingCapital: number = 10000): EquityDataPoint[] {
  if (!snapshots.length) return []
  
  // 按日期分组，取每天最新的数据
  const dailyMap = new Map<string, SnapshotRow>()
  
  for (const snapshot of snapshots) {
    const date = snapshot.captured_at.split('T')[0]
    const existing = dailyMap.get(date)
    if (!existing || snapshot.captured_at > existing.captured_at) {
      dailyMap.set(date, snapshot)
    }
  }
  
  // 转换为数组并排序
  const sortedDays = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
  
  // 计算累计资金曲线
  return sortedDays.map(([date, snapshot]) => {
    const roi = snapshot.roi ?? 0
    const value = startingCapital * (1 + roi / 100)
    return { time: date, value }
  })
}

// 生成每日PnL数据
function generateDailyPnL(snapshots: SnapshotRow[]): PnLDataPoint[] {
  if (!snapshots.length) return []
  
  // 按日期分组
  const dailyMap = new Map<string, SnapshotRow>()
  
  for (const snapshot of snapshots) {
    const date = snapshot.captured_at.split('T')[0]
    const existing = dailyMap.get(date)
    if (!existing || snapshot.captured_at > existing.captured_at) {
      dailyMap.set(date, snapshot)
    }
  }
  
  // 转换并计算日PnL变化
  const sortedDays = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
  
  const result: PnLDataPoint[] = []
  let previousPnL = 0
  
  for (const [date, snapshot] of sortedDays) {
    const currentPnL = snapshot.pnl ?? 0
    const dailyChange = currentPnL - previousPnL
    result.push({ time: date, value: dailyChange })
    previousPnL = currentPnL
  }
  
  return result
}

// 生成回撤数据
function generateDrawdown(equityCurve: EquityDataPoint[]): DrawdownDataPoint[] {
  if (!equityCurve.length) return []
  
  let peak = equityCurve[0].value
  
  return equityCurve.map((point) => {
    if (point.value > peak) {
      peak = point.value
    }
    const drawdown = ((point.value - peak) / peak) * 100
    return { time: point.time, value: drawdown }
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { handle } = await params
    
    if (!handle) {
      return NextResponse.json({ error: 'Handle is required' }, { status: 400 })
    }

    const decodedHandle = decodeURIComponent(handle)
    const cacheKey = `equity:${decodedHandle.toLowerCase()}`

    // 检查缓存
    type CacheType = { equity: EquityDataPoint[]; pnl: PnLDataPoint[]; drawdown: DrawdownDataPoint[] }
    const cached = getServerCache<CacheType>(cacheKey)
    if (cached) {
      const cachedResponse = NextResponse.json({ ...cached, cached: true })
      cachedResponse.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
      return cachedResponse
    }

    const supabase = getSupabaseAdmin()

    // 查找交易员 via unified resolveTrader
    const resolved = await resolveTrader(supabase, { handle })

    if (!resolved) {
      return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
    }

    const found = { traderId: resolved.traderKey, source: resolved.platform }

    // 获取历史快照数据（最近90天）from trader_snapshots_v2
    const ninetyDaysAgo = new Date()
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

    const { data: v2Snapshots, error } = await supabase
      .from('trader_snapshots_v2')
      .select('roi_pct, pnl_usd, created_at, window')
      .eq('platform', found.source)
      .eq('trader_key', found.traderId)
      .gte('created_at', ninetyDaysAgo.toISOString())
      .order('created_at', { ascending: true })
      .limit(1000)

    if (error) {
      logger.error('[Equity API] Error:', error)
      return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 })
    }

    // Map v2 fields to SnapshotRow shape used by chart generators
    const snapshotData: SnapshotRow[] = (v2Snapshots || []).map(s => ({
      roi: s.roi_pct,
      pnl: s.pnl_usd,
      captured_at: s.created_at,
      season_id: s.window,
    }))
    
    // 生成各类图表数据
    const equity = generateEquityCurve(snapshotData)
    const pnl = generateDailyPnL(snapshotData)
    const drawdown = generateDrawdown(equity)
    
    const result = { equity, pnl, drawdown }
    
    // 缓存结果
    setServerCache(cacheKey, result, CacheTTL.MEDIUM)
    
    const response = NextResponse.json({ ...result, cached: false })
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
    return response

  } catch (error: unknown) {
    logger.error('[Equity API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
