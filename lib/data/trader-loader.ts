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

  // 重要：根据导入脚本的实际情况，头像URL存储在 profile_url 字段中，而不是 avatar_url
  // 导入脚本使用：profile_url: item.avatarUrl 或 profile_url: item.userPhotoUrl
  // 所以我们应该直接使用 profile_url 作为头像URL
  let avatarUrl: string | undefined = undefined
  if (handleData) {
    // 优先使用 avatar_url（如果存在且不为空）
    if (handleData.avatar_url && handleData.avatar_url.trim() !== '') {
      avatarUrl = handleData.avatar_url
    } 
    // 否则使用 profile_url（导入脚本将头像URL存储在这里）
    else if (handleData.profile_url && handleData.profile_url.trim() !== '') {
      const profileUrlStr = handleData.profile_url.trim()
      
      // 如果 profile_url 看起来像是图片URL（包含图片扩展名或图片相关的路径），直接使用
      // 例如：https://cdn.example.com/avatar.png 或 https://example.com/user/photo.jpg
      if (/\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$|#)/i.test(profileUrlStr) ||
          /\/avatar|\/photo|\/image|\/pic|\/profile.*\.(jpg|jpeg|png|gif|webp)/i.test(profileUrlStr) ||
          /userPhotoUrl|avatarUrl/i.test(profileUrlStr)) {
        avatarUrl = profileUrlStr
      } 
      // 对于 Binance/Bitget/Bybit/MEXC/CoinEx，导入脚本直接将头像URL存储在 profile_url
      // 所以即使不包含图片扩展名，如果 profile_url 存在，也应该尝试使用（可能是CDN URL）
      // 但为了安全，我们只在使用明确的图片扩展名时使用，或者对特定交易所放宽限制
      else if (source === 'binance' || source === 'binance_web3' || 
               source === 'bitget' || source === 'bybit' || 
               source === 'mexc' || source === 'coinex') {
        // 对于这些交易所，profile_url 可能就是头像URL（根据导入脚本）
        avatarUrl = profileUrlStr
      }
    }
  }
  
  // 调试日志：输出前几个trader的详细信息
  const shouldLogDetail = snapshot.source_trader_id && (
    displayHandle.includes('老') || 
    displayHandle.includes('East') || 
    displayHandle.includes('Rock') ||
    displayHandle.includes('Encryption') ||
    snapshot.source_trader_id.includes('老') ||
    snapshot.source_trader_id === 'East-Wind' ||
    !avatarUrl // 没有头像的trader也记录
  )
  
  if (shouldLogDetail) {
    console.log(`[trader-loader] 🔍 Trader "${displayHandle}" (${snapshot.source_trader_id}, ${source}):`, {
      hasHandleData: !!handleData,
      handle: handleData?.handle || '(空)',
      avatar_url: handleData?.avatar_url || '(空)',
      profile_url: handleData?.profile_url || '(空)',
      profile_url_type: typeof handleData?.profile_url,
      profile_url_length: handleData?.profile_url?.length || 0,
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

