/**
 * 热门搜索 API
 * 基于搜索分析数据生成真实的热门搜索建议
 */

import { withPublic } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'
import { get as cacheGet, set as cacheSet } from '@/lib/cache'

export const dynamic = 'force-dynamic'

interface TrendingSearchItem {
  query: string
  searchCount: number
  rank: number
  category?: 'trader' | 'token' | 'general'
}

interface TrendingSearchResponse {
  trending: TrendingSearchItem[]
  fallback: string[]
  lastUpdated: string
}

export const GET = withPublic(
  async ({ supabase }) => {
    const cacheKey = 'search:trending:queries'
    
    try {
      const cached = await cacheGet<TrendingSearchResponse>(cacheKey)
      if (cached) {
        return success(cached)
      }
    } catch {
      // 缓存未命中，继续查询
    }

    // 获取过去7天的热门搜索查询
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const { data: analyticsData, error } = await supabase
      .from('search_analytics')
      .select('query, result_count, created_at')
      .gte('created_at', sevenDaysAgo.toISOString())
      .gte('result_count', 1) // 至少有1个结果的搜索
      .limit(1000) // 限制查询数量

    let trending: TrendingSearchItem[] = []
    
    if (!error && analyticsData?.length) {
      // 统计搜索频次
      const queryStats = new Map<string, { count: number, totalResults: number }>()
      
      analyticsData.forEach(({ query, result_count }) => {
        if (!query || query.length < 2) return
        
        const normalizedQuery = query.toLowerCase().trim()
        if (normalizedQuery.length < 2) return
        
        const current = queryStats.get(normalizedQuery) || { count: 0, totalResults: 0 }
        current.count += 1
        current.totalResults += result_count || 0
        queryStats.set(normalizedQuery, current)
      })
      
      // 按搜索次数排序，至少被搜索3次
      const sortedQueries = Array.from(queryStats.entries())
        .filter(([_, stats]) => stats.count >= 3)
        .sort(([, a], [, b]) => {
          // 综合考虑搜索频次和结果质量
          const scoreA = a.count * 2 + (a.totalResults / a.count) * 0.1
          const scoreB = b.count * 2 + (b.totalResults / b.count) * 0.1
          return scoreB - scoreA
        })
        .slice(0, 20)
      
      trending = sortedQueries.map(([query, stats], index) => {
        // 简单的分类逻辑
        let category: TrendingSearchItem['category'] = 'general'
        if (/^[A-Z]{2,6}$/.test(query.toUpperCase())) {
          category = 'token' // BTC, ETH 等
        } else if (query.includes('@') || /binance|bybit|okx|bitget|mexc/i.test(query)) {
          category = 'trader'
        }
        
        return {
          query,
          searchCount: stats.count,
          rank: index + 1,
          category,
        }
      })
    }
    
    // 备用热门搜索（当数据不足时使用）
    const fallbackQueries = [
      'BTC', 'ETH', 'SOL', 'PEPE', 'WIF',
      'Binance', 'Bybit', 'OKX', 'Bitget',
      '合约', '现货', '期权', 'NFT', 'DeFi'
    ]
    
    const result: TrendingSearchResponse = {
      trending: trending.length >= 5 ? trending : [],
      fallback: fallbackQueries,
      lastUpdated: new Date().toISOString(),
    }
    
    // 缓存1小时
    try {
      await cacheSet(cacheKey, result, { ttl: 3600 })
    } catch {
      // 缓存写入失败非关键错误
    }
    
    return success(result, 200, {
      'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
    })
  },
  { name: 'trending-search', rateLimit: 'read' }
)