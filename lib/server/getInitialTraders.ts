/**
 * Server-side function to fetch initial traders for SSR
 * This reduces LCP by eliminating client-side data fetching waterfall
 */

import { createClient } from '@supabase/supabase-js'
import { calculateArenaScore, ARENA_CONFIG, type Period } from '@/lib/utils/arena-score'

// Minimal trader type for initial render
export interface InitialTrader {
  id: string
  handle: string
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  followers: number
  source: string
  avatar_url: string | null
  arena_score: number
}

// Top sources to fetch for initial render (most popular)
const PRIORITY_SOURCES = [
  'binance_futures',
  'bybit',
  'bitget_futures',
  'okx_futures',
  'hyperliquid',
]

export async function getInitialTraders(
  timeRange: Period = '90D',
  limit: number = 50
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY

  if (!supabaseUrl || !supabaseKey) {
    console.error('[getInitialTraders] Missing Supabase config')
    return { traders: [], lastUpdated: null }
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    // Get latest snapshot timestamp
    const { data: latestSnapshot } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Fetch top traders from priority sources with high arena_score
    // This is much faster than fetching all sources
    const { data: snapshots, error } = await supabase
      .from('trader_snapshots')
      .select(`
        source_trader_id,
        source,
        roi,
        pnl,
        win_rate,
        max_drawdown,
        followers,
        arena_score
      `)
      .in('source', PRIORITY_SOURCES)
      .eq('season_id', timeRange)
      .gte('arena_score', 60) // Only fetch high-score traders
      .order('arena_score', { ascending: false })
      .limit(limit * 2) // Fetch extra to account for duplicates

    if (error || !snapshots?.length) {
      console.error('[getInitialTraders] Query error:', error?.message)
      return { traders: [], lastUpdated: latestSnapshot?.captured_at || null }
    }

    // Dedupe by source + trader_id
    const seen = new Set<string>()
    const uniqueSnapshots = snapshots.filter(snap => {
      const key = `${snap.source}:${snap.source_trader_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, limit)

    // Get handles from trader_sources
    const traderIds = uniqueSnapshots.map(s => s.source_trader_id)
    const { data: sources } = await supabase
      .from('trader_sources')
      .select('source_trader_id, source, handle, profile_url')
      .in('source_trader_id', traderIds)

    const handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
    sources?.forEach(s => {
      const key = `${s.source}:${s.source_trader_id}`
      handleMap.set(key, { handle: s.handle, avatar_url: s.profile_url })
    })

    // Build trader objects
    const traders: InitialTrader[] = uniqueSnapshots.map(snap => {
      const key = `${snap.source}:${snap.source_trader_id}`
      const info = handleMap.get(key) || { handle: null, avatar_url: null }

      // Normalize win_rate
      const normalizedWinRate = snap.win_rate != null
        ? (snap.win_rate <= 1 ? snap.win_rate * 100 : snap.win_rate)
        : null

      return {
        id: snap.source_trader_id,
        handle: info.handle || snap.source_trader_id,
        roi: snap.roi ?? 0,
        pnl: snap.pnl ?? 0,
        win_rate: normalizedWinRate,
        max_drawdown: snap.max_drawdown,
        followers: snap.followers ?? 0,
        source: snap.source,
        avatar_url: info.avatar_url,
        arena_score: snap.arena_score ?? 0,
      }
    })

    // Sort by arena_score descending
    traders.sort((a, b) => b.arena_score - a.arena_score)

    return {
      traders: traders.slice(0, limit),
      lastUpdated: latestSnapshot?.captured_at || null,
    }
  } catch (err) {
    console.error('[getInitialTraders] Exception:', err)
    return { traders: [], lastUpdated: null }
  }
}
