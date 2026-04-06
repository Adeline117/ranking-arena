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
  } catch (err) {
    logger.error('[unified] safeQuery unexpected exception:', err instanceof Error ? err.message : String(err))
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
}): Promise<{ traders: UnifiedTrader[]; total: number; error?: string }> {
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
       trades_count, followers, copiers, ${LR.arena_score}, ${LR.avatar_url}, ${LR.rank}, computed_at,
       profitability_score, risk_control_score, execution_score, score_completeness,
       trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio,
       trader_type, is_outlier, ${LR.season_id}`,
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

  // 10s timeout — leaderboard queries should be fast (indexed table)
  const { data, error, count } = await withTimeout(
    query as unknown as Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null; count: number | null }>,
    10_000
  ).catch(() => ({ data: null as Record<string, unknown>[] | null, error: { message: 'Query timeout after 10000ms' }, count: null as number | null }))

  if (error) {
    logger.error('[unified.getLeaderboard] Query error:', error.message)
    return { traders: [], total: 0, error: error.message }
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

  // --- Phase 1: Fetch basic data + profile in parallel (4 queries) ---
  // Profile queries (traders + trader_profiles_v2) don't depend on LR/v2 results,
  // so run them all in one Promise.all to save a sequential round trip (~100-200ms).
  const [lrResult, v2Result, sourceProfile, profileV2] = await withTimeout(
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
          .select(`${V2.platform}, ${V2.trader_key}, ${V2.window}, ${V2.roi_pct}, ${V2.pnl_usd}, win_rate, max_drawdown, trades_count, followers, copiers, sharpe_ratio, sortino_ratio, calmar_ratio, return_score, drawdown_score, stability_score, ${V2.arena_score}, created_at`)
          .eq(V2.platform, platform)
          .eq(V2.trader_key, traderKey)
          .order('created_at', { ascending: false })
          .limit(5)
      ),
      // Profile from traders table
      safeQuery(() =>
        supabase
          .from('traders')
          .select('trader_key, handle, profile_url, avatar_url, market_type')
          .eq('platform', platform)
          .eq('trader_key', traderKey)
          .limit(1)
          .maybeSingle()
      ) as Promise<Record<string, unknown> | null>,
      // Bio from trader_profiles_v2
      safeQuery(() =>
        supabase
          .from('trader_profiles_v2')
          .select('bio, display_name, avatar_url')
          .eq('platform', platform)
          .eq('trader_key', traderKey)
          .limit(1)
          .maybeSingle()
      ) as Promise<Record<string, unknown> | null>,
    ]),
    20000 // 20s: parallel queries compete for Supabase pool; 10s was too tight
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
  // Merge 3 equity_curve + 3 asset_breakdown queries into 2 (6→2, saves 4 round trips)
  const [
    allEquityCurveResult,
    allAssetBreakdownResult,
    statsDetailResult,
    portfolioResult,
    positionHistoryResult,
    trackedSinceResult,
    similarTradersResult,
  ] = await withTimeout(
    Promise.all([
      // Equity curves — all periods in single query, split client-side
      safeQuery(() =>
        supabase.from('trader_equity_curve')
          .select('period, data_date, roi_pct, pnl_usd')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey)
          .in('period', ['90D', '30D', '7D'])
          .order('data_date', { ascending: true }).limit(130)
      ),
      // Asset breakdowns — all periods in single query, split client-side
      safeQuery(() =>
        supabase.from('trader_asset_breakdown')
          .select('period, symbol, weight_pct')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey)
          .in('period', ['90D', '30D', '7D'])
          .order('weight_pct', { ascending: false }).limit(60)
      ),
      // Stats detail (all periods) — enrichment tables use v1 naming
      safeQuery(() =>
        supabase.from('trader_stats_detail')
          .select('sharpe_ratio, copiers_pnl, copiers_count, winning_positions, total_positions, total_trades, profitable_trades_pct, avg_holding_time_hours, avg_profit, avg_loss, largest_win, largest_loss, aum, period')
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
      // Filter to last 90 days to avoid scanning thousands of rows on 11GB table
      safeQuery(() =>
        supabase.from('trader_position_history')
          .select('symbol, direction, open_time, close_time, entry_price, exit_price, pnl_usd, pnl_pct, status')
          .in(ENRICH.source, sourceAliases).eq(ENRICH.source_trader_id, traderKey)
          .gte('open_time', new Date(Date.now() - 90 * 86400000).toISOString())
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
    20000 // 20s: parallel queries compete for Supabase pool; 10s was too tight
  )

  // Map equity curves — split merged result by period
  type EqRow = { period: string; data_date: string; roi_pct: number | null; pnl_usd: number | null }
  const allEqRows = (allEquityCurveResult || []) as EqRow[]
  const mapEquity = (period: string): EquityPoint[] =>
    allEqRows.filter(r => r.period === period).map(r => ({ date: r.data_date, roi: r.roi_pct, pnl: r.pnl_usd }))

  const equityCurve: Record<TradingPeriod, EquityPoint[]> = {
    '90D': mapEquity('90D'),
    '30D': mapEquity('30D'),
    '7D': mapEquity('7D'),
  }

  // Map asset breakdowns — split merged result by period
  type AbRow = { period: string; symbol: string; weight_pct: number }
  const allAbRows = (allAssetBreakdownResult || []) as AbRow[]
  const mapAssets = (period: string): AssetWeight[] =>
    allAbRows.filter(r => r.period === period).map(r => ({ symbol: r.symbol, weightPct: r.weight_pct }))

  const assetBreakdown: Record<TradingPeriod, AssetWeight[]> = {
    '90D': mapAssets('90D'),
    '30D': mapAssets('30D'),
    '7D': mapAssets('7D'),
  }

  // Map stats detail (prefer 90D)
  type StatsRow = {
    sharpe_ratio: number | null; copiers_pnl: number | null; copiers_count: number | null
    winning_positions: number | null; total_positions: number | null
    total_trades: number | null; profitable_trades_pct: number | null
    avg_holding_time_hours: number | null; avg_profit: number | null; avg_loss: number | null
    largest_win: number | null; largest_loss: number | null; aum: number | null; period: string | null
  }
  const statsRows = (statsDetailResult || []) as StatsRow[]
  // Prefer 90D row with actual data (non-null fields) over empty newer rows
  const hasData = (s: StatsRow) => s.avg_profit != null || s.largest_win != null || s.sharpe_ratio != null || s.winning_positions != null || s.total_trades != null
  const statsPrimary = statsRows.find(s => s.period === '90D' && hasData(s))
    || statsRows.find(s => s.period === '90D')
    || statsRows.find(s => hasData(s))
    || statsRows[0] || null

  const stats = statsPrimary ? {
    sharpeRatio: statsPrimary.sharpe_ratio,
    copiersPnl: statsPrimary.copiers_pnl,
    copiersCount: statsPrimary.copiers_count,
    winningPositions: statsPrimary.winning_positions,
    // Fallback: total_positions → total_trades (131K rows have total_trades but not total_positions)
    totalPositions: statsPrimary.total_positions ?? statsPrimary.total_trades,
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

  // 8s timeout — search should be fast; prevents UI hang on degraded Supabase
  return withTimeout(searchTradersInner(supabase, { query: query, limit, platform }), 8_000)
    .catch((err) => {
      logger.warn('[unified.searchTraders] Timeout or error:', err instanceof Error ? err.message : String(err))
      return [] as UnifiedTrader[]
    })
}

async function searchTradersInner(supabase: SupabaseClient, params: {
  query: string
  limit: number
  platform?: string
}): Promise<UnifiedTrader[]> {
  const { query, limit, platform } = params

  const sanitizedQuery = query
    .slice(0, 100)
    .replace(/[\\%_]/g, (c) => `\\${c}`)
    .replace(/[.,()]/g, '')

  if (!sanitizedQuery) return []

  // --- Try fuzzy RPC search first (handles typos via pg_trgm) ---
  // The RPC now returns arena_score/roi/pnl/rank/trader_type from leaderboard_ranks
  // in a single query, eliminating a serial second query that added ~200ms.
  type FuzzyResult = {
    source_trader_id: string; handle: string | null; source: string; avatar_url: string | null;
    relevance_score?: number; arena_score?: number | null; roi?: number | null; pnl?: number | null;
    rank?: number | null; trader_type?: string | null;
  }
  let sourcesData: FuzzyResult[] | null = null
  let usedFuzzy = false

  try {
    const { data: fuzzyData, error: fuzzyErr } = await supabase.rpc('search_traders_fuzzy', {
      search_query: sanitizedQuery,
      result_limit: limit * 4,
      platform_filter: platform || null,
    })
    if (!fuzzyErr && fuzzyData && fuzzyData.length > 0) {
      const qLower = sanitizedQuery.toLowerCase()
      const filtered = (fuzzyData as FuzzyResult[]).filter(t => {
        const handle = (t.handle || '').toLowerCase()
        const id = t.source_trader_id.toLowerCase()
        const hasSubstringMatch = handle.includes(qLower) || id.includes(qLower)
        if (hasSubstringMatch) return true
        const score = t.relevance_score ?? 0
        return score >= 250 && qLower.length >= 3
      })
      if (filtered.length > 0) {
        sourcesData = filtered
        usedFuzzy = true
      }
    }
  } catch (err) {
    // RPC not available (migration not applied), fall through to ILIKE
    logger.debug('[search] fuzzy RPC unavailable, falling back to ILIKE:', err instanceof Error ? err.message : String(err))
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

  // When fuzzy RPC was used, scores are already included — skip second query.
  // Only fetch from leaderboard_ranks when using ILIKE fallback.
  let scoreMap = new Map<string, Record<string, unknown>>()
  if (!usedFuzzy) {
    const traderIds = filteredSources.map(t => t.source_trader_id)
    const { data: scoreRows } = await supabase
      .from('leaderboard_ranks')
      .select(`${LR.source}, ${LR.source_trader_id}, ${LR.arena_score}, ${LR.roi}, ${LR.pnl}, ${LR.rank}, ${LR.season_id}, trader_type`)
      .in(LR.source_trader_id, traderIds.slice(0, 200))
      .eq(LR.season_id, '90D')
      .not(LR.arena_score, 'is', null)
      .order(LR.arena_score, { ascending: false })

    for (const row of (scoreRows || [])) {
      const key = `${row.source}:${row.source_trader_id}`
      if (!scoreMap.has(key)) scoreMap.set(key, row)
    }
  } else {
    // Build scoreMap from fuzzy results (already has LR data)
    for (const t of filteredSources) {
      const key = `${t.source}:${t.source_trader_id}`
      scoreMap.set(key, {
        source: t.source,
        source_trader_id: t.source_trader_id,
        arena_score: t.arena_score ?? null,
        roi: t.roi ?? null,
        pnl: t.pnl ?? null,
        rank: t.rank ?? null,
        trader_type: t.trader_type ?? null,
      })
    }
  }

  // Rank by relevance: exact match > prefix match > contains > fuzzy + arena_score
  const queryLower = sanitizedQuery.toLowerCase()
  const ranked = filteredSources
    .map((t) => {
      const key = `${t.source}:${t.source_trader_id}`
      const scoreRow = scoreMap.get(key)
      const handleLower = (t.handle || '').toLowerCase()
      const idLower = t.source_trader_id.toLowerCase()

      let textRelevance = 0
      if (handleLower === queryLower || idLower === queryLower) textRelevance += 10000
      if (handleLower.startsWith(queryLower) || idLower.startsWith(queryLower)) textRelevance += 1000
      if (handleLower.includes(queryLower) || idLower.includes(queryLower)) textRelevance += 100
      if (usedFuzzy && t.relevance_score != null) textRelevance += t.relevance_score
      const arenaScore = scoreRow ? Number(scoreRow.arena_score) : 0
      const relevance = textRelevance + arenaScore * 0.1

      return { source: t, scoreRow, relevance, textRelevance }
    })
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
      winRate: null,
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
  } catch (err) {
    logger.debug('[search] did-you-mean RPC failed:', err instanceof Error ? err.message : String(err))
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

  // Step 5: Last resort — check trader_snapshots_v2 directly
  // Some traders exist in snapshots (written by VPS scraper-cron) but not in
  // trader_sources or leaderboard_ranks (e.g., freshly discovered traders).
  {
    let svQuery = supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key')
      .eq(V2.trader_key, decodedHandle)
      .order('updated_at', { ascending: false })

    if (platformFilter) {
      svQuery = svQuery.eq(V2.platform, platformFilter)
    }

    const { data: svResult } = await svQuery.limit(1).maybeSingle()
    if (svResult) {
      return {
        platform: svResult.platform,
        traderKey: svResult.trader_key,
        handle: null,
        avatarUrl: null,
      }
    }
  }

  return null
}
