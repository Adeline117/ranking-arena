/**
 * 搜索建议 API
 * 提供交易员、交易对等的实时搜索建议
 * - Redis 缓存热门查询 (TTL 60s)
 * - PostgreSQL pg_trgm 模糊匹配
 * - 搜索分析日志
 */

import { withPublic } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'
import { get as cacheGet, set as cacheSet } from '@/lib/cache'

export const dynamic = 'force-dynamic'

interface SearchSuggestion {
  type: 'trader' | 'symbol' | 'keyword'
  value: string
  label: string
  subLabel?: string
  avatar?: string | null
  source?: string
  roi?: number
  arenaScore?: number
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    const searchParams = request.nextUrl.searchParams
    const query = searchParams.get('q')?.trim()
    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 20)

    if (!query || query.length < 1) {
      return success({ suggestions: [] })
    }

    // Check Redis cache for hot queries
    const cacheKey = `search:suggestions:${query.toLowerCase().slice(0, 50)}`
    try {
      const cached = await cacheGet<{ suggestions: SearchSuggestion[]; query: string }>(cacheKey)
      if (cached) {
        return success(cached)
      }
    } catch {
      // Cache miss or error, continue with DB query
    }

    // 限制查询长度并转义 PostgREST 特殊字符，防止注入
    const sanitizedQuery = query
      .slice(0, 100)
      .replace(/[\\%_]/g, c => `\\${c}`)  // 转义 LIKE 通配符
      .replace(/[.,()]/g, '')  // 移除 PostgREST 过滤语法字符

    if (!sanitizedQuery) {
      return success({ suggestions: [] })
    }

    const suggestions: SearchSuggestion[] = []

    // 搜索交易员（从 trader_sources_v2 表，利用 pg_trgm 模糊匹配）
    const { data: traders } = await supabase
      .from('trader_sources_v2')
      .select('trader_key, display_name, platform, profile_url')
      .or(`display_name.ilike.%${sanitizedQuery}%,trader_key.ilike.%${sanitizedQuery}%`)
      .eq('is_active', true)
      .limit(limit)

    if (traders?.length) {
      // 获取最新快照数据（ROI + Arena Score）
      const traderKeys = traders.map(t => t.trader_key)
      const { data: snapshots } = await supabase
        .from('trader_snapshots_v2')
        .select('trader_key, platform, roi_pct, arena_score, window')
        .in('trader_key', traderKeys)
        .eq('window', '90d')
        .order('as_of_ts', { ascending: false })

      // 构建 ROI 和 Arena Score 映射
      const roiMap = new Map<string, number>()
      const scoreMap = new Map<string, number>()
      snapshots?.forEach(s => {
        const key = `${s.platform}:${s.trader_key}`
        if (!roiMap.has(key) && s.roi_pct != null) {
          roiMap.set(key, s.roi_pct)
        }
        if (!scoreMap.has(key) && s.arena_score != null) {
          scoreMap.set(key, s.arena_score)
        }
      })

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
        const key = `${trader.platform}:${trader.trader_key}`
        const roi = roiMap.get(key)
        const arenaScore = scoreMap.get(key)
        const exchangeName = sourceLabels[trader.platform] || trader.platform

        suggestions.push({
          type: 'trader',
          value: trader.display_name || trader.trader_key,
          label: `@${trader.display_name || trader.trader_key}`,
          subLabel: roi !== undefined
            ? `${exchangeName} · ROI ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`
            : exchangeName,
          avatar: trader.profile_url,
          source: trader.platform,
          roi,
          arenaScore,
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

    const result = {
      suggestions: suggestions.slice(0, limit),
      query,
    }

    // Cache the result for 60 seconds
    try {
      await cacheSet(cacheKey, result, { ttl: 60 })
    } catch {
      // Cache write failure is non-critical
    }

    // Log search analytics asynchronously (fire-and-forget)
    void Promise.resolve(
      supabase
        .from('search_analytics')
        .insert({
          query: query.slice(0, 200),
          result_count: suggestions.length,
          source: 'dropdown',
        })
    ).catch(() => {})

    return success(result)
  },
  { name: 'search-suggestions', rateLimit: 'read' }
)
