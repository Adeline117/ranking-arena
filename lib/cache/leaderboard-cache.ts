/**
 * Leaderboard Cache — 预计算排行榜数据的 Redis 缓存层
 * 
 * Key 设计：
 *   leaderboard:90d  — 90天排行榜
 *   leaderboard:30d  — 30天排行榜  
 *   leaderboard:7d   — 7天排行榜
 * 
 * TTL: 10 分钟（cron 每5分钟刷新）
 * 数据格式：与 InitialTrader[] 完全兼容
 */

import { get, set } from '@/lib/cache/index'
import { logger } from '@/lib/logger'
import type { InitialTrader } from '@/lib/getInitialTraders'
import type { Period } from '@/lib/utils/arena-score'

const LEADERBOARD_TTL = 600 // 10 minutes

interface LeaderboardCacheData {
  traders: InitialTrader[]
  lastUpdated: string | null
  cachedAt: number
}

function periodToKey(period: Period): string {
  return `leaderboard:${period.toLowerCase()}`
}

/**
 * 从 Redis 读取预计算的排行榜
 */
export async function getCachedLeaderboard(
  period: Period,
  limit: number
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null } | null> {
  try {
    const key = periodToKey(period)
    const data = await get<LeaderboardCacheData>(key)
    
    if (!data) return null
    
    logger.info(`[LeaderboardCache] HIT ${key}, ${data.traders.length} traders cached`)
    return {
      traders: data.traders.slice(0, limit),
      lastUpdated: data.lastUpdated,
    }
  } catch (err) {
    logger.error('[LeaderboardCache] Read error:', err)
    return null
  }
}

/**
 * 将排行榜数据写入 Redis
 */
export async function setCachedLeaderboard(
  period: Period,
  traders: InitialTrader[],
  lastUpdated: string | null
): Promise<void> {
  try {
    const key = periodToKey(period)
    const data: LeaderboardCacheData = {
      traders,
      lastUpdated,
      cachedAt: Date.now(),
    }
    
    await set(key, data, { ttl: LEADERBOARD_TTL, tags: ['leaderboard'] })
    logger.info(`[LeaderboardCache] SET ${key}, ${traders.length} traders, TTL ${LEADERBOARD_TTL}s`)
  } catch (err) {
    logger.error('[LeaderboardCache] Write error:', err)
  }
}
