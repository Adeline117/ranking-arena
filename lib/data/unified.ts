/**
 * Unified Data Access Layer — THE single source of truth for all data queries.
 *
 * All frontend components and API routes should use these functions instead of
 * querying trader_snapshots, trader_snapshots_v2, or leaderboard_ranks directly.
 *
 * Field name mapping is handled internally:
 * - leaderboard_ranks: source → platform, source_trader_id → traderKey, season_id → period
 * - trader_snapshots v1: source → platform, source_trader_id → traderKey, season_id → period, roi (ratio) → roi (pct)
 * - trader_snapshots_v2: platform → platform, trader_key → traderKey, window → period, roi_pct → roi, pnl_usd → pnl
 * - enrichment tables (equity_curve, asset_breakdown, etc.): source + source_trader_id naming
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  UnifiedTrader,
  TraderDetail,
  TradingPeriod,
  EquityPoint,
  AssetWeight,
  TraderPosition,
} from '@/lib/types/unified-trader'
import { SOURCE_TYPE_MAP, EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { logger } from '@/lib/logger'

// ============================================================
// INTERNAL: Period normalization
// ============================================================

/** Normalize window/season_id values to canonical TradingPeriod */
function normalizePeriod(raw: string | null | undefined): TradingPeriod {
  if (!raw) return '90D'
  const upper = raw.toUpperCase()
  if (upper === '7D') return '7D'
  if (upper === '30D') return '30D'
  return '90D'
}

// ============================================================
// INTERNAL: Win rate normalization (ratio → percentage)
// ============================================================

/** Normalize win_rate: if <=1, treat as ratio and multiply by 100. Clamp to 0-100. */
function normalizeWinRate(wr: number | null | undefined): number | null {
  if (wr == null) return null
  const pct = wr <= 1 ? wr * 100 : wr
  return Math.max(0, Math.min(100, pct))
}

// ============================================================
// INTERNAL: Source alias mapping for enrichment tables
// ============================================================

/**
 * Legacy source name mapping: some tables (equity_curve, position_history, etc.)
 * use old source names like 'binance' instead of 'binance_futures'.
 */
const SOURCE_ALIASES: Record<string, string[]> = {
  binance_futures: ['binance', 'binance_futures'],
  bitget_futures: ['bitget', 'bitget_futures'],
  binance_spot: ['binance_spot'],
  bitget_spot: ['bitget_spot'],
  bybit: ['bybit'],
  bybit_spot: ['bybit_spot'],
  okx_futures: ['okx_futures'],
  okx_spot: ['okx_spot'],
  okx_web3: ['okx', 'okx_web3'],
  okx_wallet: ['okx_wallet'],
  mexc: ['mexc'],
  kucoin: ['kucoin'],
  coinex: ['coinex'],
  htx_futures: ['htx_futures', 'htx'],
  weex: ['weex'],
  phemex: ['phemex'],
  bingx: ['bingx'],
  gateio: ['gateio'],
  xt: ['xt'],
  lbank: ['lbank'],
  blofin: ['blofin'],
  bitmart: ['bitmart'],
  hyperliquid: ['hyperliquid'],
  gmx: ['gmx'],
  dydx: ['dydx'],
  gains: ['gains'],
  jupiter_perps: ['jupiter_perps'],
  aevo: ['aevo'],
  binance_web3: ['binance_web3'],
  web3_bot: ['web3_bot'],
  drift: ['drift'],
  btcc: ['btcc'],
  bitunix: ['bitunix'],
  bitfinex: ['bitfinex'],
  toobit: ['toobit'],
  etoro: ['etoro'],
  kwenta: ['kwenta'],
}

function getSourceAliases(platform: string): string[] {
  return SOURCE_ALIASES[platform] || [platform]
}

// ============================================================
// FIELD MAPPING — the single place where v1/v2/lr differences live
// ============================================================

/**
 * Map leaderboard_ranks row → UnifiedTrader.
 * leaderboard_ranks uses: source, source_trader_id, season_id, roi (already pct), pnl (USD)
 */
function mapLeaderboardRow(row: Record<string, unknown>): UnifiedTrader {
  const platform = String(row.source || '')
  return {
    // Identity
    platform,
    traderKey: String(row.source_trader_id || ''),
    handle: (row.handle as string) || null,
    avatarUrl: (row.avatar_url as string) || null,
    profileUrl: null, // leaderboard_ranks does not store profile_url
    marketType: (row.source_type as string) || SOURCE_TYPE_MAP[platform] || null,
    sourceType: SOURCE_TYPE_MAP[platform] || null,

    // Performance — leaderboard_ranks stores roi as percentage already
    roi: row.roi != null ? Number(row.roi) : null,
    pnl: row.pnl != null ? Number(row.pnl) : null,
    winRate: normalizeWinRate(row.win_rate as number | null),
    maxDrawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
    tradesCount: row.trades_count != null ? Number(row.trades_count) : null,
    followers: row.followers != null ? Number(row.followers) : null,
    copiers: null, // not in leaderboard_ranks

    // Scores
    arenaScore: row.arena_score != null ? Number(row.arena_score) : null,
    returnScore: row.return_score != null ? Number(row.return_score) : null,
    pnlScore: row.pnl_score != null ? Number(row.pnl_score) : null,
    drawdownScore: row.drawdown_score != null ? Number(row.drawdown_score) : null,
    stabilityScore: row.stability_score != null ? Number(row.stability_score) : null,
    profitabilityScore: row.profitability_score != null ? Number(row.profitability_score) : null,
    riskControlScore: row.risk_control_score != null ? Number(row.risk_control_score) : null,
    executionScore: row.execution_score != null ? Number(row.execution_score) : null,
    scoreConfidence: (row.score_completeness as string) || null,

    // Rankings
    rank: row.rank != null ? Number(row.rank) : null,
    period: normalizePeriod(row.season_id as string),

    // Advanced metrics
    sharpeRatio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
    sortinoRatio: row.sortino_ratio != null ? Number(row.sortino_ratio) : null,
    profitFactor: row.profit_factor != null ? Number(row.profit_factor) : null,
    calmarRatio: row.calmar_ratio != null ? Number(row.calmar_ratio) : null,
    tradingStyle: (row.trading_style as string) || null,
    avgHoldingHours: row.avg_holding_hours != null ? Number(row.avg_holding_hours) : null,

    // Metadata
    traderType: (row.trader_type as string) || (platform === 'web3_bot' ? 'bot' : null),
    isOutlier: row.is_outlier === true,
    lastUpdated: (row.computed_at as string) || null,
  }
}

/**
 * Map trader_snapshots v1 row → Partial<UnifiedTrader>.
 * v1 uses: source, source_trader_id, season_id
 * IMPORTANT: v1 roi is stored as a RATIO (0.5 = 50%), must multiply by 100 for percentage.
 */
function mapV1Snapshot(row: Record<string, unknown>, period: TradingPeriod): Partial<UnifiedTrader> {
  return {
    platform: String(row.source || ''),
    traderKey: String(row.source_trader_id || ''),
    // v1 ROI is ratio — multiply by 100 to get percentage
    roi: row.roi != null ? Number(row.roi) * 100 : null,
    pnl: row.pnl != null ? Number(row.pnl) : null,
    winRate: normalizeWinRate(row.win_rate as number | null),
    maxDrawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
    tradesCount: row.trades_count != null ? Number(row.trades_count) : null,
    followers: row.followers != null ? Number(row.followers) : null,
    arenaScore: row.arena_score != null ? Number(row.arena_score) : null,
    profitabilityScore: row.profitability_score != null ? Number(row.profitability_score) : null,
    riskControlScore: row.risk_control_score != null ? Number(row.risk_control_score) : null,
    executionScore: row.execution_score != null ? Number(row.execution_score) : null,
    period,
    lastUpdated: (row.captured_at as string) || null,
  }
}

/**
 * Map trader_snapshots_v2 row → Partial<UnifiedTrader>.
 * v2 uses: platform, trader_key, window, roi_pct (already percentage), pnl_usd
 */
function mapV2Snapshot(row: Record<string, unknown>, period?: TradingPeriod): Partial<UnifiedTrader> {
  return {
    platform: String(row.platform || ''),
    traderKey: String(row.trader_key || ''),
    // v2 roi_pct is already percentage
    roi: row.roi_pct != null ? Number(row.roi_pct) : null,
    pnl: row.pnl_usd != null ? Number(row.pnl_usd) : null,
    winRate: normalizeWinRate(row.win_rate as number | null),
    maxDrawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
    tradesCount: row.trades_count != null ? Number(row.trades_count) : null,
    followers: row.followers != null ? Number(row.followers) : null,
    copiers: row.copiers != null ? Number(row.copiers) : null,
    sharpeRatio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
    arenaScore: row.arena_score != null ? Number(row.arena_score) : null,
    period: period || normalizePeriod(row.window as string),
    lastUpdated: (row.created_at as string) || null,
  }
}

// ============================================================
// INTERNAL: Safe query helper
// ============================================================

/** Run a Supabase query, returning null on error (including missing table). */
async function safeQuery<T>(
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
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error(`Query timeout after ${ms}ms`)), ms)
  )
  return Promise.race([promise, timeout])
}

// ============================================================
// PUBLIC API — these are the ONLY functions frontend should call
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

  // Build query
  let query = supabase
    .from('leaderboard_ranks')
    .select(
      `source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown,
       trades_count, followers, arena_score, avatar_url, rank, computed_at,
       profitability_score, risk_control_score, execution_score, score_completeness,
       trading_style, avg_holding_hours, sharpe_ratio, trader_type, is_outlier, season_id`,
      { count: 'exact' }
    )
    .eq('season_id', period)

  if (platform) {
    query = query.eq('source', platform)
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
 * 2. trader_snapshots v1 (legacy, per-period rows)
 * 3. trader_snapshots_v2 (Connector path, per-period rows)
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

  // ─── Phase 1: Fetch basic data from all three sources in parallel ────────
  const [lrResult, v1Result, v2Result] = await withTimeout(
    Promise.all([
      // leaderboard_ranks: all periods
      safeQuery(() =>
        supabase
          .from('leaderboard_ranks')
          .select(`source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown,
                   trades_count, followers, arena_score, avatar_url, rank, computed_at,
                   profitability_score, risk_control_score, execution_score, score_completeness,
                   trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, profit_factor,
                   calmar_ratio, trader_type, is_outlier, season_id`)
          .eq('source', platform)
          .eq('source_trader_id', traderKey)
          .limit(5)
      ),
      // trader_snapshots v1: all periods
      safeQuery(() =>
        supabase
          .from('trader_snapshots')
          .select('source, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, followers, captured_at, season_id, arena_score, profitability_score, risk_control_score, execution_score')
          .eq('source', platform)
          .eq('source_trader_id', traderKey)
          .order('captured_at', { ascending: false })
          .limit(5)
      ),
      // trader_snapshots_v2: all windows
      safeQuery(() =>
        supabase
          .from('trader_snapshots_v2')
          .select('platform, trader_key, window, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, sharpe_ratio, arena_score, created_at')
          .eq('platform', platform)
          .eq('trader_key', traderKey)
          .order('created_at', { ascending: false })
          .limit(5)
      ),
    ]),
    10000
  )

  const lrRows = (lrResult || []) as Record<string, unknown>[]
  const v1Rows = (v1Result || []) as Record<string, unknown>[]
  const v2Rows = (v2Result || []) as Record<string, unknown>[]

  // Build per-period data using fallback chain: LR → v1 → v2
  const periods: Record<TradingPeriod, Partial<UnifiedTrader> | null> = {
    '7D': null,
    '30D': null,
    '90D': null,
  }

  for (const p of ['90D', '30D', '7D'] as TradingPeriod[]) {
    // Try leaderboard_ranks first
    const lrRow = lrRows.find(r => normalizePeriod(r.season_id as string) === p)
    if (lrRow) {
      const mapped = mapLeaderboardRow(lrRow)
      periods[p] = mapped
      continue
    }

    // Fallback: trader_snapshots v1
    const v1Row = v1Rows.find(r =>
      normalizePeriod(r.season_id as string) === p
    )
    if (v1Row) {
      periods[p] = mapV1Snapshot(v1Row, p)
      continue
    }

    // Fallback: trader_snapshots_v2
    const v2Row = v2Rows.find(r =>
      normalizePeriod(r.window as string) === p
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

  // Get profile info from trader_sources for avatar, profile_url, handle
  const sourceProfile = await safeQuery(() =>
    supabase
      .from('trader_sources')
      .select('source_trader_id, handle, profile_url, avatar_url, market_type')
      .eq('source', platform)
      .eq('source_trader_id', traderKey)
      .limit(1)
      .maybeSingle()
  ) as Record<string, unknown> | null

  const trader: UnifiedTrader = {
    platform,
    traderKey,
    handle: (sourceProfile?.handle as string) || primaryData.handle || null,
    avatarUrl: (sourceProfile?.avatar_url as string) || primaryData.avatarUrl || null,
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

  // ─── Phase 2: Fetch enrichment data in parallel ──────────────────────────
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
      // Equity curves (3 periods)
      safeQuery(() =>
        supabase.from('trader_equity_curve')
          .select('data_date, roi_pct, pnl_usd')
          .in('source', sourceAliases).eq('source_trader_id', traderKey).eq('period', '90D')
          .order('data_date', { ascending: true }).limit(90)
      ),
      safeQuery(() =>
        supabase.from('trader_equity_curve')
          .select('data_date, roi_pct, pnl_usd')
          .in('source', sourceAliases).eq('source_trader_id', traderKey).eq('period', '30D')
          .order('data_date', { ascending: true }).limit(30)
      ),
      safeQuery(() =>
        supabase.from('trader_equity_curve')
          .select('data_date, roi_pct, pnl_usd')
          .in('source', sourceAliases).eq('source_trader_id', traderKey).eq('period', '7D')
          .order('data_date', { ascending: true }).limit(7)
      ),
      // Asset breakdowns (3 periods)
      safeQuery(() =>
        supabase.from('trader_asset_breakdown')
          .select('symbol, weight_pct')
          .in('source', sourceAliases).eq('source_trader_id', traderKey).eq('period', '90D')
          .order('weight_pct', { ascending: false }).limit(20)
      ),
      safeQuery(() =>
        supabase.from('trader_asset_breakdown')
          .select('symbol, weight_pct')
          .in('source', sourceAliases).eq('source_trader_id', traderKey).eq('period', '30D')
          .order('weight_pct', { ascending: false }).limit(20)
      ),
      safeQuery(() =>
        supabase.from('trader_asset_breakdown')
          .select('symbol, weight_pct')
          .in('source', sourceAliases).eq('source_trader_id', traderKey).eq('period', '7D')
          .order('weight_pct', { ascending: false }).limit(20)
      ),
      // Stats detail (all periods)
      safeQuery(() =>
        supabase.from('trader_stats_detail')
          .select('sharpe_ratio, copiers_pnl, copiers_count, winning_positions, total_positions, avg_holding_time_hours, avg_profit, avg_loss, aum, period')
          .in('source', sourceAliases).eq('source_trader_id', traderKey)
          .order('captured_at', { ascending: false }).limit(3)
      ),
      // Portfolio
      safeQuery(() =>
        supabase.from('trader_portfolio')
          .select('symbol, direction, invested_pct, entry_price, pnl')
          .in('source', sourceAliases).eq('source_trader_id', traderKey)
          .order('captured_at', { ascending: false }).limit(50)
      ),
      // Position history
      safeQuery(() =>
        supabase.from('trader_position_history')
          .select('symbol, direction, open_time, close_time, entry_price, exit_price, pnl_usd, pnl_pct, status')
          .in('source', sourceAliases).eq('source_trader_id', traderKey)
          .order('open_time', { ascending: false }).limit(100)
      ),
      // Tracked since
      safeQuery(() =>
        supabase.from('trader_snapshots')
          .select('captured_at')
          .eq('source', platform).eq('source_trader_id', traderKey)
          .order('captured_at', { ascending: true }).limit(1).maybeSingle()
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
    aum: number | null; period: string | null
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
  const trackedSince = (trackedSinceResult as Record<string, unknown> | null)?.captured_at as string | null ?? null

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
  }
}

/**
 * Search traders by name/handle.
 * Used by: search bar, /search
 * Source: trader_sources + leaderboard_ranks for score-based ranking
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

  // Search trader_sources by handle or source_trader_id
  let sourcesQuery = supabase
    .from('trader_sources')
    .select('source_trader_id, handle, source, avatar_url')
    .or(`handle.ilike.%${sanitizedQuery}%,source_trader_id.ilike.%${sanitizedQuery}%`)

  if (platform) {
    sourcesQuery = sourcesQuery.eq('source', platform)
  }

  const { data: sourcesData, error: sourcesErr } = await sourcesQuery.limit(limit * 4)

  if (sourcesErr || !sourcesData || sourcesData.length === 0) {
    return []
  }

  // Fetch arena scores from leaderboard_ranks for ranking
  const traderIds = sourcesData.map(t => t.source_trader_id)
  const { data: scoreRows } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, arena_score, roi, pnl, win_rate, max_drawdown, followers, rank, season_id')
    .in('source_trader_id', traderIds.slice(0, 200))
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .order('arena_score', { ascending: false })

  // Build score map
  const scoreMap = new Map<string, Record<string, unknown>>()
  for (const row of (scoreRows || [])) {
    const key = `${row.source}:${row.source_trader_id}`
    if (!scoreMap.has(key)) scoreMap.set(key, row)
  }

  // Rank by relevance: exact match > prefix match > arena_score
  const queryLower = sanitizedQuery.toLowerCase()
  const ranked = sourcesData
    .map((t) => {
      const key = `${t.source}:${t.source_trader_id}`
      const scoreRow = scoreMap.get(key)
      const handleLower = (t.handle || '').toLowerCase()
      const exactBonus = handleLower === queryLower ? 10000 : 0
      const prefixBonus = handleLower.startsWith(queryLower) ? 1000 : 0
      const arenaScore = scoreRow ? Number(scoreRow.arena_score) : 0
      return { source: t, scoreRow, relevance: exactBonus + prefixBonus + arenaScore }
    })
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
      winRate: normalizeWinRate(scoreRow?.win_rate as number | null | undefined),
      maxDrawdown: scoreRow?.max_drawdown != null ? Number(scoreRow.max_drawdown) : null,
      tradesCount: null,
      followers: scoreRow?.followers != null ? Number(scoreRow.followers) : null,
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
      traderType: plat === 'web3_bot' ? 'bot' : null,
      isOutlier: false,
      lastUpdated: null,
    }
  })
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
  const decodedHandle = decodeURIComponent(params.handle)
  const platformFilter = params.platform

  // 1. Try trader_sources by handle
  {
    let query = supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle, avatar_url')
      .eq('handle', decodedHandle)

    if (platformFilter) {
      query = query.eq('source', platformFilter)
    }

    const { data } = await query.limit(1).maybeSingle()
    if (data) {
      return {
        platform: data.source,
        traderKey: data.source_trader_id,
        handle: data.handle || null,
        avatarUrl: data.avatar_url || null,
      }
    }
  }

  // 2. Try trader_sources by source_trader_id
  {
    let query = supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle, avatar_url')
      .eq('source_trader_id', decodedHandle)

    if (platformFilter) {
      query = query.eq('source', platformFilter)
    }

    const { data } = await query.limit(1).maybeSingle()
    if (data) {
      return {
        platform: data.source,
        traderKey: data.source_trader_id,
        handle: data.handle || null,
        avatarUrl: data.avatar_url || null,
      }
    }
  }

  // 3. Try leaderboard_ranks by source_trader_id (covers traders not in trader_sources)
  {
    let query = supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, handle, avatar_url')
      .eq('source_trader_id', decodedHandle)
      .eq('season_id', '90D')

    if (platformFilter) {
      query = query.eq('source', platformFilter)
    }

    const { data } = await query.limit(1).maybeSingle()
    if (data) {
      return {
        platform: data.source,
        traderKey: data.source_trader_id,
        handle: data.handle || null,
        avatarUrl: data.avatar_url || null,
      }
    }
  }

  // 4. Try trader_profiles_v2 by trader_key
  {
    let query = supabase
      .from('trader_profiles_v2')
      .select('platform, trader_key, display_name, avatar_url')
      .eq('trader_key', decodedHandle)

    if (platformFilter) {
      query = query.eq('platform', platformFilter)
    }

    const { data } = await query.limit(1).maybeSingle()
    if (data) {
      return {
        platform: data.platform,
        traderKey: data.trader_key,
        handle: data.display_name || null,
        avatarUrl: data.avatar_url || null,
      }
    }
  }

  return null
}

// ============================================================
// INTERNAL: Similar traders helper
// ============================================================

async function fetchSimilarTraders(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string,
  arenaScore: number | null,
  roi: number | null,
): Promise<UnifiedTrader[]> {
  try {
    let data: Record<string, unknown>[] | null = null

    if (arenaScore != null) {
      const scoreRange = Math.max(arenaScore * 0.25, 10)
      const result = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate, max_drawdown, followers, rank, season_id, source_type, trader_type, computed_at')
        .eq('source', platform)
        .eq('season_id', '90D')
        .neq('source_trader_id', traderKey)
        .not('arena_score', 'is', null)
        .gte('arena_score', arenaScore - scoreRange)
        .lte('arena_score', arenaScore + scoreRange)
        .order('arena_score', { ascending: false })
        .limit(10)
      data = result.data as Record<string, unknown>[] | null
    } else if (roi != null) {
      const roiRange = Math.max(Math.abs(roi) * 0.3, 20)
      const result = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate, max_drawdown, followers, rank, season_id, source_type, trader_type, computed_at')
        .eq('source', platform)
        .eq('season_id', '90D')
        .neq('source_trader_id', traderKey)
        .gte('roi', roi - roiRange)
        .lte('roi', roi + roiRange)
        .order('roi', { ascending: false })
        .limit(10)
      data = result.data as Record<string, unknown>[] | null
    }

    if (!data || data.length === 0) return []

    // Dedupe and map
    const seen = new Set<string>()
    return data
      .filter(row => {
        const id = String(row.source_trader_id || '')
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map(row => mapLeaderboardRow(row))
  } catch {
    return []
  }
}
