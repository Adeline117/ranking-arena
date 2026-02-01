/**
 * Server-side function to fetch initial traders for SSR
 * This reduces LCP by eliminating client-side data fetching waterfall
 */

import { createClient } from '@supabase/supabase-js'
import {
  calculateArenaScore,
  debouncedConfidence,
  ARENA_CONFIG,
  type Period,
} from '@/lib/utils/arena-score'
import { SOURCE_TYPE_MAP, PRIORITY_SOURCES } from '@/lib/constants/exchanges'

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
          arena_score,
          full_confidence_at
        `)
        .in('source', PRIORITY_SOURCES)
        .eq('season_id', timeRange)
        .not('arena_score', 'is', null)
        .gt('arena_score', 0)
        .lte('roi', ROI_FILTER_CAP) // Filter out extreme ROI values
        .order('arena_score', { ascending: false, nullsFirst: false })
        .limit(limit * 4), // Fetch 4x to account for dedup + platform diversity filtering

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

    // Dedupe by source + trader_id (keep extra for diversity filtering later)
    const seen = new Set<string>()
    const uniqueSnapshots = snapshots.filter(snap => {
      const key = `${snap.source}:${snap.source_trader_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, limit * 3)

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

    // Build trader objects with recalculated arena_score using the SAME logic as /api/traders route.
    // This prevents ranking jumps when client-side data replaces SSR data.
    // Key alignment points: debouncedConfidence
    const traders: InitialTrader[] = uniqueSnapshots.map(snap => {
      const key = `${snap.source}:${snap.source_trader_id}`
      const info = handleMap.get(key) || { handle: null, avatar_url: null }

      // Normalize win_rate
      const normalizedWinRate = snap.win_rate != null
        ? (snap.win_rate <= 1 ? snap.win_rate * 100 : snap.win_rate)
        : null

      const scoreResult = calculateArenaScore(
        {
          roi: snap.roi ?? 0,
          pnl: snap.pnl ?? 0,
          maxDrawdown: snap.max_drawdown,
          winRate: normalizedWinRate,
        },
        timeRange
      )

      // Debounced confidence — same as API route
      const effectiveConfidence = debouncedConfidence(
        scoreResult.scoreConfidence,
        snap.full_confidence_at,
      )
      const confidenceMultiplier = ARENA_CONFIG.CONFIDENCE_MULTIPLIER[effectiveConfidence]

      // Final score: raw sub-scores × confidence (matches API route exactly)
      const rawSubScores = scoreResult.returnScore + scoreResult.pnlScore +
                           scoreResult.drawdownScore + scoreResult.stabilityScore
      const finalScore = Math.round(
        Math.max(0, Math.min(100, rawSubScores * confidenceMultiplier)) * 100
      ) / 100

      return {
        id: snap.source_trader_id,
        handle: info.handle || snap.source_trader_id,
        roi: snap.roi ?? 0,
        pnl: snap.pnl ?? 0,
        win_rate: normalizedWinRate,
        max_drawdown: snap.max_drawdown,
        followers: snap.followers ?? 0,
        source: snap.source,
        source_type: SOURCE_TYPE_MAP[snap.source] || 'futures' as const,
        avatar_url: info.avatar_url,
        arena_score: finalScore,
      }
    })

    // Sort by recalculated arena_score descending
    traders.sort((a, b) => b.arena_score - a.arena_score)

    // Platform diversity: prevent any single platform from dominating the list.
    // Without this, top results are often 40-50% one platform (e.g. hyperliquid or binance_futures).
    // Rule: no platform takes more than MAX_PLATFORM_SHARE of the final list.
    const MAX_PLATFORM_SHARE = 0.30 // 30%
    const maxPerPlatform = Math.max(3, Math.ceil(limit * MAX_PLATFORM_SHARE))
    const platformCounts = new Map<string, number>()
    const diverseTraders: InitialTrader[] = []
    const overflow: InitialTrader[] = []

    for (const trader of traders) {
      const count = platformCounts.get(trader.source) || 0
      if (count < maxPerPlatform) {
        diverseTraders.push(trader)
        platformCounts.set(trader.source, count + 1)
      } else {
        overflow.push(trader)
      }
    }

    // If we have fewer than limit after diversity filter, backfill from overflow
    let finalTraders = diverseTraders.slice(0, limit)
    if (finalTraders.length < limit && overflow.length > 0) {
      finalTraders = [...finalTraders, ...overflow.slice(0, limit - finalTraders.length)]
    }

    return {
      traders: finalTraders,
      lastUpdated: latestSnapshot?.captured_at || null,
    }
  } catch (err) {
    console.error('[getInitialTraders] Exception:', err)
    return { traders: [], lastUpdated: null }
  }
}
