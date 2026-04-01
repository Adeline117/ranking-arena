/**
 * Core data queries for traders — leaderboard, detail, search, resolve.
 * These are the PUBLIC API functions that frontend components should call.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  UnifiedTrader,
  TraderDetail,
  TradingPeriod,
  EquityPoint,
  AssetWeight,
  TraderPosition,
} from './types'
import { SOURCE_TYPE_MAP, DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'
import { logger } from '@/lib/logger'
import {
  mapLeaderboardRow,
  mapV2Snapshot,
  normalizeWinRate,
  normalizePeriod,
  getSourceAliases,
} from './mappers'
import { fetchSimilarTraders } from './similar'
import { LR, V2, ENRICH } from '@/lib/types/schema-mapping'

// ============================================================
// INTERNAL: Safe query helper
// ============================================================

/** Run a Supabase query, returning null on error (including missing table). */
export async function safeQuery<T>(
  queryFn: () => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>
): Promise<T | null> {
  try {
    const result = await queryFn()
    if (result.error && (
      result.error.code === '42P01' ||
      result.error.message?.includes('does not exist') ||
      result.error.message?.includes('relation')
    )) {
      return null
    }
    if (result.error) {
      logger.warn('[unified] Query error:', result.error.message)
      return null
    }
    return result.data
  } catch {
    return null
  }
}

/** Promise timeout wrapper. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error(`Query timeout after ${ms}ms`)), ms)
  )
  return Promise.race([promise, timeout])
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Get ranked traders for leaderboard display.
 * Used by: homepage, /rankings/[exchange], sidebar widgets
 * Source: leaderboard_ranks (precomputed, fast)
 */
export async function getLeaderboard(supabase: SupabaseClient, params: {
  platform?: string
  period?: TradingPeriod
  limit?: number
  offset?: number
  minScore?: number
  excludeOutliers?: boolean
  sortBy?: 'rank' | 'arena_score' | 'roi' | 'pnl'
}): Promise<{ traders: UnifiedTrader[]; total: number }> {
  const {
    platform,
    period = '90D',
    limit = 50,
    offset = 0,
    minScore,
    excludeOutliers = true,
    sortBy = 'rank',
  } = params

  // Build query against leaderboard_ranks (uses v1 column names: source, source_trader_id, season_id)
  // See LR constants and LEADERBOARD_RANKS_FIELDS in schema-mapping.ts for column→field mapping
  let query = supabase
    .from('leaderboard_ranks')
    .select(
      `${LR.source_trader_id}, ${LR.handle}, ${LR.source}, source_type, ${LR.roi}, ${LR.pnl}, win_rate, max_drawdown,
       trades_count, followers, ${LR.arena_score}, ${LR.avatar_url}, ${LR.rank}, computed_at,
       profitability_score, risk_control_score, execution_score, score_completeness,
       trading_style, avg_holding_hours, sharpe_ratio, trader_type, is_outlier, ${LR.season_id}`,
      { count: 'exact' }
    )
    .eq(LR.season_id, period)

  if (platform) {
    query = query.eq(LR.source, platform)
  }

  if (excludeOutliers) {
    query = query.or('is_outlier.is.null,is_outlier.eq.false')
  }

  if (minScore != null) {
    query = query.gt('arena_score', minScore)
  }

  // Sorting
  const sortColumn = sortBy === 'arena_score' ? 'arena_score'
    : sortBy === 'roi' ? 'roi'
    : sortBy === 'pnl' ? 'pnl'
    : 'rank'

  const ascending = sortBy === 'rank' // rank sorts ascending, others descending
  query = query.order(sortColumn, { ascending, nullsFirst: false })

  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    logger.error('[unified.getLeaderboard] Query error:', error.message)
    return { traders: [], total: 0 }
  }

  const traders = (data || []).map((row: Record<string, unknown>) => mapLeaderboardRow(row))

  return { traders, total: count ?? traders.length }
}

/**
 * Get full trader detail for the trader profile page.
 * Used by: /trader/[handle], /api/traders/[handle]
 *
 * Data resolution uses a fallback chain:
 * 1. leaderboard_ranks (precomputed, has all periods)
 * 2. trader_snapshots_v2 (Connector path, fallback)
 *
 * Enrichment data (equity curve, asset breakdown, positions, stats) comes from
 * dedicated tables that use v1 naming (source + source_trader_id).
 */
export async function getTraderDetail(supabase: SupabaseClient, params: {
  platform: string
  traderKey: string
}): Promise<TraderDetail | null> {
  const { platform, traderKey } = params
  const sourceAliases = getSourceAliases(platform)

  // --- Phase 1: Fetch basic data from leaderboard_ranks + v2 in parallel ---
  const [lrResult, v2Result] = await withTimeout(
    Promise.all([
      // leaderboard_ranks: all periods (precomputed, primary source)
      // Uses v1 column names: source, source_trader_id, season_id
      safeQuery(() =>
        supabase
          .from('leaderboard_ranks')
          .select(`${LR.source_trader_id}, ${LR.handle}, ${LR.source}, source_type, ${LR.roi}, ${LR.pnl}, win_rate, max_drawdown,
                   trades_count, followers, ${LR.arena_score}, ${LR.avatar_url}, ${LR.rank}, computed_at,
                   profitability_score, risk_control_score, execution_score, score_completeness,
                   trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, profit_factor,
                   calmar_ratio, trader_type, is_outlier, ${LR.season_id}`)
          .eq(LR.source, platform)
          .eq(LR.source_trader_id, traderKey)
          .limit(5)
      ),
      // trader_snapshots_v2: all windows (fallback)
      // Uses v2 column names: platform, trader_key, window
      safeQuery(() =>
        supabase
          .from('trader_snapshots_v2')
          .select(`${V2.platform}, ${V2.trader_key}, ${V2.window}, ${V2.roi_pct}, ${V2.pnl_usd}, win_rate, max_drawdown, trades_count, followers, copiers, sharpe_ratio, ${V2.arena_score}, created_at`)
          .eq(V2.platform, platform)
          .eq(V2.trader_key, traderKey)
          .order('created_at', { ascending: false })
          .limit(5)
      ),
    ]),
    10000
  )

  const lrRows = (lrResult || []) as Record<string, unknown>[]
  const v2Rows = (v2Result || []) as Record<string, unknown>[]

  // Build per-period data using fallback chain: LR -> v2
  const periods: Record<TradingPeriod, Partial<UnifiedTrader> | null> = {
    '7D': null,
    '30D': null,
    '90D': null,
  }

  for (const p of ['90D', '30D', '7D'] as TradingPeriod[]) {
    // Try leaderboard_ranks first (season_id → period)
    const lrRow = lrRows.find(r => normalizePeriod(r[LR.season_id] as string) === p)
    if (lrRow) {
      const mapped = mapLeaderboardRow(lrRow)
      periods[p] = mapped
      continue
    }

    // Fallback: trader_snapshots_v2 (window → period)
    const v2Row = v2Rows.find(r =>
      normalizePeriod(r[V2.window] as string) === p
    )
    if (v2Row) {
      periods[p] = mapV2Snapshot(v2Row, p)
    }
  }

  // If no data from any source, return null
  const hasAnyData = periods['90D'] || periods['30D'] || periods['7D']
  if (!hasAnyData) {
    return null
  }

  // Build the primary trader record (prefer 90D, then 30D, then 7D)
  const primaryPeriod: TradingPeriod = periods['90D'] ? '90D' : periods['30D'] ? '30D' : '7D'
  const primaryData = periods[primaryPeriod]!

  // Get profile info from traders table + bio from trader_profiles_v2
  const [sourceProfile, profileV2] = await Promise.all([
    safeQuery(() =>
      supabase
        .from('traders')
        .select('trader_key, handle, profile_url, avatar_url, market_type')
        .eq('platform', platform)
        .eq('trader_key', traderKey)
        .limit(1)
        .maybeSingle()
    ) as Promise<Record<string, unknown> | null>,
    safeQuery(() =>
      supabase
        .from('trader_profiles_v2')
        .select('bio, display_name, avatar_url')
        .eq('platform', platform)
        .eq('trader_key', traderKey)
        .limit(1)
        .maybeSingle()
    ) as Promise<Record<string, unknown> | null>,
  ])

  const trader: UnifiedTrader = {
    platform,
    traderKey,
    handle: (sourceProfile?.handle as string) || (profileV2?.display_name as string) || primaryData.handle || null,
    avatarUrl: (sourceProfile?.avatar_url as string) || (profileV2?.avatar_url as string) || primaryData.avatarUrl || null,
    profileUrl: (sourceProfile?.profile_url as string) || null,
    marketType: (sourceProfile?.market_type as string) || primaryData.marketType || SOURCE_TYPE_MAP[platform] || null,
    sourceType: SOURCE_TYPE_MAP[platform] || null,
    roi: primaryData.roi ?? null,
    pnl: primaryData.pnl ?? null,
    winRate: primaryData.winRate ?? null,
    maxDrawdown: primaryData.maxDrawdown ?? null,
    tradesCount: primaryData.tradesCount ?? null,
    followers: primaryData.followers ?? null,
    copiers: primaryData.copiers ?? null,
    arenaScore: primaryData.arenaScore ?? null,
    returnScore: primaryData.returnScore ?? null,
    pnlScore: primaryData.pnlScore ?? null,
    drawdownScore: primaryData.drawdownScore ?? null,
    stabilityScore: primaryData.stabilityScore ?? null,
    profitabilityScore: primaryData.profitabilityScore ?? null,
    riskControlScore: primaryData.riskControlScore ?? null,
    executionScore: primaryData.executionScore ?? null,
    scoreConfidence: primaryData.scoreConfidence ?? null,
    rank: primaryData.rank ?? null,
    period: primaryPeriod,
    sharpeRatio: primaryData.sharpeRatio ?? null,
    sortinoRatio: primaryData.sortinoRatio ?? null,
    profitFactor: primaryData.profitFactor ?? null,
    calmarRatio: primaryData.calmarRatio ?? null,
    tradingStyle: primaryData.tradingStyle ?? null,
    avgHoldingHours: primaryData.avgHoldingHours ?? null,
    traderType: primaryData.traderType ?? null,
    isOutlier: primaryData.isOutlier ?? false,
    lastUpdated: primaryData.lastUpdated ?? null,
  }

  // --- Phase 2: Fetch enrichment data in parallel ---
  // Enrichment tables use v1 naming: source + source_trader_id
  const [
    equityCurve90dResult,
    equityCurve30dResult,
    equityCurve7dResult,
    assetBreakdown90dResult,
    assetBreakdown30dResult,
    assetBreakdown7dResult,
    statsDetailResult,
    portfolioResult,
    positionHistoryResult,
    trackedSinceResult,
    similarTradersResult,
  ] = await withTimeout(
    Promise.all([
      // Equity curves (3 periods) — enrichment tables use v1 naming: source, source_trader_id
      safeQuery(() =>
        supabase.from('trader_equity_curve')
          .select('data_date, roi_pct, pnl_usd')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey).eq(ENRICH.period, '90D')
          .order('data_date', { ascending: true }).limit(90)
      ),
      safeQuery(() =>
        supabase.from('trader_equity_curve')
          .select('data_date, roi_pct, pnl_usd')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey).eq(ENRICH.period, '30D')
          .order('data_date', { ascending: true }).limit(30)
      ),
      safeQuery(() =>
        supabase.from('trader_equity_curve')
          .select('data_date, roi_pct, pnl_usd')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey).eq(ENRICH.period, '7D')
          .order('data_date', { ascending: true }).limit(7)
      ),
      // Asset breakdowns (3 periods) — enrichment tables use v1 naming
      safeQuery(() =>
        supabase.from('trader_asset_breakdown')
          .select('symbol, weight_pct')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey).eq(ENRICH.period, '90D')
          .order('weight_pct', { ascending: false }).limit(20)
      ),
      safeQuery(() =>
        supabase.from('trader_asset_breakdown')
          .select('symbol, weight_pct')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey).eq(ENRICH.period, '30D')
          .order('weight_pct', { ascending: false }).limit(20)
      ),
      safeQuery(() =>
        supabase.from('trader_asset_breakdown')
          .select('symbol, weight_pct')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey).eq(ENRICH.period, '7D')
          .order('weight_pct', { ascending: false }).limit(20)
      ),
      // Stats detail (all periods) — enrichment tables use v1 naming
      safeQuery(() =>
        supabase.from('trader_stats_detail')
          .select('sharpe_ratio, copiers_pnl, copiers_count, winning_positions, total_positions, avg_holding_time_hours, avg_profit, avg_loss, largest_win, largest_loss, aum, period')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey)
          .order('captured_at', { ascending: false }).limit(3)
      ),
      // Portfolio — enrichment tables use v1 naming
      safeQuery(() =>
        supabase.from('trader_portfolio')
          .select('symbol, direction, invested_pct, entry_price, pnl')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey)
          .order('captured_at', { ascending: false }).limit(50)
      ),
      // Position history — enrichment tables use v1 naming
      safeQuery(() =>
        supabase.from('trader_position_history')
          .select('symbol, direction, open_time, close_time, entry_price, exit_price, pnl_usd, pnl_pct, status')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey)
          .order('open_time', { ascending: false }).limit(100)
      ),
      // Tracked since (earliest v2 snapshot)
      safeQuery(() =>
        supabase.from('trader_snapshots_v2')
          .select('created_at')
          .eq(V2.platform, platform).eq(V2.trader_key, traderKey)
          .order('created_at', { ascending: true }).limit(1).maybeSingle()
      ),
      // Similar traders (by arena score range)
      fetchSimilarTraders(supabase, platform, traderKey, trader.arenaScore, trader.roi),
    ]),
    10000
  )

  // Map equity curves
  type EqRow = { data_date: string; roi_pct: number | null; pnl_usd: number | null }
  const mapEquity = (rows: EqRow[] | null): EquityPoint[] =>
    (rows || []).map(r => ({ date: r.data_date, roi: r.roi_pct, pnl: r.pnl_usd }))

  const equityCurve: Record<TradingPeriod, EquityPoint[]> = {
    '90D': mapEquity(equityCurve90dResult as EqRow[] | null),
    '30D': mapEquity(equityCurve30dResult as EqRow[] | null),
    '7D': mapEquity(equityCurve7dResult as EqRow[] | null),
  }

  // Map asset breakdowns
  type AbRow = { symbol: string; weight_pct: number }
  const mapAssets = (rows: AbRow[] | null): AssetWeight[] =>
    (rows || []).map(r => ({ symbol: r.symbol, weightPct: r.weight_pct }))

  const assetBreakdown: Record<TradingPeriod, AssetWeight[]> = {
    '90D': mapAssets(assetBreakdown90dResult as AbRow[] | null),
    '30D': mapAssets(assetBreakdown30dResult as AbRow[] | null),
    '7D': mapAssets(assetBreakdown7dResult as AbRow[] | null),
  }

  // Map stats detail (prefer 90D)
  type StatsRow = {
    sharpe_ratio: number | null; copiers_pnl: number | null; copiers_count: number | null
    winning_positions: number | null; total_positions: number | null
    avg_holding_time_hours: number | null; avg_profit: number | null; avg_loss: number | null
    largest_win: number | null; largest_loss: number | null; aum: number | null; period: string | null
  }
  const statsRows = (statsDetailResult || []) as StatsRow[]
  const statsPrimary = statsRows.find(s => s.period === '90D') || statsRows[0] || null

  const stats = statsPrimary ? {
    sharpeRatio: statsPrimary.sharpe_ratio,
    copiersPnl: statsPrimary.copiers_pnl,
    copiersCount: statsPrimary.copiers_count,
    winningPositions: statsPrimary.winning_positions,
    totalPositions: statsPrimary.total_positions,
    avgHoldingHours: statsPrimary.avg_holding_time_hours,
    avgProfit: statsPrimary.avg_profit,
    avgLoss: statsPrimary.avg_loss,
    largestWin: statsPrimary.largest_win,
    largestLoss: statsPrimary.largest_loss,
    aum: statsPrimary.aum,
  } : null

  // Map portfolio
  type PortRow = { symbol: string | null; direction: string | null; invested_pct: number | null; entry_price: number | null; pnl: number | null }
  const portfolio: TraderPosition[] = ((portfolioResult || []) as PortRow[]).map(r => ({
    symbol: r.symbol || '',
    direction: r.direction || null,
    openTime: null,
    closeTime: null,
    entryPrice: r.entry_price,
    exitPrice: null,
    pnlUsd: r.pnl,
    pnlPct: null,
    status: 'open',
  }))

  // Map position history
  type PosRow = {
    symbol: string; direction: string; open_time: string | null; close_time: string | null
    entry_price: number | null; exit_price: number | null
    pnl_usd: number | null; pnl_pct: number | null; status: string | null
  }
  const positionHistory: TraderPosition[] = ((positionHistoryResult || []) as PosRow[]).map(r => ({
    symbol: r.symbol || '',
    direction: r.direction || null,
    openTime: r.open_time,
    closeTime: r.close_time,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price,
    pnlUsd: r.pnl_usd,
    pnlPct: r.pnl_pct,
    status: r.status || 'closed',
  }))

  // Tracked since
  const trackedSince = (trackedSinceResult as Record<string, unknown> | null)?.created_at as string | null ?? null

  return {
    trader,
    periods,
    equityCurve,
    assetBreakdown,
    stats,
    portfolio,
    positionHistory,
    similarTraders: similarTradersResult || [],
    trackedSince,
    bio: (profileV2?.bio as string) || null,
  }
}

/**
 * Search traders by name/handle with fuzzy matching.
 * Used by: search bar, /search
 * Source: trader_sources + leaderboard_ranks for score-based ranking
 *
 * Strategy: Try RPC fuzzy search first (pg_trgm similarity), fall back to ILIKE.
 * Fuzzy search catches typos like "binane" -> "binance", "hyperliqu" -> "hyperliquid"
 */
export async function searchTraders(supabase: SupabaseClient, params: {
  query: string
  limit?: number
  platform?: string
}): Promise<UnifiedTrader[]> {
  const { query, limit = 10, platform } = params

  if (!query || query.length < 1) return []

  const sanitizedQuery = query
    .slice(0, 100)
    .replace(/[\\%_]/g, (c) => `\\${c}`)
    .replace(/[.,()]/g, '')

  if (!sanitizedQuery) return []

  // --- Try fuzzy RPC search first (handles typos via pg_trgm) ---
  let sourcesData: Array<{ source_trader_id: string; handle: string | null; source: string; avatar_url: string | null; relevance_score?: number }> | null = null
  let usedFuzzy = false

  try {
    const { data: fuzzyData, error: fuzzyErr } = await supabase.rpc('search_traders_fuzzy', {
      search_query: sanitizedQuery,
      result_limit: limit * 4,
      platform_filter: platform || null,
    })
    if (!fuzzyErr && fuzzyData && fuzzyData.length > 0) {
      // Filter out false positives: require a substring match OR meaningful
      // trigram similarity. The RPC adds arena_score*2 + followers*0.1 as
      // popularity boost (up to ~250 points), which inflates relevance_score
      // for popular traders even with zero text similarity. We must isolate
      // the text-matching portion to avoid false positives.
      const qLower = sanitizedQuery.toLowerCase()
      type FuzzyResult = { source_trader_id: string; handle: string | null; source: string; avatar_url: string | null; relevance_score?: number }
      const filtered = (fuzzyData as FuzzyResult[]).filter(t => {
        const handle = (t.handle || '').toLowerCase()
        const id = t.source_trader_id.toLowerCase()
        const hasSubstringMatch = handle.includes(qLower) || id.includes(qLower)
        if (hasSubstringMatch) return true
        // For fuzzy-only matches (no substring), require relevance_score high
        // enough that text similarity alone (max 50 points from similarity*50)
        // contributed meaningfully. Arena_score boost can add up to ~200, so
        // we need score > 250 to ensure real text similarity was present,
        // OR the query must be short (< 5 chars) where trigram matching is inherently weak.
        const score = t.relevance_score ?? 0
        return score >= 250 && qLower.length >= 3
      })
      if (filtered.length > 0) {
        sourcesData = filtered
        usedFuzzy = true
      }
    }
  } catch {
    // RPC not available (migration not applied), fall through to ILIKE
  }

  // --- Fallback: ILIKE search using traders table ---
  if (!sourcesData) {
    let sourcesQuery = supabase
      .from('traders')
      .select('trader_key, handle, platform, avatar_url')
      .or(`handle.ilike.%${sanitizedQuery}%,trader_key.ilike.%${sanitizedQuery}%`)

    if (platform) {
      sourcesQuery = sourcesQuery.eq('platform', platform)
    }

    const { data, error } = await sourcesQuery.limit(limit * 4)
    if (error || !data || data.length === 0) return []
    // Map traders columns to expected shape
    sourcesData = data.map((d: { trader_key: string; handle: string | null; platform: string; avatar_url: string | null }) => ({
      source_trader_id: d.trader_key,
      handle: d.handle,
      source: d.platform,
      avatar_url: d.avatar_url,
    }))
  }

  // Filter out DEAD/blocked platforms
  const deadSet = new Set(DEAD_BLOCKED_PLATFORMS as string[])
  const filteredSources = sourcesData.filter(t => !deadSet.has(t.source))
  if (filteredSources.length === 0) return []

  // Fetch arena scores from leaderboard_ranks for ranking
  // LR columns: source → platform, source_trader_id → traderKey, season_id → period
  const traderIds = filteredSources.map(t => t.source_trader_id)
  const { data: scoreRows } = await supabase
    .from('leaderboard_ranks')
    .select(`${LR.source}, ${LR.source_trader_id}, ${LR.arena_score}, ${LR.roi}, ${LR.pnl}, ${LR.rank}, ${LR.season_id}, trader_type`)
    .in(LR.source_trader_id, traderIds.slice(0, 200))
    .eq(LR.season_id, '90D')
    .not(LR.arena_score, 'is', null)
    .order(LR.arena_score, { ascending: false })

  // Build score map
  const scoreMap = new Map<string, Record<string, unknown>>()
  for (const row of (scoreRows || [])) {
    const key = `${row.source}:${row.source_trader_id}`
    if (!scoreMap.has(key)) scoreMap.set(key, row)
  }

  // Rank by relevance: exact match > prefix match > contains > fuzzy + arena_score
  const queryLower = sanitizedQuery.toLowerCase()
  const ranked = filteredSources
    .map((t) => {
      const key = `${t.source}:${t.source_trader_id}`
      const scoreRow = scoreMap.get(key)
      const handleLower = (t.handle || '').toLowerCase()
      const idLower = t.source_trader_id.toLowerCase()

      // Multi-tier relevance scoring
      let textRelevance = 0
      if (handleLower === queryLower || idLower === queryLower) textRelevance += 10000
      if (handleLower.startsWith(queryLower) || idLower.startsWith(queryLower)) textRelevance += 1000
      if (handleLower.includes(queryLower) || idLower.includes(queryLower)) textRelevance += 100
      if (usedFuzzy && t.relevance_score != null) textRelevance += t.relevance_score
      const arenaScore = scoreRow ? Number(scoreRow.arena_score) : 0
      const relevance = textRelevance + arenaScore * 0.1

      return { source: t, scoreRow, relevance, textRelevance }
    })
    // Filter out results with no meaningful text relevance — prevents false positives
    // from low trigram similarity matches that only rank due to arena score boost.
    // A textRelevance of 0 means no substring match AND no fuzzy score at all.
    .filter(r => r.textRelevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit)

  return ranked.map(({ source: t, scoreRow }): UnifiedTrader => {
    const plat = t.source
    return {
      platform: plat,
      traderKey: t.source_trader_id,
      handle: t.handle || null,
      avatarUrl: t.avatar_url || null,
      profileUrl: null,
      marketType: SOURCE_TYPE_MAP[plat] || null,
      sourceType: SOURCE_TYPE_MAP[plat] || null,
      roi: scoreRow?.roi != null ? Number(scoreRow.roi) : null,
      pnl: scoreRow?.pnl != null ? Number(scoreRow.pnl) : null,
      winRate: null, // Not fetched in search query (not needed for dropdown)
      maxDrawdown: null,
      tradesCount: null,
      followers: null,
      copiers: null,
      arenaScore: scoreRow?.arena_score != null ? Number(scoreRow.arena_score) : null,
      returnScore: null,
      pnlScore: null,
      drawdownScore: null,
      stabilityScore: null,
      profitabilityScore: null,
      riskControlScore: null,
      executionScore: null,
      scoreConfidence: null,
      rank: scoreRow?.rank != null ? Number(scoreRow.rank) : null,
      period: '90D',
      sharpeRatio: null,
      sortinoRatio: null,
      profitFactor: null,
      calmarRatio: null,
      tradingStyle: null,
      avgHoldingHours: null,
      traderType: (scoreRow?.trader_type as string) || (plat === 'web3_bot' ? 'bot' : null),
      isOutlier: false,
      lastUpdated: null,
    }
  })
}

/**
 * Get "did you mean" suggestions for a search query with few/no results.
 * Uses pg_trgm similarity to find closest matching trader handles.
 */
export async function getSearchSuggestions(supabase: SupabaseClient, query: string): Promise<string[]> {
  if (!query || query.length < 2) return []

  try {
    const { data, error } = await supabase.rpc('search_did_you_mean', {
      search_query: query,
      suggestion_limit: 3,
    })
    if (error || !data) return []
    return (data as Array<{ suggested_query: string; similarity_score: number }>)
      .filter(d => d.similarity_score > 0.2)
      .map(d => d.suggested_query)
  } catch {
    return []
  }
}

/**
 * Resolve a trader handle/ID to their canonical identity.
 * Used by: trader detail page to find the right trader
 *
 * Resolution chain:
 * 1. trader_sources by handle
 * 2. trader_sources by source_trader_id
 * 3. leaderboard_ranks by source_trader_id
 * 4. trader_profiles_v2 by trader_key
 */
export async function resolveTrader(supabase: SupabaseClient, params: {
  handle: string
  platform?: string
}): Promise<{ platform: string; traderKey: string; handle: string | null; avatarUrl: string | null } | null> {
  // Sanitize handle for PostgREST .or() filter safety — reject chars that break filter syntax
  const decodedHandle = decodeURIComponent(params.handle).replace(/[(),]/g, '')
  const platformFilter = params.platform

  // Steps 1+2 combined: Try traders table by handle OR trader_key (single query)
  {
    let query = supabase
      .from('traders')
      .select('platform, trader_key, handle, avatar_url')
      .or(`handle.eq.${decodedHandle},trader_key.eq.${decodedHandle}`)

    if (platformFilter) {
      query = query.eq('platform', platformFilter)
    }

    // Multiple traders may share the same handle (e.g., 鎏渊).
    // Pick the one with the highest arena_score in leaderboard to avoid resolving to a no-data entry.
    const { data: candidates } = await query.limit(10)
    let data = candidates?.[0] ?? null
    if (candidates && candidates.length > 1) {
      // Check which candidate has leaderboard data
      const ids = candidates.map((c: { trader_key: string }) => c.trader_key)
      const { data: lbCheck } = await supabase
        .from('leaderboard_ranks')
        .select(`${LR.source_trader_id}, ${LR.arena_score}`)
        .in(LR.source_trader_id, ids)
        .eq(LR.season_id, '90D')
        .not(LR.arena_score, 'is', null)
        .order(LR.arena_score, { ascending: false })
        .limit(1)
      if (lbCheck?.[0]) {
        data = candidates.find((c: { trader_key: string }) => c.trader_key === lbCheck[0][LR.source_trader_id]) || data
      }
    }
    if (data) {
      return {
        platform: data.platform,
        traderKey: data.trader_key,
        handle: data.handle || null,
        avatarUrl: data.avatar_url || null,
      }
    }
  }

  // Steps 3+4 in parallel: leaderboard_ranks + trader_profiles_v2
  // Search by BOTH source_trader_id AND handle/display_name to support platforms
  // where the URL uses the handle but the DB key is a numeric ID (e.g., eToro).
  {
    // leaderboard_ranks uses v1 naming: source → platform, source_trader_id → traderKey
    let lbQuery = supabase
      .from('leaderboard_ranks')
      .select(`${LR.source}, ${LR.source_trader_id}, ${LR.handle}, ${LR.avatar_url}`)
      .or(`${LR.source_trader_id}.eq.${decodedHandle},${LR.handle}.eq.${decodedHandle}`)
      .eq(LR.season_id, '90D')

    let profileQuery = supabase
      .from('trader_profiles_v2')
      .select('platform, trader_key, display_name, avatar_url')
      .or(`trader_key.eq.${decodedHandle},display_name.eq.${decodedHandle}`)

    if (platformFilter) {
      lbQuery = lbQuery.eq(LR.source, platformFilter)
      profileQuery = profileQuery.eq('platform', platformFilter)
    }

    const [lbResult, profileResult] = await Promise.all([
      lbQuery.limit(1).maybeSingle(),
      profileQuery.limit(1).maybeSingle(),
    ])

    if (lbResult.data) {
      return {
        platform: lbResult.data[LR.source],
        traderKey: lbResult.data[LR.source_trader_id],
        handle: lbResult.data[LR.handle] || null,
        avatarUrl: lbResult.data[LR.avatar_url] || null,
      }
    }

    if (profileResult.data) {
      return {
        platform: profileResult.data.platform,
        traderKey: profileResult.data.trader_key,
        handle: profileResult.data.display_name || null,
        avatarUrl: profileResult.data.avatar_url || null,
      }
    }
  }

  return null
}
