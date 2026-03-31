/**
 * Hero Stats 数据层
 *
 * 获取首页展示的统计数据（交易所数量、交易员数量）
 * 使用 Redis 缓存，TTL 1 小时（数据变化不频繁）
 */

import { createClient } from '@supabase/supabase-js'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { logger } from '@/lib/logger'

// 默认值 - 当缓存和数据库都不可用时的回退
const DEFAULT_STATS = {
  exchangeCount: 34,
  traderCount: 40000,
}

const CACHE_KEY = 'hero-stats:v1'
const CACHE_TTL = 3600 // 1 hour

export interface HeroStats {
  exchangeCount: number
  traderCount: number
}

/**
 * 获取 Hero 统计数据
 *
 * 优先级：Redis 缓存 → 数据库查询 → 默认值
 * 缓存 TTL: 1 小时
 */
export async function getHeroStats(): Promise<HeroStats> {
  try {
    // 1. 尝试从缓存读取
    const { data: cached } = await tieredGet<HeroStats>(CACHE_KEY, 'warm')
    if (cached) {
      return cached
    }

    // 2. 从数据库查询
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseKey) {
      logger.warn('[getHeroStats] Missing Supabase credentials, using defaults')
      return DEFAULT_STATS
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    // 使用高效的聚合查询
    const { data, error } = await supabase
      .rpc('get_hero_stats')
      .single()

    if (error) {
      // RPC 不存在时回退到直接查询
      if (error.code === 'PGRST202') {
        const { count, error: countError } = await supabase
          .from('leaderboard_ranks')
          .select('*', { count: 'exact', head: true })

        if (countError) {
          logger.warn('[getHeroStats] Count query failed, using defaults', countError)
          return DEFAULT_STATS
        }

        // 获取 distinct sources
        const { data: sources } = await supabase
          .from('leaderboard_ranks')
          .select('source')
          .limit(100)

        const uniqueSources = new Set(sources?.map(s => s.source) || [])

        const stats: HeroStats = {
          exchangeCount: uniqueSources.size || DEFAULT_STATS.exchangeCount,
          traderCount: count || DEFAULT_STATS.traderCount,
        }

        // 缓存结果
        await tieredSet(CACHE_KEY, stats, 'warm', ['hero-stats'])
        return stats
      }

      logger.warn('[getHeroStats] RPC failed, using defaults', error)
      return DEFAULT_STATS
    }

    const rpcData = data as { exchange_count?: number; trader_count?: number } | null
    const stats: HeroStats = {
      exchangeCount: rpcData?.exchange_count || DEFAULT_STATS.exchangeCount,
      traderCount: rpcData?.trader_count || DEFAULT_STATS.traderCount,
    }

    // 3. 缓存结果
    await tieredSet(CACHE_KEY, stats, 'warm', ['hero-stats'])

    return stats
  } catch (error) {
    logger.error('[getHeroStats] Unexpected error', error)
    return DEFAULT_STATS
  }
}
