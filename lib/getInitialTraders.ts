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
import { mapLeaderboardRow } from '@/lib/data/trader/mappers'
import { logger } from '@/lib/logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import * as cache from '@/lib/cache'

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

  // Try Redis cache first (2-minute TTL) — avoids DB roundtrip on cache hit
  const cacheKey = `home-initial-traders:${timeRange}`
  try {
    const cached = await cache.get<{ traders: InitialTrader[]; lastUpdated: string | null }>(cacheKey)
    if (cached && cached.traders && cached.traders.length > 0) {
      return cached
    }
  } catch {
    // Redis unavailable — fall through to DB
  }

  const result = await fetchLeaderboardFromDB(timeRange, limit)

  // Cache the result asynchronously (2-minute TTL)
  if (result.traders.length > 0) {
    cache.set(cacheKey, result, { ttl: 120 }).catch(() => {})
  }

  return result
}

/**
 * Direct Supabase fetch -- used by cron to populate cache and as fallback.
 * Exported so the cron refresh route can call it without triggering cache reads.
 *
 * Strategy:
 * 1. Try SQL RPC `get_diverse_leaderboard` (returns ~50 rows, ~10KB payload)
 * 2. Fallback to getLeaderboard(2000) + JS-side diversity filter (~400KB) if RPC missing
 */
export async function fetchLeaderboardFromDB(
  timeRange: Period = '90D',
  limit: number = 50
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const supabase = getSupabaseAdmin()

  // 5s timeout -- prevents SSR from blocking LCP (was 15s, reduced for faster fallback)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)

  try {
    const result = await Promise.race([
      fetchViaDiverseRPC(supabase, timeRange, limit),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new Error('Query timeout after 5000ms'))
        )
      }),
    ])

    clearTimeout(timer)
    return result
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

/**
 * Primary path: use the SQL RPC that handles diversity at the DB level.
 * Falls back to the legacy 2000-row JS-side filter if the RPC doesn't exist.
 */
async function fetchViaDiverseRPC(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  limit: number
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const MAX_PER_PLATFORM = 8

  // Try the SQL RPC first
  const { data, error } = await supabase.rpc('get_diverse_leaderboard', {
    p_season_id: timeRange,
    p_per_platform: MAX_PER_PLATFORM,
    p_total_limit: limit,
  })

  if (!error && data && Array.isArray(data) && data.length > 0) {
    const unifiedTraders = data.map((row: Record<string, unknown>) => mapLeaderboardRow(row))
    const initialTraders = unifiedTraders.map(mapUnifiedToInitial)
    const lastUpdated = unifiedTraders.length > 0 ? unifiedTraders[0].lastUpdated : null
    return { traders: initialTraders, lastUpdated }
  }

  // Fallback: RPC doesn't exist yet or returned empty — use legacy 2000-row approach
  if (error) {
    logger.warn('[getInitialTraders] RPC fallback — get_diverse_leaderboard unavailable:', error.message)
  }

  return fetchLeaderboardLegacy(supabase, timeRange, limit)
}

/**
 * Lightweight fallback: fetch only 50 rows sorted by arena_score DESC.
 * Avoids the expensive 2000-row fetch + JS-side filtering that caused LCP spikes.
 */
async function fetchLeaderboardLegacy(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  limit: number
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const { traders: unifiedTraders } = await getLeaderboard(supabase, {
    period: timeRange as '7D' | '30D' | '90D',
    limit: Math.min(limit, 50),
    minScore: 10,
    excludeOutliers: true,
    sortBy: 'score',
  })

  const initialTraders = unifiedTraders.map(mapUnifiedToInitial)
  const lastUpdated = unifiedTraders.length > 0 ? unifiedTraders[0].lastUpdated : null

  return {
    traders: initialTraders,
    lastUpdated,
  }
}
