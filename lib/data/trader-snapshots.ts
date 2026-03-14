/**
 * @deprecated Use `lib/data/unified.ts` instead. This file contains legacy trader snapshot
 * query functions that directly query trader_snapshots v1 and trader_sources. They are kept
 * for backward compatibility but should not be used in new code.
 *
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
  // Single query with DISTINCT ON replaces 35+ parallel queries (one per source)
  const sid = seasonId || '90D'
  const { data } = await supabase
    .rpc('get_latest_timestamps_by_source', { p_season_id: sid })

  const timestamps: Record<TraderSource, string | null> = {} as Record<TraderSource, string | null>
  // Initialize all sources as null
  ALL_SOURCES.forEach(source => { timestamps[source] = null })
  // Fill in from query results
  if (data) {
    for (const row of data as { source: string; captured_at: string }[]) {
      if (row.source in timestamps) {
        timestamps[row.source as TraderSource] = row.captured_at
      }
    }
  }

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
  const result: Record<TraderSource, Map<string, TraderHandle>> = {} as Record<TraderSource, Map<string, TraderHandle>>
  ALL_SOURCES.forEach(source => {
    result[source] = new Map()
  })

  // Paginate to fetch ALL handles (1000 per page to stay within PostgREST limits)
  const PAGE_SIZE = 1000
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const { data } = await supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle, profile_url')
      .in('source', ALL_SOURCES)
      .range(offset, offset + PAGE_SIZE - 1)

    if (!data || data.length === 0) {
      hasMore = false
      break
    }

    for (const item of data as { source: string; source_trader_id: string; handle: string | null; profile_url: string | null }[]) {
      const source = item.source as TraderSource
      if (result[source]) {
        result[source].set(item.source_trader_id, {
          source_trader_id: item.source_trader_id,
          handle: item.handle,
          profile_url: item.profile_url,
        })
      }
    }

    if (data.length < PAGE_SIZE) {
      hasMore = false
    } else {
      offset += PAGE_SIZE
    }
  }

  return result
}
