/**
 * 获取交易员资金曲线数据 API
 * 
 * 从 trader_snapshots 表聚合历史 ROI 数据，构建资金曲线
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import logger from '@/lib/logger'

export const revalidate = 60 // 1分钟，与 Cache-Control s-maxage 一致

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const TRADER_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex'] as const
type SourceType = typeof TRADER_SOURCES[number]

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
  captured_at: string
  season_id: string | null
}

interface TraderSourceResult {
  source_trader_id: string
}

// 查找交易员来源
async function findTraderSource(
   
   
  supabase: ReturnType<typeof createClient<any>>,
  handle: string
): Promise<{ traderId: string; source: SourceType } | null> {
  const decodedHandle = decodeURIComponent(handle)
  
  for (const sourceType of TRADER_SOURCES) {
    // 先尝试 handle
    const { data: byHandle } = await supabase
      .from('trader_sources')
      .select('source_trader_id')
      .eq('source', sourceType)
      .eq('handle', decodedHandle)
      .limit(1)
      .maybeSingle() as { data: TraderSourceResult | null }
    
    if (byHandle) {
      return { traderId: byHandle.source_trader_id, source: sourceType }
    }
    
    // 再尝试 source_trader_id
    const { data: byId } = await supabase
      .from('trader_sources')
      .select('source_trader_id')
      .eq('source', sourceType)
      .eq('source_trader_id', decodedHandle)
      .limit(1)
      .maybeSingle() as { data: TraderSourceResult | null }
    
    if (byId) {
      return { traderId: byId.source_trader_id, source: sourceType }
    }
  }
  
  return null
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
  try {
    const { handle } = await params
    
    if (!handle) {
      return NextResponse.json({ error: 'Handle is required' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
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

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    
    // 查找交易员
    const found = await findTraderSource(supabase, handle)
    
    if (!found) {
      return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
    }

    // 获取历史快照数据（最近90天）
    const ninetyDaysAgo = new Date()
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
    
    const { data: snapshots, error } = await supabase
      .from('trader_snapshots')
      .select('roi, pnl, captured_at, season_id')
      .eq('source', found.source)
      .eq('source_trader_id', found.traderId)
      .gte('captured_at', ninetyDaysAgo.toISOString())
      .order('captured_at', { ascending: true })
      .limit(1000)
    
    if (error) {
      logger.error('[Equity API] Error:', error)
      return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 })
    }

    const snapshotData = (snapshots || []) as SnapshotRow[]
    
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
