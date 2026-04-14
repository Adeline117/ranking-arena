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
import { fireAndForget } from '@/lib/utils/logger'
import { searchTraders } from '@/lib/data/unified'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { parseLimit } from '@/lib/utils/safe-parse'

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
    const limit = parseLimit(searchParams.get('limit'), 10, 20)

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

    const suggestions: SearchSuggestion[] = []

    // 搜索交易员 — 使用 unified data layer（内部已处理排名和去重）
    try {
      const unifiedTraders = await searchTraders(supabase, { query, limit })

      for (const t of unifiedTraders) {
        const exchangeName = EXCHANGE_CONFIG[t.platform as keyof typeof EXCHANGE_CONFIG]?.name || t.platform
        const roi = t.roi

        suggestions.push({
          type: 'trader',
          value: t.handle || t.traderKey,
          label: `@${t.handle || t.traderKey}`,
          subLabel: roi != null
            ? `${exchangeName} · ROI ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`
            : exchangeName,
          source: t.platform,
          roi: roi ?? undefined,
          arenaScore: t.arenaScore ?? undefined,
        })
      }
    } catch {
      // Trader search failure is non-critical
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
        subLabel: 'Hot trading pairs',
      })
    })

    // 如果结果太少，添加关键词搜索建议
    if (suggestions.length < 3 && query.length >= 2) {
      suggestions.push({
        type: 'keyword',
        value: query,
        label: `Search "${query}"`,
        subLabel: 'Keyword search',
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
    fireAndForget(
      supabase
        .from('search_analytics')
        .insert({
          query: query.slice(0, 200),
          result_count: suggestions.length,
          source: 'dropdown',
        })
        .then(),
      'Record search analytics'
    )

    return success(result, 200, {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
    })
  },
  { name: 'search-suggestions', rateLimit: 'read' }
)
