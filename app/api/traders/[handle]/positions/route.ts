/**
 * 获取交易员实时持仓数据 API
 *
 * 从 trader_portfolio 表获取当前持仓
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import logger from '@/lib/logger'

export const revalidate = 60 // 1分钟缓存，持仓数据需要更频繁更新

export interface LivePosition {
  id: string
  symbol: string
  direction: 'long' | 'short'
  size: number | null
  entryPrice: number | null
  markPrice: number | null
  pnl: number | null
  pnlPct: number | null
  leverage: number
  marginType: 'cross' | 'isolated'
  updatedAt: string
}

// trader_positions_live 行(实时持仓表)——旧代码查 trader_portfolio(快照表)是查错表:
// portfolio 只有 invested_pct/pnl/entry_price,没有 mark_price/leverage/pnl_pct 等实时字段。
interface PortfolioRow {
  id: string
  symbol: string
  side: string | null
  quantity: number | null
  entry_price: number | null
  mark_price: number | null
  unrealized_pnl: number | null
  unrealized_pnl_pct: number | null
  leverage: number | null
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
    const cached = getServerCache<{
      positions: LivePosition[]
      totalPnl: number
      totalPnlPct: number
    }>(cacheKey)
    if (cached) {
      const cachedResponse = NextResponse.json({ ...cached, cached: true })
      cachedResponse.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120')
      return cachedResponse
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

    // 查找交易员 via unified resolveTrader
    const resolved = await resolveTrader(supabase, { handle })

    if (!resolved) {
      return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
    }

    const found = { traderId: resolved.traderKey, source: resolved.platform }

    // 获取当前持仓——trader_positions_live(实时持仓表,键 trader_key+platform)
    const { data: portfolio, error } = await supabase
      .from('trader_positions_live')
      .select(
        'id, symbol, side, quantity, entry_price, mark_price, unrealized_pnl, unrealized_pnl_pct, leverage, updated_at'
      )
      .eq('platform', found.source)
      .eq('trader_key', found.traderId)
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
      direction: row.side === 'short' ? 'short' : 'long',
      size: row.quantity ?? null,
      entryPrice: row.entry_price ?? null,
      markPrice: row.mark_price ?? row.entry_price ?? null,
      pnl: row.unrealized_pnl ?? null,
      pnlPct: row.unrealized_pnl_pct ?? null,
      leverage: row.leverage ?? 1,
      marginType: 'cross', // trader_positions_live 无 margin_type 列(有 margin 金额)——默认 cross
      updatedAt: row.updated_at,
    }))

    // 计算总盈亏
    const totalPnl = positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0)
    const totalSize = positions.reduce((sum, p) => sum + (p.size ?? 0), 0)
    const totalPnlPct =
      positions.length > 0 && totalSize > 0
        ? positions.reduce((sum, p) => sum + (p.pnlPct ?? 0) * (p.size ?? 0), 0) / totalSize
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
