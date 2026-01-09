/**
 * 交易员数据加载器
 * 提供统一的接口来加载和转换交易员数据
 */

import { SupabaseClient } from '@supabase/supabase-js'
import {
  getAllLatestTimestamps,
  getAllLatestSnapshots,
  getAllTraderHandles,
  type TraderSource,
} from './trader-snapshots'
import { logError } from '@/lib/utils/error-handler'
import type { Trader } from '@/app/components/Features/RankingTable'

/**
 * 将快照数据转换为 Trader 对象
 */
function snapshotToTrader(
  snapshot: { source_trader_id: string; roi: number; followers: number; pnl: number | null; win_rate: number | null },
  source: TraderSource,
  handleMap: Map<string, { handle: string; avatar_url?: string | null; profile_url?: string | null }>
): Trader {
  const handleData = handleMap.get(snapshot.source_trader_id)
  const displayHandle =
    handleData && handleData.handle && handleData.handle.trim() !== ''
      ? handleData.handle
      : snapshot.source_trader_id

  // 优先使用 avatar_url，如果没有则使用 profile_url（某些交易所可能将头像URL存储在 profile_url 中）
  // 注意：如果查询时没有包含 avatar_url 列，这里会是 undefined，使用 profile_url 作为后备
  const avatarUrl = handleData?.avatar_url || handleData?.profile_url || undefined

  return {
    id: snapshot.source_trader_id,
    handle: displayHandle,
    roi: snapshot.roi || 0,
    pnl: snapshot.pnl !== null && snapshot.pnl !== undefined ? snapshot.pnl : undefined,
    win_rate: snapshot.win_rate !== null && snapshot.win_rate !== undefined ? snapshot.win_rate : 0,
    volume_90d: undefined,
    avg_buy_90d: undefined,
    followers: snapshot.followers || 0,
    source,
    avatar_url: avatarUrl,
  }
}

/**
 * 加载所有交易员数据
 */
export async function loadAllTraders(supabase: SupabaseClient): Promise<Trader[]> {
  try {
    const startTime = performance.now()

    // 1. 获取所有数据源的最新时间戳
    const timestamps = await getAllLatestTimestamps(supabase)

    // 2. 获取所有数据源的最新快照
    const snapshots = await getAllLatestSnapshots(supabase, timestamps, 100)

    // 3. 获取所有数据源的 handle 信息
    const handleMaps = await getAllTraderHandles(supabase, snapshots)

    // 4. 转换数据
    const allTradersData: Trader[] = []
    const sources: TraderSource[] = ['binance', 'binance_web3', 'bybit', 'bitget', 'mexc', 'coinex']

    sources.forEach((source) => {
      snapshots[source].forEach((snapshot) => {
        const trader = snapshotToTrader(snapshot, source, handleMaps[source])
        allTradersData.push(trader)
      })
    })

    // 5. 去重和排序
    const uniqueTradersMap = new Map<string, Trader>()
    allTradersData.forEach((trader) => {
      const existing = uniqueTradersMap.get(trader.id)
      // 如果同一个交易员在多个数据源都存在，保留 ROI 更高的那个
      if (!existing || trader.roi > existing.roi) {
        uniqueTradersMap.set(trader.id, trader)
      }
    })

    const tradersData: Trader[] = Array.from(uniqueTradersMap.values())
      .sort((a, b) => b.roi - a.roi)
      .slice(0, 100) // 只保留前100名

    const loadTime = performance.now() - startTime
    console.log(`[trader-loader] ⚡ 加载耗时: ${loadTime.toFixed(0)}ms`)
    console.log(`[trader-loader] 📈 加载了 ${tradersData.length} 个交易员`)

    return tradersData
  } catch (error) {
    logError(error, 'trader-loader')
    return []
  }
}

