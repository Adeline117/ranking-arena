/**
 * 交易员快照数据查询工具
 * 提供统一的接口来查询不同数据源的交易员快照
 */

import { SupabaseClient } from '@supabase/supabase-js'

export type TraderSource = 'binance' | 'binance_web3' | 'bybit' | 'bitget' | 'mexc' | 'coinex'

export interface TraderSnapshot {
  source_trader_id: string
  rank: number
  roi: number
  followers: number
  pnl: number | null
  win_rate: number | null
}

export interface TraderHandle {
  source_trader_id: string
  handle: string | null
  profile_url: string | null
  // 注意：avatar_url 列可能不存在，使用 profile_url 作为头像URL
  avatar_url?: string | null
}

/**
 * 获取指定数据源的最新时间戳
 */
export async function getLatestTimestamp(
  supabase: SupabaseClient,
  source: TraderSource
): Promise<string | null> {
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('captured_at')
    .eq('source', source)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error(`[trader-snapshots] ❌ ${source} 时间戳查询错误:`, error)
    return null
  }

  return data?.captured_at || null
}

/**
 * 获取指定数据源的最新快照数据
 */
export async function getLatestSnapshots(
  supabase: SupabaseClient,
  source: TraderSource,
  timestamp: string | null,
  limit: number = 100
): Promise<TraderSnapshot[]> {
  if (!timestamp) {
    return []
  }

  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, rank, roi, followers, pnl, win_rate')
    .eq('source', source)
    .eq('captured_at', timestamp)
    .order('rank', { ascending: true })
    .limit(limit)

  if (error) {
    console.error(`[trader-snapshots] ❌ ${source} 快照查询错误:`, error)
    return []
  }

  return (data || []) as TraderSnapshot[]
}

/**
 * 批量获取交易员的 handle 信息
 */
export async function getTraderHandles(
  supabase: SupabaseClient,
  source: TraderSource,
  traderIds: string[]
): Promise<Map<string, TraderHandle>> {
  if (traderIds.length === 0) {
    return new Map()
  }

  try {
    // 如果 traderIds 太多，分批查询（Supabase 的 in 查询可能有数量限制）
    const BATCH_SIZE = 100
    const allResults: TraderHandle[] = []

    for (let i = 0; i < traderIds.length; i += BATCH_SIZE) {
      const batch = traderIds.slice(i, i + BATCH_SIZE)
      
      // 直接查询 profile_url（根据导入脚本，头像URL存储在这里）
      // 如果 avatar_url 列存在，也一起查询；如果不存在，回退到只查询 profile_url
      // 但为了简化，我们先直接查询 profile_url，因为导入脚本将头像URL存储在这里
      let query = supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', source)
        .in('source_trader_id', batch)
      
      let { data, error } = await query
      
      // 如果查询失败，记录详细错误信息
      if (error) {
        const errorKeys = Object.keys(error || {})
        const errorStr = JSON.stringify(error || {}).toLowerCase()
        const errorMessage = (error as any)?.message?.toLowerCase() || ''
        const errorCode = (error as any)?.code || ''
        
        const errorInfo: any = {
          source,
          batchNumber: Math.floor(i / BATCH_SIZE) + 1,
          batchSize: batch.length,
          batchSample: batch.slice(0, 3),
          errorKeys,
          errorString: JSON.stringify(error),
          errorCode,
          errorMessage,
        }
        
        // 尝试获取错误信息
        if (error && typeof error === 'object') {
          errorInfo.errorType = typeof error
          if ('message' in error) errorInfo.message = (error as any).message
          if ('details' in error) errorInfo.details = (error as any).details
          if ('hint' in error) errorInfo.hint = (error as any).hint
          if ('code' in error) errorInfo.code = (error as any).code
        } else {
          errorInfo.errorValue = error
        }
        
        console.error(`[trader-snapshots] ❌ ${source} handle 查询错误 (batch ${errorInfo.batchNumber}):`, errorInfo)
        continue
      }

      // 处理查询成功的情况
      if (data && Array.isArray(data)) {
        allResults.push(...data)
        
        // 记录成功查询的统计信息（仅在第一个batch记录，避免日志过多）
        const batchNum = Math.floor(i / BATCH_SIZE) + 1
        if (batchNum === 1) {
          const profileUrlCount = data.filter((item: any) => item.profile_url && item.profile_url.trim() !== '').length
          const avatarUrlCount = data.filter((item: any) => item.avatar_url && item.avatar_url.trim() !== '').length
          
          console.log(`[trader-snapshots] ✅ ${source} 查询成功 (batch ${batchNum}):`, {
            total: data.length,
            hasProfileUrl: profileUrlCount > 0 ? `是 (${profileUrlCount}/${data.length})` : '否',
            hasAvatarUrl: avatarUrlCount > 0 ? `是 (${avatarUrlCount}/${data.length})` : '否',
            sampleData: data[0] ? {
              source_trader_id: data[0].source_trader_id,
              handle: data[0].handle || '(空)',
              profile_url: data[0].profile_url || '(空)',
              avatar_url: data[0].avatar_url || '(空)',
            } : '无数据',
          })
        }
      } else if (!error && (!data || data.length === 0)) {
        // 查询成功但没有数据，这是正常的（可能该批次没有匹配的记录）
        console.debug(`[trader-snapshots] ℹ️ ${source} batch ${Math.floor(i / BATCH_SIZE) + 1} 没有匹配的记录`)
      }
    }

    const handleMap = new Map<string, TraderHandle>()
    allResults.forEach((item: TraderHandle) => {
      // 即使没有 handle，也保存数据（可能只有 avatar_url）
      if (item.source_trader_id) {
        handleMap.set(item.source_trader_id, item)
      }
    })

    return handleMap
  } catch (err: any) {
    console.error(`[trader-snapshots] ❌ ${source} handle 查询异常:`, {
      error: err,
      message: err?.message,
      stack: err?.stack,
      source,
      traderIdsCount: traderIds.length,
    })
    return new Map()
  }
}

/**
 * 并行获取所有数据源的最新时间戳
 */
export async function getAllLatestTimestamps(
  supabase: SupabaseClient
): Promise<Record<TraderSource, string | null>> {
  const sources: TraderSource[] = ['binance', 'binance_web3', 'bybit', 'bitget', 'mexc', 'coinex']
  
  const results = await Promise.all(
    sources.map(source => getLatestTimestamp(supabase, source))
  )

  const timestamps: Record<TraderSource, string | null> = {
    binance: results[0],
    binance_web3: results[1],
    bybit: results[2],
    bitget: results[3],
    mexc: results[4],
    coinex: results[5],
  }

  return timestamps
}

/**
 * 并行获取所有数据源的最新快照
 */
export async function getAllLatestSnapshots(
  supabase: SupabaseClient,
  timestamps: Record<TraderSource, string | null>,
  limit: number = 100
): Promise<Record<TraderSource, TraderSnapshot[]>> {
  const sources: TraderSource[] = ['binance', 'binance_web3', 'bybit', 'bitget', 'mexc', 'coinex']
  
  const results = await Promise.all(
    sources.map(source => getLatestSnapshots(supabase, source, timestamps[source], limit))
  )

  return {
    binance: results[0],
    binance_web3: results[1],
    bybit: results[2],
    bitget: results[3],
    mexc: results[4],
    coinex: results[5],
  }
}

/**
 * 并行获取所有数据源的 handle 信息
 */
export async function getAllTraderHandles(
  supabase: SupabaseClient,
  snapshots: Record<TraderSource, TraderSnapshot[]>
): Promise<Record<TraderSource, Map<string, TraderHandle>>> {
  const sources: TraderSource[] = ['binance', 'binance_web3', 'bybit', 'bitget', 'mexc', 'coinex']
  
  const results = await Promise.all(
    sources.map(source => {
      const traderIds = snapshots[source].map(s => s.source_trader_id)
      return getTraderHandles(supabase, source, traderIds)
    })
  )

  return {
    binance: results[0],
    binance_web3: results[1],
    bybit: results[2],
    bitget: results[3],
    mexc: results[4],
    coinex: results[5],
  }
}

