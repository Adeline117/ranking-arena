/**
 * 交易员快照数据查询 - 优化版
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { ALL_SOURCES, type TraderSource } from '@/lib/constants/exchanges'

// Re-export from shared constants for backward compatibility
export { ALL_SOURCES, type TraderSource } from '@/lib/constants/exchanges'

export interface TraderSnapshot {
  source_trader_id: string
  rank: number
  roi: number
  followers: number
  pnl: number | null
  win_rate: number | null
  max_drawdown?: number | null
  trades_count?: number | null
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

  // 统一使用 season_id 查询，默认为 '90D'
  query = query.eq('season_id', seasonId || '90D')

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
    .select('source_trader_id, rank, roi, followers, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', source)
    .eq('captured_at', timestamp)
    .order('rank', { ascending: true })
    .limit(limit)

  // 统一使用 season_id 查询，默认为 '90D'
  query = query.eq('season_id', seasonId || '90D')

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
  const results = await Promise.all(ALL_SOURCES.map(s => getLatestTimestamp(supabase, s, seasonId)))
  
  const timestamps: Record<TraderSource, string | null> = {} as Record<TraderSource, string | null>
  ALL_SOURCES.forEach((source, index) => {
    timestamps[source] = results[index]
  })
  
  return timestamps
}

export async function getAllLatestSnapshots(
  supabase: SupabaseClient,
  timestamps: Record<TraderSource, string | null>,
  seasonId: string | null = null,
  limit: number = 100
): Promise<Record<TraderSource, TraderSnapshot[]>> {
  const results = await Promise.all(
    ALL_SOURCES.map(s => getLatestSnapshots(supabase, s, timestamps[s], seasonId, limit))
  )

  const snapshots: Record<TraderSource, TraderSnapshot[]> = {} as Record<TraderSource, TraderSnapshot[]>
  ALL_SOURCES.forEach((source, index) => {
    snapshots[source] = results[index]
  })
  
  return snapshots
}

export async function getAllTraderHandles(
  supabase: SupabaseClient
): Promise<Record<TraderSource, Map<string, TraderHandle>>> {
  // 预加载所有 handles
  const { data } = await supabase
    .from('trader_sources')
    .select('source, source_trader_id, handle, profile_url')
    .in('source', ALL_SOURCES)
    .limit(1500)

  const result: Record<TraderSource, Map<string, TraderHandle>> = {} as Record<TraderSource, Map<string, TraderHandle>>
  ALL_SOURCES.forEach(source => {
    result[source] = new Map()
  })

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
