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
  handleMap: Map<string, { handle: string | null; avatar_url?: string | null; profile_url?: string | null }>
): Trader {
  const handleData = handleMap.get(snapshot.source_trader_id)
  const displayHandle =
    handleData && handleData.handle && handleData.handle.trim() !== ''
      ? handleData.handle
      : snapshot.source_trader_id

  // 重要：头像URL可能存储在 avatar_url 或 profile_url 字段中
  // 导入脚本使用：
  // - Bitget: profile_url: item.avatarUrl
  // - Binance: profile_url: item.userPhotoUrl  
  // - 其他交易所: profile_url: item.avatarUrl
  // 但如果 avatar_url 列存在且有数据，优先使用它（可能是单独的头像URL字段）
  let avatarUrl: string | undefined = undefined
  if (handleData) {
    // 优先使用 avatar_url（如果存在且有值）
    if (handleData.avatar_url && handleData.avatar_url.trim() !== '') {
      avatarUrl = handleData.avatar_url.trim()
    }
    // 否则使用 profile_url（导入脚本将头像URL存储在这里）
    else if (handleData.profile_url && handleData.profile_url.trim() !== '') {
      avatarUrl = handleData.profile_url.trim()
    }
  }
  
  // 调试日志：输出前几个trader的详细信息（仅前10个，避免日志过多）
  // 注意：这里不能使用 rank，因为 rank 是在排序后才知道的，这里还没有排序
  const shouldLogDetail = snapshot.source_trader_id && (
    displayHandle.includes('老') || 
    displayHandle.includes('East') || 
    displayHandle.includes('Rock') ||
    displayHandle.includes('Encryption') ||
    displayHandle.includes('Gain') ||
    displayHandle.includes('Bedrock') ||
    snapshot.source_trader_id.includes('老') ||
    snapshot.source_trader_id === 'East-Wind' ||
    (!avatarUrl && handleMap.size > 0) // 前几个没有头像的trader也记录
  )
  
  if (shouldLogDetail) {
    console.log(`[trader-loader] 🔍 Trader "${displayHandle}" (${snapshot.source_trader_id}, ${source}):`, {
      hasHandleData: !!handleData,
      handle: handleData?.handle || '(空)',
      profile_url: handleData?.profile_url || '(空)',
      profile_url_type: typeof handleData?.profile_url,
      profile_url_length: handleData?.profile_url?.length || 0,
      avatar_url: handleData?.avatar_url || '(空)',
      final_avatar_url: avatarUrl || '(未获取)',
      final_avatar_url_type: typeof avatarUrl,
    })
  }

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

    // 调试：输出每个source的handleMap大小
    sources.forEach((source) => {
      const handleMapSize = handleMaps[source]?.size || 0
      const snapshotCount = snapshots[source]?.length || 0
      console.log(`[trader-loader] 📊 ${source}: handleMap=${handleMapSize} 条, snapshots=${snapshotCount} 条`)
    })

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
    
    // 调试：统计有多少trader有头像URL
    const withAvatarCount = tradersData.filter(t => t.avatar_url && t.avatar_url.trim() !== '').length
    console.log(`[trader-loader] ⚡ 加载耗时: ${loadTime.toFixed(0)}ms`)
    console.log(`[trader-loader] 📈 加载了 ${tradersData.length} 个交易员，其中 ${withAvatarCount} 个有头像URL`)
    
    // 输出前5名trader的头像URL（用于调试）
    if (tradersData.length > 0) {
      console.log(`[trader-loader] 🏆 前5名trader头像URL:`, 
        tradersData.slice(0, 5).map((t, idx) => ({
          rank: idx + 1,
          handle: t.handle,
          avatar_url: t.avatar_url || '(无)',
          source: t.source,
        }))
      )
    }

    return tradersData
  } catch (error) {
    logError(error, 'trader-loader')
    return []
  }
}

