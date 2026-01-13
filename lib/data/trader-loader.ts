/**
 * 交易员数据加载器 - 优化版
 */

import { SupabaseClient } from '@supabase/supabase-js'
import {
  getAllLatestTimestamps,
  getAllLatestSnapshots,
  getAllTraderHandles,
  type TraderSource,
} from './trader-snapshots'
import type { Trader } from '@/app/components/Features/RankingTable'
import { getTradersArenaFollowersCount } from './trader-followers'

// 内存缓存
let traderCache: { data: Trader[]; timestamp: number; timeRange: string } | null = null
const CACHE_TTL = 60 * 1000 // 1分钟缓存

function snapshotToTrader(
  snapshot: { source_trader_id: string; roi: number; followers: number; pnl: number | null; win_rate: number | null; max_drawdown?: number | null },
  source: TraderSource,
  handleMap: Map<string, { handle: string | null; profile_url?: string | null }>,
  arenaFollowersCount: number = 0
): Trader {
  const handleData = handleMap.get(snapshot.source_trader_id)
  const displayHandle = handleData?.handle?.trim() || snapshot.source_trader_id

  return {
    id: snapshot.source_trader_id,
    handle: displayHandle,
    roi: snapshot.roi || 0,
    pnl: snapshot.pnl ?? undefined,
    win_rate: snapshot.win_rate ?? 0,
    max_drawdown: snapshot.max_drawdown ?? undefined,
    followers: arenaFollowersCount,
    source,
    avatar_url: handleData?.profile_url?.trim() || undefined,
  }
}

export async function loadAllTraders(
  supabase: SupabaseClient,
  timeRange: '7D' | '30D' | '90D' = '90D'
): Promise<Trader[]> {
  // 检查缓存
  if (traderCache && traderCache.timeRange === timeRange && Date.now() - traderCache.timestamp < CACHE_TTL) {
    return traderCache.data
  }

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
    const sources: TraderSource[] = ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex']
    
    for (const source of sources) {
      const sourceSnapshots = snapshots[source] || []
      sourceSnapshots.forEach(s => allTraderIds.push(s.source_trader_id))
    }

    // 批量获取 Arena 粉丝数
    const arenaFollowersCounts = await getTradersArenaFollowersCount(supabase, allTraderIds)

    // 转换数据
    const traders: Trader[] = []
    
    for (const source of sources) {
      const sourceSnapshots = snapshots[source] || []
      const handleMap = allHandles[source] || new Map()

      sourceSnapshots.forEach(snapshot => {
        const arenaFollowers = arenaFollowersCounts.get(snapshot.source_trader_id) || 0
        traders.push(snapshotToTrader(snapshot, source, handleMap, arenaFollowers))
      })
    }

    // 按 ROI 排序
    traders.sort((a, b) => b.roi - a.roi)

    // 更新缓存
    traderCache = { data: traders, timestamp: Date.now(), timeRange }

    return traders
  } catch (error) {
    console.error('[trader-loader] 加载失败:', error)
    return []
  }
}
