/**
 * lib/data/linked-traders.ts
 *
 * Data helpers for multi-account linked traders.
 * Queries canonical `user_linked_traders`, with a legacy-table compatibility
 * fallback only when the canonical relation itself is unavailable.
 * Computes aggregated stats across all linked accounts.
 * Membership is read live. Unlinking an account is a privacy boundary, so this
 * module must not rely on process-local or delete-only caches for correctness.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as cache from '@/lib/cache'
import { normalizeDrawdownMagnitude } from '@/lib/utils/format'

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface LinkedTraderAccount {
  id: string
  userId: string
  platform: string
  traderKey: string
  handle: string | null
  label: string | null // custom user label (e.g. "Main Account")
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
  combinedPnl: number | null
  bestRoi: { value: number; platform: string; traderKey: string } | null
  weightedScore: number | null
  totalAccounts: number
  accounts: LinkedTraderAccount[]
}

// ─── Cache keys ────────────────────────────────────────────────────────────────

function linkedCacheKey(userId: string): string {
  return `linked-traders:v2:${userId}`
}

function aggCacheKey(userId: string): string {
  return `linked-traders-agg:v2:${userId}`
}

/**
 * Public aggregate route cache key. Keep this builder beside the mutation
 * invalidator so the route and every linked-account write cannot drift apart.
 */
export function linkedTraderRouteAggregateCacheKey(userId: string): string {
  return `aggregate:v2:user:${userId}`
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function roiOrNull(value: unknown): number | null {
  const parsed = finiteNumberOrNull(value)
  return parsed != null && parsed >= -10_000 && parsed <= 10_000 ? parsed : null
}

function boundedPercentOrNull(value: unknown): number | null {
  const parsed = finiteNumberOrNull(value)
  return parsed != null && parsed >= 0 && parsed <= 100 ? parsed : null
}

function isMissingRelationCompatibilityError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false
  const code = (error as Record<string, unknown>).code
  return code === '42P01' || code === 'PGRST205'
}

// ─── Data Fetching ──────────────────────────────────────────────────────────────

/**
 * Fetch all linked trader accounts for a user, with their latest snapshot stats.
 * Tries `user_linked_traders` first. A successful empty canonical read is
 * authoritative: falling back then could resurrect a retired row after unlink.
 */
export async function getLinkedTraders(
  supabase: SupabaseClient,
  userId: string
): Promise<LinkedTraderAccount[]> {
  let links: LinkedTraderAccount[] = []

  // Strategy 1: user_linked_traders table (Phase 1)
  // Columns: trader_id (not trader_key), source (not platform), verified_at (not linked_at)
  const { data: ult, error: ultError } = await supabase
    .from('user_linked_traders')
    .select('id, user_id, source, trader_id, label, is_primary, verified_at')
    .eq('user_id', userId)
    .order('is_primary', { ascending: false })
    .order('verified_at', { ascending: true })

  if (ultError && !isMissingRelationCompatibilityError(ultError)) {
    throw new Error(`linked trader lookup failed: ${ultError.message || 'unknown error'}`)
  }

  if (!ultError) {
    if (!ult || ult.length === 0) return []

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
    // Compatibility fallback only for deployments where the canonical table
    // is genuinely unavailable. `trader_links` is retired and read-only.
    const { data: tl, error: tlError } = await supabase
      .from('trader_links')
      .select('id, user_id, trader_id, source, handle, verified_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (tlError) {
      throw new Error(`linked trader lookup failed: ${tlError.message || 'unknown error'}`)
    }
    if (!tl || tl.length === 0) {
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

  // Enrich with latest snapshot stats — batch query instead of N+1
  // Group links by platform for efficient .in() queries
  const byPlatform = new Map<string, string[]>()
  for (const link of links) {
    const keys = byPlatform.get(link.platform) || []
    keys.push(link.traderKey)
    byPlatform.set(link.platform, keys)
  }

  // Parallel batch fetch per platform from leaderboard_ranks (precomputed, has correct columns)
  // Previously queried trader_snapshots_v2 with wrong column names (roi→roi_pct, pnl→pnl_usd,
  // rank doesn't exist), causing null values for linked account stats.
  const snapshotMap = new Map<string, Record<string, unknown>>()
  const snapshotErrors: Error[] = []
  await Promise.all(
    [...byPlatform.entries()].map(async ([platform, traderKeys]) => {
      const { data: snapshots, error: snapshotsError } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, roi, win_rate, max_drawdown')
        .eq('source', platform)
        .in('source_trader_id', traderKeys)
        .eq('season_id', '90D')
      if (snapshotsError) {
        logger.warn(
          `[getLinkedTraders] leaderboard_ranks query failed for ${platform}:`,
          snapshotsError.message
        )
        snapshotErrors.push(
          new Error(
            `linked trader snapshot lookup failed for ${platform}: ${snapshotsError.message || 'unknown error'}`
          )
        )
        return
      }

      if (snapshots) {
        for (const s of snapshots) {
          snapshotMap.set(`${s.source}:${s.source_trader_id}`, s)
        }
      }
    })
  )
  if (snapshotErrors.length > 0) throw snapshotErrors[0]

  // Apply snapshot data to links
  for (const link of links) {
    const snapshot = snapshotMap.get(`${link.platform}:${link.traderKey}`)
    if (snapshot) {
      link.roi = roiOrNull(snapshot.roi)
      link.winRate = boundedPercentOrNull(snapshot.win_rate)
      link.maxDrawdown = normalizeDrawdownMagnitude(finiteNumberOrNull(snapshot.max_drawdown))
      // A bare PnL number has no settlement-currency contract. Keep it unknown
      // until the linked projection returns a Money value bound to provenance.
      link.pnl = null
      // Arena Score and rank remain unknown until this row is bound to the
      // current sealed publication proof/cohort. Row-level flags and
      // computed_at alone cannot establish source freshness or immutability.
      link.arenaScore = null
      link.rank = null
    }
  }

  return links
}

/**
 * Compute aggregated stats across all linked accounts for a user.
 *
 * Cross-source PnL is intentionally unavailable until every account carries
 * an attested settlement currency. A bare leaderboard_ranks.pnl number must
 * never be summed or used as a cross-currency score weight.
 *
 * Aggregate numerics remain unavailable until every intended account is bound
 * to the same complete, fresh publication contract. A complete-looking subset
 * must not masquerade as an aggregate.
 * - total_accounts: count
 */
export async function getAggregatedStats(
  supabase: SupabaseClient,
  userId: string
): Promise<AggregatedStats | null> {
  const accounts = await getLinkedTraders(supabase, userId)
  if (accounts.length === 0) return null

  const result: AggregatedStats = {
    combinedPnl: null,
    bestRoi: null,
    weightedScore: null,
    totalAccounts: accounts.length,
    accounts,
  }

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
  const { data: ult, error: ultError } = await supabase
    .from('user_linked_traders')
    .select('user_id')
    .eq('source', platform)
    .eq('trader_id', traderKey)
    .limit(1)
    .maybeSingle()
  if (ultError && !isMissingRelationCompatibilityError(ultError)) {
    throw new Error(`linked trader owner lookup failed: ${ultError.message || 'unknown error'}`)
  }
  if (ultError)
    logger.warn('[findUserByTrader] user_linked_traders query error (drift?):', ultError.message)

  if (ult?.user_id) return String(ult.user_id)

  // A successful canonical miss is authoritative. Falling through to the
  // retired table could re-publish an account that has since been unlinked.
  if (!ultError) return null

  // Compatibility fallback only when the canonical relation is unavailable.
  const { data: tl, error: tlError } = await supabase
    .from('trader_links')
    .select('user_id')
    .eq('source', platform)
    .eq('trader_id', traderKey)
    .limit(1)
    .maybeSingle()
  if (tlError) {
    throw new Error(
      `legacy linked trader owner lookup failed: ${tlError.message || 'unknown error'}`
    )
  }

  if (tl?.user_id) return String(tl.user_id)

  return null
}

/**
 * Invalidate cache for a user's linked traders.
 * Call this when a user links/unlinks an account.
 */
export async function invalidateLinkedTraderCache(userId: string): Promise<void> {
  try {
    await Promise.all([
      cache.del(`linked-traders:${userId}`),
      cache.del(linkedCacheKey(userId)),
      cache.del(`linked-traders-agg:${userId}`),
      cache.del(aggCacheKey(userId)),
      cache.del(`aggregate:user:${userId}`),
      cache.del(linkedTraderRouteAggregateCacheKey(userId)),
    ])
  } catch (err) {
    logger.warn('[linked-traders] Cache invalidation failed:', err)
  }
}
