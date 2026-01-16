/**
 * 交易员列表服务端组件
 * 在服务端获取数据，减少客户端 JS 体积和请求
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import * as cache from '@/lib/cache'
import { CacheKey, CACHE_TTL } from '@/lib/cache'

export interface TraderData {
  id: string
  handle: string
  roi: number
  winRate: number
  source: string
  followers?: number
  rank: number
}

interface TraderListServerProps {
  timeRange?: '7D' | '30D' | '90D'
  limit?: number
  exchange?: string
}

/**
 * 从服务端获取交易员排行榜数据
 */
export async function getTraderListData(options: TraderListServerProps = {}): Promise<TraderData[]> {
  const { timeRange = '90D', limit = 20, exchange } = options
  const cacheKey = CacheKey.traders.list({ timeRange, exchange, limit, page: 0 })

  // 尝试从缓存获取
  const cached = await cache.get<TraderData[]>(cacheKey)
  if (cached) {
    return cached
  }

  try {
    const supabase = getSupabaseAdmin()
    
    // 构建查询
    let query = supabase
      .from('trader_snapshots')
      .select(`
        source_trader_id,
        roi,
        win_rate,
        source,
        trader_sources!inner(handle, profile_url)
      `)
      .order('roi', { ascending: false })
      .limit(limit)

    // 根据时间范围过滤
    if (timeRange === '7D') {
      query = query.eq('season_id', '7D')
    } else if (timeRange === '30D') {
      query = query.eq('season_id', '30D')
    } else {
      query = query.or('season_id.is.null,season_id.eq.90D')
    }

    // 按交易所过滤
    if (exchange && exchange !== 'all') {
      query = query.eq('source', exchange)
    }

    const { data, error } = await query

    if (error) {
      console.error('[TraderListServer] Query error:', error)
      return []
    }

    // 转换数据格式
    const traders: TraderData[] = (data || []).map((item, index) => {
      // trader_sources 可能是数组或单个对象
      const traderSource = Array.isArray(item.trader_sources) 
        ? item.trader_sources[0] 
        : item.trader_sources
      return {
        id: item.source_trader_id,
        handle: (traderSource as { handle?: string } | null)?.handle || item.source_trader_id,
        roi: item.roi || 0,
        winRate: item.win_rate || 0,
        source: item.source,
        rank: index + 1,
      }
    })

    // 缓存结果
    await cache.set(cacheKey, traders, { ttl: CACHE_TTL.TRADERS_LIST })

    return traders
  } catch (error) {
    console.error('[TraderListServer] Error:', error)
    return []
  }
}

/**
 * 服务端组件 - 预渲染交易员列表数据
 * 可以与客户端组件配合使用
 */
export default async function TraderListServer({
  timeRange = '90D',
  limit = 20,
  exchange,
}: TraderListServerProps) {
  const traders = await getTraderListData({ timeRange, limit, exchange })
  
  // 返回 JSON 数据用于 hydration
  return (
    <script
      id="trader-list-data"
      type="application/json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({ traders, timeRange, exchange }),
      }}
    />
  )
}
