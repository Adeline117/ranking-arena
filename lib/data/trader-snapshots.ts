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
  // 注意：followers 字段已废弃，不再从交易所API获取
  // 所有 trader 的粉丝数只能来源 Arena 注册用户的关注（使用 trader_follows 表统计）
  followers: number // 已废弃，保留仅为向后兼容，实际值不再使用
  pnl: number | null
  win_rate: number | null
}

export interface TraderHandle {
  source_trader_id: string
  handle: string | null
  profile_url: string | null
  // 注意：avatar_url 列不存在，只使用 profile_url 作为头像URL
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

  // 注意：不再查询 followers 字段，因为所有 trader 的粉丝数只能来源 Arena 注册用户的关注
  // 保留 followers 字段在查询中仅为了向后兼容（如果数据库表中有此列），但实际值不再使用
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, rank, roi, followers, pnl, win_rate') // followers 字段已废弃，不再使用
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
      
      // 直接查询 profile_url（头像URL存储在这里，avatar_url 列不存在）
      // 这是导入脚本存储头像URL的位置，不需要回退逻辑
      let query = supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', source)
        .in('source_trader_id', batch)
      
      let { data, error } = await query
      
      // 如果查询失败，记录错误并跳过这个batch
      if (error) {
        const hasErrorContent = !!(error.message || error.code || error.hint || error.details)
        if (hasErrorContent) {
          // 只有在真正的错误（如权限错误、网络错误等）时才记录错误
          console.error(`[trader-snapshots] ❌ ${source} handle 查询错误 (batch ${Math.floor(i / BATCH_SIZE) + 1}):`, {
            error,
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
            source,
            batchNumber: Math.floor(i / BATCH_SIZE) + 1,
            batchSize: batch.length,
            sampleIds: batch.slice(0, 5),
          })
        }
        // 无论是否有错误内容，都跳过这个batch
        continue
      }

      // 处理查询成功的情况
      if (data && Array.isArray(data)) {
        if (data.length > 0) {
          allResults.push(...data)
          
          // 记录成功查询的统计信息（仅在第一个batch记录，避免日志过多）
          const batchNum = Math.floor(i / BATCH_SIZE) + 1
          if (batchNum === 1) {
            const profileUrlCount = data.filter((item: any) => item.profile_url && item.profile_url.trim() !== '').length
            
            console.log(`[trader-snapshots] ✅ ${source} 查询成功 (batch ${batchNum}):`, {
              total: data.length,
              hasProfileUrl: profileUrlCount > 0 ? `是 (${profileUrlCount}/${data.length})` : '否',
              profileUrlCount,
              sampleData: data[0] ? {
                source_trader_id: data[0].source_trader_id,
                handle: data[0].handle || '(空)',
                profile_url: data[0].profile_url || '(空)',
                profile_url_length: data[0].profile_url?.length || 0,
              } : '无数据',
            })
          }
        } else {
          // 查询成功但没有数据，这是正常的（可能该批次没有匹配的记录）
          console.debug(`[trader-snapshots] ℹ️ ${source} batch ${Math.floor(i / BATCH_SIZE) + 1} 没有匹配的记录`)
        }
      } else if (!error && !data) {
        // 查询成功但 data 为 null，这是正常的（可能该批次没有匹配的记录）
        console.debug(`[trader-snapshots] ℹ️ ${source} batch ${Math.floor(i / BATCH_SIZE) + 1} 没有匹配的记录 (data为null)`)
      }
    }

        const handleMap = new Map<string, TraderHandle>()
        allResults.forEach((item: any) => {
          // 即使没有 handle，也保存数据（可能只有 profile_url）
          if (item && item.source_trader_id) {
            // 确保数据格式正确，匹配 TraderHandle 接口
            // 注意：只使用 profile_url（头像URL存储在这里），avatar_url 列不存在
            handleMap.set(item.source_trader_id, {
              source_trader_id: item.source_trader_id,
              handle: item.handle || null,
              profile_url: item.profile_url || null,
              // avatar_url 列不存在，所以不设置此字段
            })
          }
        })
    
      // 调试日志：输出前几个trader的数据（仅bitget，避免日志过多）
      if (handleMap.size > 0 && source === 'bitget') {
        const sampleEntries = Array.from(handleMap.entries()).slice(0, 5)
        console.log(`[trader-snapshots] 📊 ${source} handleMap 样本 (前5个):`, 
          sampleEntries.map(([id, data]) => ({
            source_trader_id: id,
            handle: data.handle || '(空)',
            profile_url: data.profile_url || '(空)',
            profile_url_length: data.profile_url?.length || 0,
            profile_url_type: typeof data.profile_url,
            profile_url_preview: data.profile_url ? data.profile_url.substring(0, 100) : '(空)',
          }))
        )
        
        // 统计有多少trader有头像URL
        const withProfileUrl = Array.from(handleMap.values()).filter(d => d.profile_url && d.profile_url.trim() !== '').length
        console.log(`[trader-snapshots] 📈 ${source} 头像URL统计:`, {
          total: handleMap.size,
          with_profile_url: withProfileUrl,
          with_profile_url_percentage: `${((withProfileUrl / handleMap.size) * 100).toFixed(1)}%`,
        })
      }

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

