/**
 * 交易员快照数据查询 - 优化版
 */

import { SupabaseClient } from '@supabase/supabase-js'

export type TraderSource = 'binance' | 'binance_web3' | 'bybit' | 'bitget' | 'mexc' | 'coinex' | 'okx' | 'kucoin' | 'gate'

export interface TraderSnapshot {
  source_trader_id: string
  rank: number
  roi: number
  followers: number
  pnl: number | null
  win_rate: number | null
  max_drawdown?: number | null
}

export interface TraderHandle {
  source_trader_id: string
  handle: string | null
  profile_url: string | null
}

export async function getLatestTimestamp(
  supabase: SupabaseClient,
  source: TraderSource,
  seasonId: string | null = null
): Promise<string | null> {
  let query = supabase
    .from('trader_snapshots')
    .select('captured_at')
    .eq('source', source)
    .order('captured_at', { ascending: false })
    .limit(1)

  if (seasonId) {
    query = query.eq('season_id', seasonId)
  } else {
    query = query.or('season_id.is.null,season_id.eq.90D')
  }

  const { data } = await query.maybeSingle()
  return data?.captured_at || null
}

export async function getLatestSnapshots(
  supabase: SupabaseClient,
  source: TraderSource,
  timestamp: string | null,
  seasonId: string | null = null,
  limit: number = 100
): Promise<TraderSnapshot[]> {
  if (!timestamp) return []

  let query = supabase
    .from('trader_snapshots')
    .select('source_trader_id, rank, roi, followers, pnl, win_rate, max_drawdown')
    .eq('source', source)
    .eq('captured_at', timestamp)
    .order('rank', { ascending: true })
    .limit(limit)

  if (seasonId) {
    query = query.eq('season_id', seasonId)
  } else {
    query = query.or('season_id.is.null,season_id.eq.90D')
  }

  const { data } = await query
  return (data || []) as TraderSnapshot[]
}

export async function getTraderHandles(
  supabase: SupabaseClient,
  source: TraderSource,
  traderIds: string[]
): Promise<Map<string, TraderHandle>> {
  if (traderIds.length === 0) return new Map()

  const { data } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, profile_url')
    .eq('source', source)
    .in('source_trader_id', traderIds)

  const handleMap = new Map<string, TraderHandle>()
  data?.forEach((item: TraderHandle) => {
    handleMap.set(item.source_trader_id, item)
  })
  return handleMap
}

export async function getAllLatestTimestamps(
  supabase: SupabaseClient,
  seasonId: string | null = null
): Promise<Record<TraderSource, string | null>> {
  const sources: TraderSource[] = ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex']
  const results = await Promise.all(sources.map(s => getLatestTimestamp(supabase, s, seasonId)))
  
  return {
    binance: results[0],
    binance_web3: null,
    bybit: results[1],
    bitget: results[2],
    mexc: results[6],
    coinex: results[7],
    okx: results[3],
    kucoin: results[4],
    gate: results[5],
  }
}

export async function getAllLatestSnapshots(
  supabase: SupabaseClient,
  timestamps: Record<TraderSource, string | null>,
  seasonId: string | null = null,
  limit: number = 100
): Promise<Record<TraderSource, TraderSnapshot[]>> {
  const sources: TraderSource[] = ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex']
  const results = await Promise.all(
    sources.map(s => getLatestSnapshots(supabase, s, timestamps[s], seasonId, limit))
  )

  return {
    binance: results[0],
    binance_web3: [],
    bybit: results[1],
    bitget: results[2],
    mexc: results[6],
    coinex: results[7],
    okx: results[3],
    kucoin: results[4],
    gate: results[5],
  }
}

export async function getAllTraderHandles(
  supabase: SupabaseClient
): Promise<Record<TraderSource, Map<string, TraderHandle>>> {
  // 预加载所有 handles
  const { data } = await supabase
    .from('trader_sources')
    .select('source, source_trader_id, handle, profile_url')
    .in('source', ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex'])
    .limit(1000)

  const result: Record<TraderSource, Map<string, TraderHandle>> = {
    binance: new Map(),
    binance_web3: new Map(),
    bybit: new Map(),
    bitget: new Map(),
    mexc: new Map(),
    coinex: new Map(),
    okx: new Map(),
    kucoin: new Map(),
    gate: new Map(),
  }

  data?.forEach((item: { source: string; source_trader_id: string; handle: string | null; profile_url: string | null }) => {
    const source = item.source as TraderSource
    if (result[source]) {
      result[source].set(item.source_trader_id, {
        source_trader_id: item.source_trader_id,
        handle: item.handle,
        profile_url: item.profile_url,
      })
    }
  })

  return result
}
