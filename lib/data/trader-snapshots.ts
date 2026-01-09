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

  const { data, error } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, profile_url')
    .eq('source', source)
    .in('source_trader_id', traderIds)

  if (error) {
    console.error(`[trader-snapshots] ❌ ${source} handle 查询错误:`, error)
    return new Map()
  }

  const handleMap = new Map<string, TraderHandle>()
  ;(data || []).forEach((item: TraderHandle) => {
    if (item.handle && item.handle.trim() !== '') {
      handleMap.set(item.source_trader_id, item)
    }
  })

  return handleMap
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

