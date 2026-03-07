/**
 * 交易员数据加载器 - 优化版
 * 使用 Redis 分布式缓存
 */

import { SupabaseClient } from '@supabase/supabase-js'
import {
  getAllLatestTimestamps,
  getAllLatestSnapshots,
  getAllTraderHandles,
  ALL_SOURCES,
  type TraderSource,
} from './trader-snapshots'
import type { Trader } from '@/app/components/ranking/RankingTable'
import { getTradersArenaFollowersCount } from './trader-followers'
import { getOrSet, CACHE_TTL } from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('trader-loader')

// 内存缓存（作为二级缓存，减少网络请求）
let traderCache: { data: Trader[]; timestamp: number; timeRange: string } | null = null
const MEMORY_CACHE_TTL = 30 * 1000 // 内存缓存 30 秒

function snapshotToTrader(
  snapshot: { source_trader_id: string; roi: number; followers: number; pnl: number | null; win_rate: number | null; max_drawdown?: number | null; trades_count?: number | null },
  source: TraderSource,
  handleMap: Map<string, { handle: string | null; profile_url?: string | null }>,
  arenaFollowersCount: number = 0
): Trader {
  const handleData = handleMap.get(snapshot.source_trader_id)
  const displayHandle = handleData?.handle?.trim() || snapshot.source_trader_id

  const trader: Trader = {
    id: snapshot.source_trader_id,
    handle: displayHandle,
    roi: snapshot.roi ?? 0,
    pnl: snapshot.pnl ?? undefined,
    win_rate: snapshot.win_rate ?? undefined,
    max_drawdown: snapshot.max_drawdown ?? undefined,
    trades_count: snapshot.trades_count ?? undefined,
    followers: arenaFollowersCount,
    source,
    avatar_url: handleData?.profile_url?.trim() || undefined,
  }
  
  return trader
}

export async function loadAllTraders(
  supabase: SupabaseClient,
  timeRange: '7D' | '30D' | '90D' = '90D'
): Promise<Trader[]> {
  // 1. 先检查内存缓存（最快）
  if (traderCache && traderCache.timeRange === timeRange && Date.now() - traderCache.timestamp < MEMORY_CACHE_TTL) {
    return traderCache.data
  }

  // 2. 使用分布式缓存
  const cacheKey = `traders:list:${timeRange}`

  try {
    const traders = await getOrSet<Trader[]>(
      cacheKey,
      async () => {
        // 缓存未命中，从数据库加载
        return await loadTradersFromDB(supabase, timeRange)
      },
      { ttl: CACHE_TTL.TRADERS_LIST }
    )

    // 更新内存缓存
    traderCache = { data: traders, timestamp: Date.now(), timeRange }

    return traders
  } catch (redisError) {
    // Redis 失败时，直接从数据库加载
    logger.warn('Redis cache failed, falling back to DB', { error: redisError instanceof Error ? redisError.message : String(redisError) })
    return await loadTradersFromDB(supabase, timeRange)
  }
}

/**
 * 从数据库加载交易员数据（内部函数）
 */
async function loadTradersFromDB(
  supabase: SupabaseClient,
  timeRange: '7D' | '30D' | '90D'
): Promise<Trader[]> {
  try {
    const seasonId = timeRange === '90D' ? null : timeRange

    // 并行获取时间戳和handles
    const [timestamps, allHandles] = await Promise.all([
      getAllLatestTimestamps(supabase, seasonId),
      getAllTraderHandles(supabase),
    ])

    // 获取快照数据
    const snapshots = await getAllLatestSnapshots(supabase, timestamps, seasonId, 100)

    // 收集所有 trader IDs
    const allTraderIds: string[] = []
    
    for (const source of ALL_SOURCES) {
      const sourceSnapshots = snapshots[source] || []
      sourceSnapshots.forEach(s => allTraderIds.push(s.source_trader_id))
    }

    // 批量获取 Arena 粉丝数
    const arenaFollowersCounts = await getTradersArenaFollowersCount(supabase, allTraderIds)

    // 转换数据
    const traders: Trader[] = []
    
    for (const source of ALL_SOURCES) {
      const sourceSnapshots = snapshots[source] || []
      const handleMap = allHandles[source] || new Map()

      sourceSnapshots.forEach(snapshot => {
        const arenaFollowers = arenaFollowersCounts.get(snapshot.source_trader_id) || 0
        traders.push(snapshotToTrader(snapshot, source, handleMap, arenaFollowers))
      })
    }

    // 按 ROI 排序
    traders.sort((a, b) => b.roi - a.roi)

    return traders
  } catch (error) {
    logger.error('loadTradersFromDB failed', { error: error instanceof Error ? error.message : String(error) })
    throw error // Propagate to caller so UI can show error state
  }
}
