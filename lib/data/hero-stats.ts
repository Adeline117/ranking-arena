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
// Must be close to actual 90D ranked count (~17K) to avoid inflated display.
const DEFAULT_STATS = {
  exchangeCount: 27,
  traderCount: 17000,
}

const CACHE_KEY = 'hero-stats:v1'
const _CACHE_TTL = 3600 // 1 hour

export interface HeroStats {
  exchangeCount: number
  traderCount: number
  isDefault?: boolean
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

    // 2. 从数据库查询 (with 3s timeout — SSR must never hang)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseKey) {
      logger.warn('[getHeroStats] Missing Supabase credentials, using defaults')
      return { ...DEFAULT_STATS, isDefault: true }
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    // 使用高效的聚合查询 — 3s timeout to prevent SSR hang
    const rpcPromise = supabase.rpc('get_hero_stats').single()
    const timeoutPromise = new Promise<{ data: null; error: { code: string; message: string } }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: { code: 'TIMEOUT', message: 'SSR hero stats timeout' } }), 3000)
    )
    const { data, error } = await Promise.race([rpcPromise, timeoutPromise])

    if (error) {
      // RPC failed (not available, timeout, etc.) — use defaults immediately
      // DO NOT fall back to count(exact) which takes 25s+ and causes SSR timeout
      if (error.code === 'TIMEOUT' || error.code === 'PGRST202') {
        logger.warn(`[getHeroStats] RPC unavailable (${error.code}), using defaults`)
        return { ...DEFAULT_STATS, isDefault: true }
      }
      logger.warn(`[getHeroStats] RPC failed (${error.code}), using defaults`)
      return { ...DEFAULT_STATS, isDefault: true }
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
    return { ...DEFAULT_STATS, isDefault: true }
  }
}
