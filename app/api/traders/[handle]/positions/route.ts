/**
 * 获取交易员实时持仓数据 API
 * 
 * 从 trader_portfolio 表获取当前持仓
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'

export const revalidate = 60 // 1分钟缓存，持仓数据需要更频繁更新

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const TRADER_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex'] as const
type SourceType = typeof TRADER_SOURCES[number]

export interface LivePosition {
  id: string
  symbol: string
  direction: 'long' | 'short'
  size: number
  entryPrice: number
  markPrice: number
  pnl: number
  pnlPct: number
  leverage: number
  marginType: 'cross' | 'isolated'
  updatedAt: string
}

interface PortfolioRow {
  id: string
  symbol: string
  direction: string | null
  weight_pct: number | null
  entry_price: number | null
  mark_price: number | null
  pnl: number | null
  pnl_pct: number | null
  leverage: number | null
  margin_type: string | null
  updated_at: string
}

interface TraderSourceResult {
  source_trader_id: string
}

// 查找交易员来源 - 使用单个查询替代 N+1 循环
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findTraderSource(
  supabase: ReturnType<typeof createClient<any>>,
  handle: string
): Promise<{ traderId: string; source: SourceType } | null> {
  const decodedHandle = decodeURIComponent(handle)

  // 单个查询同时匹配 handle 或 source_trader_id
  const { data: results } = await supabase
    .from('trader_sources')
    .select('source_trader_id, source')
    .or(`handle.eq.${decodedHandle},source_trader_id.eq.${decodedHandle}`)
    .in('source', TRADER_SOURCES)
    .limit(1) as { data: Array<{ source_trader_id: string; source: SourceType }> | null }

  if (results && results.length > 0) {
    return { traderId: results[0].source_trader_id, source: results[0].source }
  }

  return null
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
    const cacheKey = `positions:${decodedHandle.toLowerCase()}`
    
    // 检查缓存（短TTL）
    const cached = getServerCache<{ positions: LivePosition[]; totalPnl: number; totalPnlPct: number }>(cacheKey)
    if (cached) {
      return NextResponse.json({ ...cached, cached: true })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    
    // 查找交易员
    const found = await findTraderSource(supabase, handle)
    
    if (!found) {
      return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
    }

    // 获取当前持仓
    const { data: portfolio, error } = await supabase
      .from('trader_portfolio')
      .select('*')
      .eq('source', found.source)
      .eq('source_trader_id', found.traderId)
      .order('updated_at', { ascending: false })
    
    if (error) {
      console.error('[Positions API] Error:', error)
      return NextResponse.json({ error: 'Failed to fetch positions' }, { status: 500 })
    }

    const portfolioData = (portfolio || []) as PortfolioRow[]
    
    // 转换数据格式
    const positions: LivePosition[] = portfolioData.map((row) => ({
      id: row.id,
      symbol: row.symbol,
      direction: row.direction === 'short' ? 'short' : 'long',
      size: row.weight_pct ?? 0,
      entryPrice: row.entry_price ?? 0,
      markPrice: row.mark_price ?? row.entry_price ?? 0,
      pnl: row.pnl ?? 0,
      pnlPct: row.pnl_pct ?? 0,
      leverage: row.leverage ?? 1,
      marginType: row.margin_type === 'isolated' ? 'isolated' : 'cross',
      updatedAt: row.updated_at,
    }))
    
    // 计算总盈亏
    const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0)
    const totalPnlPct = positions.length > 0
      ? positions.reduce((sum, p) => sum + p.pnlPct * p.size, 0) / positions.reduce((sum, p) => sum + p.size, 0)
      : 0

    const result = { positions, totalPnl, totalPnlPct }
    
    // 缓存结果（短TTL）
    setServerCache(cacheKey, result, CacheTTL.SHORT)
    
    return NextResponse.json({ ...result, cached: false })

  } catch (error: unknown) {
    console.error('[Positions API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
