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
  source_type: 'futures' | 'spot' | 'web3'
  avatar_url: string | null
  arena_score: number
}

// Source type mapping - comprehensive list of all active platforms
const SOURCE_TYPE_MAP: Record<string, 'futures' | 'spot' | 'web3'> = {
  // Futures platforms
  'binance_futures': 'futures',
  'bybit': 'futures',
  'bitget_futures': 'futures',
  'okx_futures': 'futures',
  'mexc': 'futures',
  'kucoin': 'futures',
  'coinex': 'futures',
  'htx': 'futures',
  'weex': 'futures',
  'phemex': 'futures',
  'bingx': 'futures',
  'gateio': 'futures',
  'xt': 'futures',
  'pionex': 'futures',
  'lbank': 'futures',
  'blofin': 'futures',
  // Web3/DEX platforms
  'gmx': 'web3',
  'kwenta': 'web3',
  'gains': 'web3',
  'mux': 'web3',
  'okx_web3': 'web3',
  'hyperliquid': 'web3',
  'dydx': 'web3',
  // Spot platforms
  'bitget_spot': 'spot',
  'binance_spot': 'spot',
}

// All active sources for initial render (expanded to include all scraped platforms)
const PRIORITY_SOURCES = [
  // Top CEX futures (highest volume)
  'binance_futures',
  'bybit',
  'bitget_futures',
  'okx_futures',
  // Secondary CEX
  'mexc',
  'kucoin',
  'htx',
  'coinex',
  'bingx',
  'gateio',
  'phemex',
  // Web3/DEX
  'gmx',
  'hyperliquid',
  'kwenta',
  'gains',
  'okx_web3',
]

export async function getInitialTraders(
  timeRange: Period = '90D',
  limit: number = 50
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY // Fixed: was SUPABASE_SERVICE_KEY

  if (!supabaseUrl || !supabaseKey) {
    console.error('[getInitialTraders] Missing Supabase config:', { url: !!supabaseUrl, key: !!supabaseKey })
    return { traders: [], lastUpdated: null }
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    // Data quality: cap extreme ROI values in the query
    // ROI > 10000% (100x) is almost certainly data anomaly (e.g. Hyperliquid reporting lifetime ROI)
    const ROI_FILTER_CAP = 10000

    // Single optimized query: fetch top traders with high arena_score
    // Use Promise.all to parallelize snapshot and timestamp queries
    const [snapshotsResult, timestampResult] = await Promise.all([
      supabase
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
        .not('arena_score', 'is', null)
        .gt('arena_score', 0)
        .lte('roi', ROI_FILTER_CAP) // Filter out extreme ROI values
        .order('arena_score', { ascending: false, nullsFirst: false })
        .limit(limit * 2), // Fetch extra to account for duplicates

      supabase
        .from('trader_snapshots')
        .select('captured_at')
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    ])

    const { data: snapshots, error } = snapshotsResult
    const latestSnapshot = timestampResult.data

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

    // Get handles from trader_sources - parallelize with other work if needed
    const traderIds = uniqueSnapshots.map(s => s.source_trader_id)
    const { data: sources } = await supabase
      .from('trader_sources')
      .select('source_trader_id, source, handle, avatar_url')
      .in('source_trader_id', traderIds)

    const handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
    sources?.forEach(s => {
      const key = `${s.source}:${s.source_trader_id}`
      handleMap.set(key, { handle: s.handle, avatar_url: s.avatar_url })
    })

    // Build trader objects with recalculated arena_score using latest formula
    const traders: InitialTrader[] = uniqueSnapshots.map(snap => {
      const key = `${snap.source}:${snap.source_trader_id}`
      const info = handleMap.get(key) || { handle: null, avatar_url: null }

      // Normalize win_rate
      const normalizedWinRate = snap.win_rate != null
        ? (snap.win_rate <= 1 ? snap.win_rate * 100 : snap.win_rate)
        : null

      // Recalculate arena_score with the latest formula (ROI cap + confidence penalty)
      // This ensures SSR data matches what /api/traders returns
      const scoreResult = calculateArenaScore(
        {
          roi: snap.roi ?? 0,
          pnl: snap.pnl ?? 0,
          maxDrawdown: snap.max_drawdown,
          winRate: normalizedWinRate,
        },
        timeRange
      )

      return {
        id: snap.source_trader_id,
        handle: info.handle || snap.source_trader_id,
        roi: snap.roi ?? 0,
        pnl: snap.pnl ?? 0,
        win_rate: normalizedWinRate,
        max_drawdown: snap.max_drawdown,
        followers: snap.followers ?? 0,
        source: snap.source,
        source_type: SOURCE_TYPE_MAP[snap.source] || 'futures',
        avatar_url: info.avatar_url,
        arena_score: scoreResult.totalScore,
      }
    })

    // Sort by recalculated arena_score descending
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
