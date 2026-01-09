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
      
      // 先尝试查询包含 avatar_url 的完整字段
      let query = supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url, avatar_url')
        .eq('source', source)
        .in('source_trader_id', batch)
      
      let { data, error } = await query
      
      // 如果错误，尝试回退查询（可能是 avatar_url 列不存在）
      if (error) {
        const errorKeys = Object.keys(error || {})
        const isEmptyError = errorKeys.length === 0
        const errorStr = JSON.stringify(error || {}).toLowerCase()
        const errorMessage = (error as any)?.message?.toLowerCase() || ''
        const errorCode = (error as any)?.code || ''
        
        // 检查是否是列不存在的错误（包括空错误对象）
        // 空错误对象通常表示查询时列不存在或 RLS 策略问题
        const isColumnError = isEmptyError || 
          errorStr.includes('avatar_url') ||
          errorStr.includes('column') ||
          errorStr.includes('does not exist') ||
          errorMessage.includes('avatar_url') ||
          errorMessage.includes('column') ||
          errorMessage.includes('does not exist') ||
          errorCode === 'PGRST204' ||
          errorCode === '42703'
        
        // 如果错误对象为空，或者包含列相关错误，尝试回退查询
        if (isColumnError) {
          // 回退到不包含 avatar_url 的查询
          console.warn(`[trader-snapshots] ⚠️ ${source} avatar_url 列可能不存在（空错误对象或列错误），使用回退查询 (batch ${Math.floor(i / BATCH_SIZE) + 1})`)
          const fallbackQuery = supabase
            .from('trader_sources')
            .select('source_trader_id, handle, profile_url')
            .eq('source', source)
            .in('source_trader_id', batch)
          
          const fallbackResult = await fallbackQuery
          
          if (fallbackResult.error) {
            // 回退查询也失败，记录详细错误信息
            const errorInfo: any = {
              source,
              batchNumber: Math.floor(i / BATCH_SIZE) + 1,
              batchSize: batch.length,
              batchSample: batch.slice(0, 3),
              isEmptyError,
              originalError: error,
              originalErrorKeys: errorKeys,
              originalErrorString: JSON.stringify(error),
              originalErrorCode: errorCode,
              originalErrorMessage: errorMessage,
              fallbackError: fallbackResult.error,
              fallbackErrorKeys: Object.keys(fallbackResult.error || {}),
              fallbackErrorString: JSON.stringify(fallbackResult.error),
            }
            
            // 尝试获取错误信息
            if (fallbackResult.error && typeof fallbackResult.error === 'object') {
              errorInfo.fallbackErrorType = typeof fallbackResult.error
              if ('message' in fallbackResult.error) errorInfo.fallbackMessage = (fallbackResult.error as any).message
              if ('details' in fallbackResult.error) errorInfo.fallbackDetails = (fallbackResult.error as any).details
              if ('hint' in fallbackResult.error) errorInfo.fallbackHint = (fallbackResult.error as any).hint
              if ('code' in fallbackResult.error) errorInfo.fallbackCode = (fallbackResult.error as any).code
            }
            
            console.error(`[trader-snapshots] ❌ ${source} handle 查询错误（包含回退）(batch ${errorInfo.batchNumber}):`, errorInfo)
            continue
          }
          
          // 回退查询成功，使用回退数据（不添加 avatar_url，让它保持 undefined，这样会使用 profile_url）
          data = fallbackResult.data || null
          error = null
          console.log(`[trader-snapshots] ✅ ${source} 回退查询成功 (batch ${Math.floor(i / BATCH_SIZE) + 1}):`, fallbackResult.data?.length || 0, '条记录')
          console.log(`[trader-snapshots] 📝 回退查询示例数据:`, fallbackResult.data?.[0] ? {
            source_trader_id: fallbackResult.data[0].source_trader_id,
            handle: fallbackResult.data[0].handle,
            profile_url: fallbackResult.data[0].profile_url ? '有值' : '无值',
          } : '无数据')
        } else {
          // 其他类型的错误，记录详细信息
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
      }

      // 处理查询成功的情况
      if (data && Array.isArray(data)) {
        allResults.push(...data)
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

