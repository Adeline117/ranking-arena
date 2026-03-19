/**
 * lib/data/linked-traders.ts
 *
 * Data helpers for multi-account linked traders.
 * Queries `user_linked_traders` (Phase 1 table) with fallback to `trader_links`.
 * Computes aggregated stats across all linked accounts.
 * Results cached in Redis for 5 minutes.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as cache from '@/lib/cache'

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface LinkedTraderAccount {
  id: string
  userId: string
  platform: string
  traderKey: string
  handle: string | null
  label: string | null     // custom user label (e.g. "Main Account")
  isPrimary: boolean
  linkedAt: string

  // Latest snapshot stats (from trader_snapshots_v2)
  roi: number | null
  pnl: number | null
  arenaScore: number | null
  winRate: number | null
  maxDrawdown: number | null
  rank: number | null
}

export interface AggregatedStats {
  combinedPnl: number
  bestRoi: { value: number; platform: string; traderKey: string } | null
  weightedScore: number
  totalAccounts: number
  accounts: LinkedTraderAccount[]
}

// ─── Cache keys ────────────────────────────────────────────────────────────────

const CACHE_TTL = 300 // 5 minutes

function linkedCacheKey(userId: string): string {
  return `linked-traders:${userId}`
}

function aggCacheKey(userId: string): string {
  return `linked-traders-agg:${userId}`
}

// ─── Data Fetching ──────────────────────────────────────────────────────────────

/**
 * Fetch all linked trader accounts for a user, with their latest snapshot stats.
 * Tries `user_linked_traders` first (Phase 1 table), falls back to `trader_links`.
 */
export async function getLinkedTraders(
  supabase: SupabaseClient,
  userId: string
): Promise<LinkedTraderAccount[]> {
  // Check cache first
  const cached = await cache.get<LinkedTraderAccount[]>(linkedCacheKey(userId))
  if (cached) return cached

  let links: LinkedTraderAccount[] = []

  // Strategy 1: user_linked_traders table (Phase 1)
  // Columns: trader_id (not trader_key), source (not platform), verified_at (not linked_at)
  const { data: ult, error: ultError } = await supabase
    .from('user_linked_traders')
    .select('id, user_id, source, trader_id, label, is_primary, verified_at')
    .eq('user_id', userId)
    .order('is_primary', { ascending: false })
    .order('verified_at', { ascending: true })

  if (!ultError && ult && ult.length > 0) {
    links = ult.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      userId: String(row.user_id),
      platform: String(row.source),
      traderKey: String(row.trader_id),
      handle: null, // not stored in user_linked_traders
      label: row.label as string | null,
      isPrimary: Boolean(row.is_primary),
      linkedAt: String(row.verified_at),
      roi: null,
      pnl: null,
      arenaScore: null,
      winRate: null,
      maxDrawdown: null,
      rank: null,
    }))
  } else {
    // Fallback: trader_links table (legacy)
    const { data: tl, error: tlError } = await supabase
      .from('trader_links')
      .select('id, user_id, trader_id, source, handle, verified_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (tlError || !tl || tl.length === 0) {
      return []
    }

    links = tl.map((row: Record<string, unknown>, i: number) => ({
      id: String(row.id),
      userId: String(row.user_id),
      platform: String(row.source),
      traderKey: String(row.trader_id),
      handle: row.handle as string | null,
      label: null,
      isPrimary: i === 0,
      linkedAt: String(row.verified_at || row.created_at),
      roi: null,
      pnl: null,
      arenaScore: null,
      winRate: null,
      maxDrawdown: null,
      rank: null,
    }))
  }

  if (links.length === 0) return []

  // Enrich with latest snapshot stats from trader_snapshots_v2
  for (const link of links) {
    const { data: snapshot } = await supabase
      .from('trader_snapshots_v2')
      .select('roi, pnl, arena_score, win_rate, max_drawdown, rank')
      .eq('platform', link.platform)
      .eq('trader_key', link.traderKey)
      .eq('window', '90D')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (snapshot) {
      link.roi = snapshot.roi as number | null
      link.pnl = snapshot.pnl as number | null
      link.arenaScore = snapshot.arena_score as number | null
      link.winRate = snapshot.win_rate as number | null
      link.maxDrawdown = snapshot.max_drawdown as number | null
      link.rank = snapshot.rank as number | null
    }
  }

  // Cache results
  await cache.set(linkedCacheKey(userId), links, { ttl: CACHE_TTL })

  return links
}

/**
 * Compute aggregated stats across all linked accounts for a user.
 *
 * - combined_pnl: SUM of all accounts' PnL
 * - best_roi: MAX roi across accounts (with source platform)
 * - weighted_score: Weighted average of arena_scores by |pnl|
 * - total_accounts: count
 */
export async function getAggregatedStats(
  supabase: SupabaseClient,
  userId: string
): Promise<AggregatedStats | null> {
  // Check cache first
  const cached = await cache.get<AggregatedStats>(aggCacheKey(userId))
  if (cached) return cached

  const accounts = await getLinkedTraders(supabase, userId)
  if (accounts.length < 2) return null // No aggregation for single accounts

  let combinedPnl = 0
  let bestRoi: AggregatedStats['bestRoi'] = null
  let weightedScoreNumerator = 0
  let weightedScoreDenominator = 0

  for (const account of accounts) {
    // Combined PnL
    if (account.pnl != null) {
      combinedPnl += account.pnl
    }

    // Best ROI
    if (account.roi != null) {
      if (!bestRoi || account.roi > bestRoi.value) {
        bestRoi = {
          value: account.roi,
          platform: account.platform,
          traderKey: account.traderKey,
        }
      }
    }

    // Weighted score by |pnl|
    if (account.arenaScore != null && account.pnl != null) {
      const weight = Math.abs(account.pnl) + 1 // +1 to avoid zero weight
      weightedScoreNumerator += account.arenaScore * weight
      weightedScoreDenominator += weight
    }
  }

  const weightedScore = weightedScoreDenominator > 0
    ? weightedScoreNumerator / weightedScoreDenominator
    : 0

  const result: AggregatedStats = {
    combinedPnl,
    bestRoi,
    weightedScore,
    totalAccounts: accounts.length,
    accounts,
  }

  // Cache results
  await cache.set(aggCacheKey(userId), result, { ttl: CACHE_TTL })

  return result
}

/**
 * Look up a user_id from a trader's platform + traderKey.
 * Used to check if a trader profile page belongs to a user with linked accounts.
 */
export async function findUserByTrader(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string
): Promise<string | null> {
  // Try user_linked_traders first
  // Columns: source (not platform), trader_id (not trader_key)
  const { data: ult } = await supabase
    .from('user_linked_traders')
    .select('user_id')
    .eq('source', platform)
    .eq('trader_id', traderKey)
    .limit(1)
    .maybeSingle()

  if (ult?.user_id) return String(ult.user_id)

  // Fallback to trader_links
  const { data: tl } = await supabase
    .from('trader_links')
    .select('user_id')
    .eq('source', platform)
    .eq('trader_id', traderKey)
    .limit(1)
    .maybeSingle()

  if (tl?.user_id) return String(tl.user_id)

  return null
}

/**
 * Invalidate cache for a user's linked traders.
 * Call this when a user links/unlinks an account.
 */
export async function invalidateLinkedTraderCache(userId: string): Promise<void> {
  try {
    await cache.del(linkedCacheKey(userId))
    await cache.del(aggCacheKey(userId))
  } catch (err) {
    logger.warn('[linked-traders] Cache invalidation failed:', err)
  }
}
