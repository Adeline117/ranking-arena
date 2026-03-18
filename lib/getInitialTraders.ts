/**
 * Server-side function to fetch initial traders for SSR
 * This reduces LCP by eliminating client-side data fetching waterfall
 *
 * Uses the unified data layer (lib/data/unified.ts) as the single source of truth.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { Period } from '@/lib/utils/arena-score'
import type { ScoreConfidence } from '@/lib/utils/arena-score'
import type { UnifiedTrader } from '@/lib/types/unified-trader'
import { getLeaderboard } from '@/lib/data/unified'
import { logger } from '@/lib/logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'

/** @deprecated Use UnifiedTrader from lib/types/unified-trader.ts */
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

/**
 * Map a UnifiedTrader to the InitialTrader interface used by frontend components.
 */
function mapUnifiedToInitial(t: UnifiedTrader): InitialTrader {
  const rawHandle = (t.handle && t.handle.trim()) || t.traderKey
  const displayHandle = sanitizeDisplayName(rawHandle)

  return {
    id: t.traderKey,
    handle: displayHandle,
    roi: t.roi ?? 0,
    pnl: t.pnl ?? 0,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: t.followers ?? 0,
    source: t.platform,
    source_type: (t.sourceType as 'futures' | 'spot' | 'web3') || 'futures',
    avatar_url: t.avatarUrl,
    arena_score: t.arenaScore ?? 0,
    score_confidence: 'full', // leaderboard_ranks only includes confident scores
  }
}

export async function getInitialTraders(
  timeRange: Period = '90D',
  limit: number = 50
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  // During Vercel build, Supabase queries hang (iad1 build server -> timeout).
  // Skip DB call entirely -- ISR (revalidate=60) fills on first real request.
  // NEXT_PHASE is set by Next.js build process before static page generation.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return { traders: [], lastUpdated: null }
  }

  // Skip Redis cache for SSR -- Upstash fetch uses cache:'no-store' which
  // forces the entire page into dynamic rendering, breaking ISR.
  // ISR (revalidate=60) handles page-level caching instead.
  // Redis cache is still used by API routes (/api/traders) which are dynamic anyway.
  return fetchLeaderboardFromDB(timeRange, limit)
}

/**
 * Direct Supabase fetch -- used by cron to populate cache and as fallback.
 * Exported so the cron refresh route can call it without triggering cache reads.
 */
export async function fetchLeaderboardFromDB(
  timeRange: Period = '90D',
  limit: number = 50
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const supabase = getSupabaseAdmin()

  // 15s timeout -- prevents build-time static generation from hanging (Vercel kills at 60s)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    // Use unified data layer to fetch leaderboard
    // Fetch a large pool (2000) for platform diversity filtering
    const { traders: unifiedTraders } = await Promise.race([
      getLeaderboard(supabase, {
        period: timeRange as '7D' | '30D' | '90D',
        limit: 2000,
        minScore: 10,
        excludeOutliers: true,
        sortBy: 'rank',
      }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new Error('Query timeout after 15000ms'))
        )
      }),
    ])

    clearTimeout(timer)

    // Dedupe by platform + trader_key (keep first occurrence, which has best rank)
    const seen = new Set<string>()
    const uniqueTraders = unifiedTraders.filter(t => {
      const key = `${t.platform}:${t.traderKey}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Map UnifiedTrader -> InitialTrader
    const initialTraders = uniqueTraders.map(mapUnifiedToInitial)

    // Platform diversity: cap max traders per platform to ensure cross-platform mix
    // Without this, a single high-PnL platform (e.g. Hyperliquid whales) monopolizes top 25
    const MAX_PER_PLATFORM = 5
    const platformCounts = new Map<string, number>()
    const diverseTraders: InitialTrader[] = []
    for (const t of initialTraders) {
      const count = platformCounts.get(t.source) || 0
      if (count >= MAX_PER_PLATFORM) continue
      platformCounts.set(t.source, count + 1)
      diverseTraders.push(t)
      if (diverseTraders.length >= limit) break
    }

    // Extract lastUpdated from first trader (they're sorted by rank, all from same computation)
    const lastUpdated = unifiedTraders.length > 0 ? unifiedTraders[0].lastUpdated : null

    return {
      traders: diverseTraders,
      lastUpdated,
    }
  } catch (err: unknown) {
    clearTimeout(timer)
    const isTimeout = err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('timeout'))
    if (isTimeout) {
      logger.warn('[getInitialTraders] Timed out -- returning empty (ISR will fill on next request)')
    } else {
      logger.error('[getInitialTraders] Error:', err)
    }
    return { traders: [], lastUpdated: null }
  }
}
