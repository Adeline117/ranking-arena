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
import { sanitizeDisplayName } from '@/lib/utils/profanity'

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
    const isTimeout = err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('timeout'))
    if (isTimeout) {
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
    // Use pre-computed leaderboard_ranks (same as /api/traders)
    // This ensures SSR and API return identical data (no ROI cap mismatch)
    const [ranksResult, timestampResult] = await Promise.all([
      supabase
        .from('leaderboard_ranks')
        .select(`
          source_trader_id,
          handle,
          source,
          source_type,
          roi,
          pnl,
          win_rate,
          max_drawdown,
          followers,
          arena_score,
          avatar_url,
          rank
        `)
        .eq('season_id', timeRange)
        .or('is_outlier.is.null,is_outlier.eq.false') // Filter outliers (same as API)
        .gt('arena_score', 10) // Filter low-quality entries
        .order('rank', { ascending: true })
        .limit(limit * 2)
        .abortSignal(signal!), // Cancel if build timeout

      supabase
        .from('leaderboard_ranks')
        .select('computed_at')
        .eq('season_id', timeRange)
        .order('computed_at', { ascending: false })
        .limit(1)
        .abortSignal(signal!)
        .maybeSingle()
    ])

    const { data: ranks, error } = ranksResult
    const latestRank = timestampResult.data

    if (error || !ranks?.length) {
      logger.error('[getInitialTraders] Query error:', error?.message)
      return { traders: [], lastUpdated: latestRank?.computed_at || null }
    }

    // Dedupe by source + trader_id (keep extra for diversity filtering)
    const seen = new Set<string>()
    const uniqueRanks = ranks.filter(rank => {
      const key = `${rank.source}:${rank.source_trader_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, limit * 2)

    // Build trader objects directly from leaderboard_ranks
    // No need to recalculate arena_score — it's pre-computed and already validated
    const traders: InitialTrader[] = uniqueRanks.map(rank => {
      // Normalize win_rate and validate range (0-100)
      let normalizedWinRate: number | null = null
      if (rank.win_rate != null && !isNaN(rank.win_rate)) {
        const wr = rank.win_rate <= 1 ? rank.win_rate * 100 : rank.win_rate
        normalizedWinRate = Math.max(0, Math.min(100, wr))
      }

      // Handle: prefer database value, fallback to trader ID
      const rawHandle = (rank.handle && rank.handle.trim()) || rank.source_trader_id
      const displayHandle = sanitizeDisplayName(rawHandle)

      return {
        id: rank.source_trader_id,
        handle: displayHandle,
        roi: rank.roi ?? 0,
        pnl: rank.pnl ?? 0,
        win_rate: normalizedWinRate,
        max_drawdown: rank.max_drawdown,
        followers: rank.followers ?? 0,
        source: rank.source,
        source_type: rank.source_type as 'futures' | 'spot' | 'web3',
        avatar_url: rank.avatar_url,
        arena_score: rank.arena_score ?? 0,
        score_confidence: 'full', // leaderboard_ranks only includes confident scores
      }
    })

    // Already sorted by rank (ascending)

    // Platform diversity: cap max traders per platform to ensure cross-platform mix
    // Without this, a single high-PnL platform (e.g. Hyperliquid whales) monopolizes top 25
    const MAX_PER_PLATFORM = 5
    const platformCounts = new Map<string, number>()
    const diverseTraders: InitialTrader[] = []
    for (const t of traders) {
      const count = platformCounts.get(t.source) || 0
      if (count >= MAX_PER_PLATFORM) continue
      platformCounts.set(t.source, count + 1)
      diverseTraders.push(t)
      if (diverseTraders.length >= limit) break
    }

    return {
      traders: diverseTraders,
      lastUpdated: latestRank?.computed_at || null,
    }
  } catch (err) {
    logger.error('[getInitialTraders] Exception:', err)
    return { traders: [], lastUpdated: null }
  }
}
