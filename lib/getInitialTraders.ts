/**
 * Server-side function to fetch initial traders for SSR
 * This reduces LCP by eliminating client-side data fetching waterfall
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  calculateArenaScore,
  debouncedConfidence,
  ARENA_CONFIG,
  type Period,
  type ScoreConfidence,
} from '@/lib/utils/arena-score'
import { SOURCE_TYPE_MAP, PRIORITY_SOURCES } from '@/lib/constants/exchanges'
import { logger } from '@/lib/logger'

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
  score_confidence: ScoreConfidence
}

export async function getInitialTraders(
  timeRange: Period = '90D',
  limit: number = 50
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  // During Vercel build, Supabase queries hang (iad1 build server → timeout).
  // Skip DB call entirely — ISR (revalidate=60) fills on first real request.
  // NEXT_PHASE is set by Next.js build process before static page generation.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return { traders: [], lastUpdated: null }
  }

  // Skip Redis cache for SSR — Upstash fetch uses cache:'no-store' which
  // forces the entire page into dynamic rendering, breaking ISR.
  // ISR (revalidate=60) handles page-level caching instead.
  // Redis cache is still used by API routes (/api/traders) which are dynamic anyway.
  return fetchLeaderboardFromDB(timeRange, limit)
}

/**
 * Direct Supabase fetch — used by cron to populate cache and as fallback.
 * Exported so the cron refresh route can call it without triggering cache reads.
 */
export async function fetchLeaderboardFromDB(
  timeRange: Period = '90D',
  limit: number = 50
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY // Fixed: was SUPABASE_SERVICE_KEY

  if (!supabaseUrl || !supabaseKey) {
    logger.error('[getInitialTraders] Missing Supabase config:', { url: !!supabaseUrl, key: !!supabaseKey })
    return { traders: [], lastUpdated: null }
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  // 15s timeout — prevents build-time static generation from hanging (Vercel kills at 60s)
  // Uses AbortController so the actual fetch is cancelled, not just the promise
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    const result = await fetchLeaderboardFromDBInner(supabase, timeRange, limit, controller.signal)
    clearTimeout(timer)
    return result
  } catch (err: unknown) {
    clearTimeout(timer)
    if ((err as any)?.name === 'AbortError' || (err as any)?.message?.includes('timeout')) {
      logger.warn('[getInitialTraders] Timed out — returning empty (ISR will fill on next request)')
    } else {
      logger.error('[getInitialTraders] Error:', err)
    }
    return { traders: [], lastUpdated: null }
  }
}

async function fetchLeaderboardFromDBInner(
  supabase: SupabaseClient,
  timeRange: Period,
  limit: number,
  signal?: AbortSignal
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
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
        .limit(limit * 2)
        .abortSignal(signal!), // Cancel if build timeout

      supabase
        .from('trader_snapshots')
        .select('captured_at')
        .order('captured_at', { ascending: false })
        .limit(1)
        .abortSignal(signal!)
        .maybeSingle()
    ])

    const { data: snapshots, error } = snapshotsResult
    const latestSnapshot = timestampResult.data

    if (error || !snapshots?.length) {
      logger.error('[getInitialTraders] Query error:', error?.message)
      return { traders: [], lastUpdated: latestSnapshot?.captured_at || null }
    }

    // Dedupe by source + trader_id (keep extra for diversity filtering later)
    const seen = new Set<string>()
    const uniqueSnapshots = snapshots.filter(snap => {
      const key = `${snap.source}:${snap.source_trader_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, limit * 2)

    // Get handles from trader_sources
    const traderIds = uniqueSnapshots.map(s => s.source_trader_id)
    // Batch in chunks of 50 to avoid URL length limits
    const sourceChunks: typeof uniqueSnapshots[] = []
    for (let i = 0; i < traderIds.length; i += 50) {
      sourceChunks.push(uniqueSnapshots.slice(i, i + 50))
    }
    const sourceResults = await Promise.all(
      sourceChunks.map(chunk =>
        supabase
          .from('trader_sources')
          .select('source_trader_id, source, handle, avatar_url')
          .in('source_trader_id', chunk.map(s => s.source_trader_id))
          .abortSignal(signal!)
      )
    )
    const sources = sourceResults.flatMap(r => r.data || [])

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

      // Normalize win_rate and validate range (0-100)
      let normalizedWinRate: number | null = null
      if (snap.win_rate != null && !isNaN(snap.win_rate)) {
        const wr = snap.win_rate <= 1 ? snap.win_rate * 100 : snap.win_rate
        normalizedWinRate = Math.max(0, Math.min(100, wr))
      }

      // Handle: prefer database value, fallback to trader ID for empty/null
      const displayHandle = (info.handle && info.handle.trim()) || snap.source_trader_id

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
        handle: displayHandle,
        roi: snap.roi ?? 0,
        pnl: snap.pnl ?? 0,
        win_rate: normalizedWinRate,
        max_drawdown: snap.max_drawdown,
        followers: snap.followers ?? 0,
        source: snap.source,
        source_type: SOURCE_TYPE_MAP[snap.source] || 'futures' as const,
        avatar_url: info.avatar_url,
        arena_score: finalScore,
        score_confidence: effectiveConfidence,
      }
    })

    // Sort by recalculated arena_score descending
    traders.sort((a, b) => b.arena_score - a.arena_score)

    // Strict ranking by arena_score — no platform diversity filtering
    // Return top traders purely based on calculated score
    return {
      traders: traders.slice(0, limit),
      lastUpdated: latestSnapshot?.captured_at || null,
    }
  } catch (err) {
    logger.error('[getInitialTraders] Exception:', err)
    return { traders: [], lastUpdated: null }
  }
}
