/**
 * 获取交易员实时持仓数据 API
 * 
 * 从 trader_portfolio 表获取当前持仓
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import logger from '@/lib/logger'

export const revalidate = 60 // 1分钟缓存，持仓数据需要更频繁更新

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
    const cacheKey = `positions:${decodedHandle.toLowerCase()}`

    // 检查缓存（短TTL）
    const cached = getServerCache<{ positions: LivePosition[]; totalPnl: number; totalPnlPct: number }>(cacheKey)
    if (cached) {
      const cachedResponse = NextResponse.json({ ...cached, cached: true })
      cachedResponse.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120')
      return cachedResponse
    }

    const supabase = getSupabaseAdmin()

    // 查找交易员 via unified resolveTrader
    const resolved = await resolveTrader(supabase, { handle })

    if (!resolved) {
      return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
    }

    const found = { traderId: resolved.traderKey, source: resolved.platform }

    // 获取当前持仓
    const { data: portfolio, error } = await supabase
      .from('trader_portfolio')
      .select('id, symbol, direction, weight_pct, entry_price, mark_price, pnl, pnl_pct, leverage, margin_type, updated_at')
      .eq('source', found.source)
      .eq('source_trader_id', found.traderId)
      .order('updated_at', { ascending: false })
      .limit(500)
    
    if (error) {
      // Gracefully handle missing table
      const msg = error.message || ''
      if (error.code === '42P01' || msg.includes('does not exist')) {
        return NextResponse.json({ positions: [], totalPnl: 0, totalPnlPct: 0, cached: false })
      }
      logger.error('[Positions API] Error:', error)
      return NextResponse.json({ error: 'Failed to fetch positions', detail: msg }, { status: 500 })
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
    const totalSize = positions.reduce((sum, p) => sum + p.size, 0)
    const totalPnlPct = positions.length > 0 && totalSize > 0
      ? positions.reduce((sum, p) => sum + p.pnlPct * p.size, 0) / totalSize
      : 0

    const result = { positions, totalPnl, totalPnlPct }
    
    // 缓存结果（短TTL）
    setServerCache(cacheKey, result, CacheTTL.SHORT)
    
    const response = NextResponse.json({ ...result, cached: false })
    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120')
    return response

  } catch (error: unknown) {
    logger.error('[Positions API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
