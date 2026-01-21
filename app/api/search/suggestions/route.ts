/**
 * 搜索建议 API
 * 提供交易员、交易对等的实时搜索建议
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

interface SearchSuggestion {
  type: 'trader' | 'symbol' | 'keyword'
  value: string
  label: string
  subLabel?: string
  avatar?: string | null
  source?: string
  roi?: number
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    const searchParams = request.nextUrl.searchParams
    const query = searchParams.get('q')?.trim()
    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 20)

    if (!query || query.length < 1) {
      return success({ suggestions: [] })
    }

    const suggestions: SearchSuggestion[] = []

    // 搜索交易员（从 trader_sources 表）
    const { data: traders } = await supabase
      .from('trader_sources')
      .select('source_trader_id, handle, source, profile_url')
      .or(`handle.ilike.%${query}%,source_trader_id.ilike.%${query}%`)
      .limit(limit)

    if (traders?.length) {
      // 获取这些交易员的最新快照数据（ROI）
      const traderIds = traders.map(t => t.source_trader_id)
      const { data: snapshots } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, source, roi, season_id')
        .in('source_trader_id', traderIds)
        .eq('season_id', '90D')
        .order('captured_at', { ascending: false })

      // 构建 ROI 映射
      const roiMap = new Map<string, number>()
      snapshots?.forEach(s => {
        const key = `${s.source}:${s.source_trader_id}`
        if (!roiMap.has(key)) {
          roiMap.set(key, s.roi)
        }
      })

      // 交易所名称映射
      const sourceLabels: Record<string, string> = {
        'binance_futures': 'Binance',
        'binance_spot': 'Binance',
        'binance_web3': 'Binance',
        'bybit': 'Bybit',
        'bitget_futures': 'Bitget',
        'bitget_spot': 'Bitget',
        'mexc': 'MEXC',
        'coinex': 'CoinEx',
        'okx_web3': 'OKX',
        'kucoin': 'KuCoin',
        'gmx': 'GMX',
      }

      traders.forEach(trader => {
        const key = `${trader.source}:${trader.source_trader_id}`
        const roi = roiMap.get(key)
        const exchangeName = sourceLabels[trader.source] || trader.source

        suggestions.push({
          type: 'trader',
          value: trader.handle || trader.source_trader_id,
          label: `@${trader.handle || trader.source_trader_id}`,
          subLabel: roi !== undefined
            ? `${exchangeName} · ROI ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`
            : exchangeName,
          avatar: trader.profile_url,
          source: trader.source,
          roi,
        })
      })
    }

    // 添加交易对建议（常见的）
    const commonSymbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'PEPE', 'WIF', 'ARB', 'OP', 'AVAX', 'MATIC']
    const matchedSymbols = commonSymbols.filter(s =>
      s.toLowerCase().includes(query.toLowerCase())
    )

    matchedSymbols.slice(0, 3).forEach(symbol => {
      suggestions.push({
        type: 'symbol',
        value: symbol,
        label: `${symbol}/USDT`,
        subLabel: '热门交易对',
      })
    })

    // 如果结果太少，添加关键词搜索建议
    if (suggestions.length < 3 && query.length >= 2) {
      suggestions.push({
        type: 'keyword',
        value: query,
        label: `搜索 "${query}"`,
        subLabel: '关键词搜索',
      })
    }

    // 按类型排序：交易员优先，然后是交易对，最后是关键词
    suggestions.sort((a, b) => {
      const order = { trader: 0, symbol: 1, keyword: 2 }
      return order[a.type] - order[b.type]
    })

    return success({
      suggestions: suggestions.slice(0, limit),
      query,
    })
  },
  { name: 'search-suggestions', rateLimit: 'read' }
)
