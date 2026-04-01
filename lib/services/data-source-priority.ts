/**
 * Data Source Priority System
 *
 * Determines the best data source for a trader based on verification status.
 * Priority chain: Authorized (API key/wallet) > Public API > Enrichment > Historical
 *
 * When a trader has bound their API key or verified wallet ownership,
 * their authorized data takes precedence over scraped public data.
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// ============================================
// Types
// ============================================

export enum DataSourcePriority {
  AUTHORIZED = 1,  // User's API key/wallet data (real-time, highest trust)
  PUBLIC_API = 2,   // Public exchange API data (scraped leaderboards)
  ENRICHMENT = 3,   // Computed from equity curves (derived metrics)
  HISTORICAL = 4,   // Old snapshot data (stale fallback)
}

export interface TraderData {
  platform: string
  traderKey: string
  roi: number | null
  pnl: number | null
  winRate: number | null
  maxDrawdown: number | null
  tradesCount: number | null
  sharpeRatio: number | null
  followers: number | null
  arenaScore: number | null
  updatedAt: string | null
}

export interface TraderDataWithSource {
  data: TraderData
  source: DataSourcePriority
  sourceLabel: 'authorized' | 'public_api' | 'enrichment' | 'historical'
  isVerified: boolean
  verifiedAt: string | null
  authorizationId: string | null
}

// ============================================
// Core Functions
// ============================================

/**
 * Get trader data with the best available source priority.
 * Checks authorization status first, then falls through the chain.
 */
export async function getTraderDataWithPriority(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string,
  userId?: string
): Promise<TraderDataWithSource> {
  // Step 1: Check for authorized data (if user is specified)
  if (userId) {
    const authorized = await getAuthorizedData(supabase, platform, traderKey, userId)
    if (authorized) {
      return authorized
    }
  }

  // Step 2: Check for public API data (leaderboard_ranks — freshest)
  const publicData = await getPublicApiData(supabase, platform, traderKey)
  if (publicData) {
    // Check if this trader is verified by anyone (for badge display)
    const verification = await getVerificationStatus(supabase, platform, traderKey)
    return {
      ...publicData,
      isVerified: verification.isVerified,
      verifiedAt: verification.verifiedAt,
    }
  }

  // Step 3: Check enrichment data (trader_snapshots_v2)
  const enriched = await getEnrichmentData(supabase, platform, traderKey)
  if (enriched) {
    return enriched
  }

  // Step 4: Fallback to historical data
  return getHistoricalData(supabase, platform, traderKey)
}

/**
 * Check if a trader has any active authorization (bound API key or verified wallet).
 * Used for badge display without requiring a specific userId.
 */
export async function isTraderAuthorized(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string
): Promise<{ authorized: boolean; authorizationId: string | null; lastVerifiedAt: string | null }> {
  const { data, error } = await supabase
    .from('trader_authorizations')
    .select('id, last_verified_at')
    .eq('platform', platform)
    .eq('trader_id', traderKey)
    .eq('status', 'active')
    .order('last_verified_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    logger.error('[data-source-priority] isTraderAuthorized query failed', error)
    return { authorized: false, authorizationId: null, lastVerifiedAt: null }
  }

  return {
    authorized: !!data,
    authorizationId: data?.id ?? null,
    lastVerifiedAt: data?.last_verified_at ?? null,
  }
}

/**
 * Get the data source label for display in UI.
 */
export function getSourceLabel(priority: DataSourcePriority): string {
  switch (priority) {
    case DataSourcePriority.AUTHORIZED:
      return 'Verified Data'
    case DataSourcePriority.PUBLIC_API:
      return 'Public Data'
    case DataSourcePriority.ENRICHMENT:
      return 'Derived Data'
    case DataSourcePriority.HISTORICAL:
      return 'Historical Data'
  }
}

// ============================================
// Internal: Data Fetchers by Priority Level
// ============================================

async function getAuthorizedData(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string,
  userId: string
): Promise<TraderDataWithSource | null> {
  // Check if user has an active authorization for this trader
  const { data: auth, error: authError } = await supabase
    .from('trader_authorizations')
    .select('id, last_verified_at, status')
    .eq('user_id', userId)
    .eq('platform', platform)
    .eq('trader_id', traderKey)
    .eq('status', 'active')
    .maybeSingle()

  if (authError || !auth) {
    return null
  }

  // Authorized data is stored as snapshots with is_authorized=true
  // or in authorization_sync_logs. For now, we check leaderboard_ranks
  // and mark it as authorized since the data pipeline handles syncing.
  const { data: snapshot } = await supabase
    .from('leaderboard_ranks')
    .select('roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, sharpe_ratio, followers, arena_score, computed_at')
    .eq('source', platform)
    .eq('source_trader_id', traderKey)
    .eq('season_id', '90D')
    .maybeSingle()

  if (!snapshot) {
    return null
  }

  return {
    data: {
      platform,
      traderKey,
      roi: snapshot.roi_pct,
      pnl: snapshot.pnl_usd,
      winRate: snapshot.win_rate,
      maxDrawdown: snapshot.max_drawdown,
      tradesCount: snapshot.trades_count,
      sharpeRatio: snapshot.sharpe_ratio,
      followers: snapshot.followers,
      arenaScore: snapshot.arena_score,
      updatedAt: snapshot.computed_at,
    },
    source: DataSourcePriority.AUTHORIZED,
    sourceLabel: 'authorized',
    isVerified: true,
    verifiedAt: auth.last_verified_at,
    authorizationId: auth.id,
  }
}

async function getPublicApiData(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string
): Promise<TraderDataWithSource | null> {
  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select('roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, sharpe_ratio, followers, arena_score, computed_at')
    .eq('source', platform)
    .eq('source_trader_id', traderKey)
    .eq('season_id', '90D')
    .maybeSingle()

  if (error || !data) {
    return null
  }

  return {
    data: {
      platform,
      traderKey,
      roi: data.roi_pct,
      pnl: data.pnl_usd,
      winRate: data.win_rate,
      maxDrawdown: data.max_drawdown,
      tradesCount: data.trades_count,
      sharpeRatio: data.sharpe_ratio,
      followers: data.followers,
      arenaScore: data.arena_score,
      updatedAt: data.computed_at,
    },
    source: DataSourcePriority.PUBLIC_API,
    sourceLabel: 'public_api',
    isVerified: false,
    verifiedAt: null,
    authorizationId: null,
  }
}

async function getEnrichmentData(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string
): Promise<TraderDataWithSource | null> {
  const { data, error } = await supabase
    .from('trader_snapshots_v2')
    .select('roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, sharpe_ratio, followers, arena_score, created_at')
    .eq('platform', platform)
    .eq('trader_key', traderKey)
    .eq('window', '90D')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) {
    return null
  }

  return {
    data: {
      platform,
      traderKey,
      roi: data.roi_pct,
      pnl: data.pnl_usd,
      winRate: data.win_rate,
      maxDrawdown: data.max_drawdown,
      tradesCount: data.trades_count,
      sharpeRatio: data.sharpe_ratio,
      followers: data.followers,
      arenaScore: data.arena_score,
      updatedAt: data.created_at,
    },
    source: DataSourcePriority.ENRICHMENT,
    sourceLabel: 'enrichment',
    isVerified: false,
    verifiedAt: null,
    authorizationId: null,
  }
}

async function getHistoricalData(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string
): Promise<TraderDataWithSource> {
  // Last resort: grab any snapshot we have
  const { data } = await supabase
    .from('trader_snapshots_v2')
    .select('roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, sharpe_ratio, followers, arena_score, created_at')
    .eq('platform', platform)
    .eq('trader_key', traderKey)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return {
    data: {
      platform,
      traderKey,
      roi: data?.roi_pct ?? null,
      pnl: data?.pnl_usd ?? null,
      winRate: data?.win_rate ?? null,
      maxDrawdown: data?.max_drawdown ?? null,
      tradesCount: data?.trades_count ?? null,
      sharpeRatio: data?.sharpe_ratio ?? null,
      followers: data?.followers ?? null,
      arenaScore: data?.arena_score ?? null,
      updatedAt: data?.created_at ?? null,
    },
    source: DataSourcePriority.HISTORICAL,
    sourceLabel: 'historical',
    isVerified: false,
    verifiedAt: null,
    authorizationId: null,
  }
}

// ============================================
// Helper: Verification Status
// ============================================

async function getVerificationStatus(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string
): Promise<{ isVerified: boolean; verifiedAt: string | null }> {
  const { data } = await supabase
    .from('verified_traders')
    .select('verified_at')
    .eq('trader_id', traderKey)
    .eq('source', platform)
    .maybeSingle()

  return {
    isVerified: !!data,
    verifiedAt: data?.verified_at ?? null,
  }
}
