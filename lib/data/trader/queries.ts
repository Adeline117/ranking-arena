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
import { isRetiredSource } from '@/lib/constants/retired-sources'
import { logger } from '@/lib/logger'
import { mapLeaderboardRow, normalizePeriod, getSourceAliases } from './mappers'
import { fetchSimilarTraders } from './similar'
import { LR, ENRICH } from '@/lib/types/schema-mapping'
import { SSR_HEAVY_QUERY_TIMEOUT_MS } from '@/lib/constants/timeouts'
import { type DataResult, success, failure } from '@/lib/types/result'
import {
  PUBLIC_RANKING_QUARANTINED_SOURCES,
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import {
  fetchPublicProfileRankingRows,
  PUBLIC_PROFILE_RANKING_COLUMNS,
  PUBLIC_PROFILE_RANKING_PERIODS,
} from './public-profile-ranking'

// Database types are generated after the migration is applied. Keep the one
// ungenerated relation name isolated here rather than hand-editing generated
// Supabase types during the rolling migration deployment.
const PUBLIC_RANKED_LEADERBOARD = 'public_ranked_leaderboard' as const
/** Default freshness window shared by the homepage cache revalidator. */
export const PUBLIC_LEADERBOARD_FRESH_COMPUTED_AGE_MS = 6 * 60 * 60 * 1000

/**
 * Ranking columns required to prove a search result belongs to the current
 * public cohort. Keep this complete: sanitizePublicRankingPayload deliberately
 * rejects rows whose basis, freshness, or score proof is missing.
 */
const PUBLIC_SEARCH_RANKING_COLUMNS =
  'season_id,source,source_trader_id,handle,avatar_url,rank,arena_score,roi,pnl,win_rate,max_drawdown,trades_count,followers,copiers,profitability_score,risk_control_score,execution_score,score_completeness,metrics_estimated,is_outlier,computed_at,trading_style,avg_holding_hours,sharpe_ratio,sortino_ratio,profit_factor,calmar_ratio,trader_type,source_type,rank_change,is_new'

const PUBLIC_SEARCH_PERIOD: TradingPeriod = '90D'
const MAX_PUBLIC_SEARCH_CANDIDATES = 200

/**
 * Identity/relevance candidate from fuzzy, Meilisearch, or trader_sources.
 * These fields are deliberately non-metric: a caller must materialize the
 * candidate against public_ranked_leaderboard before exposing rank/ROI/PnL or
 * Arena Score.
 */
export interface PublicSearchTraderCandidate {
  platform: string
  traderKey: string
  handle: string | null
  avatarUrl: string | null
  traderType?: string | null
}

// ============================================================
// INTERNAL: Safe query helper
// ============================================================

/**
 * Run a Supabase query, returning DataResult to distinguish errors from empty results.
 * Known non-fatal errors (missing table during migration) return success(null).
 */
export async function safeQuery<T>(
  queryFn: () => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>
): Promise<DataResult<T | null>> {
  try {
    const result = await queryFn()
    if (
      result.error &&
      (result.error.code === '42P01' ||
        result.error.message?.includes('does not exist') ||
        result.error.message?.includes('relation'))
    ) {
      // Schema object missing (42P01 表 / 42703 列 "does not exist")。
      // 2026-06 教训:此处过去静默返回 null,正是 schema 漂移长期隐形、
      // 发帖/支付/点赞静默 500 数天无人知的根源。必须 log —— 迁移中的临时
      // 缺失是噪音,但持续出现 = 漂移信号(被 schema-contract-check / 哨兵抓)。
      logger.warn(
        '[safeQuery] schema object missing (drift?):',
        result.error.code,
        result.error.message
      )
      return success(null)
    }
    if (result.error) {
      logger.warn('[unified] Query error:', result.error.message)
      return failure(result.error.message || 'Unknown query error')
    }
    return success(result.data)
  } catch (err) {
    logger.error(
      '[unified] safeQuery unexpected exception:',
      err instanceof Error ? err.message : String(err)
    )
    return failure(err instanceof Error ? err.message : 'Unexpected query error')
  }
}

/** Extract data from a DataResult, returning null on failure (for graceful degradation). */
function unwrap<T>(result: DataResult<T>): T | undefined {
  return result.ok ? result.data : undefined
}

/**
 * Promise timeout wrapper (legacy — prefer AbortSignal for new code).
 * For individual Supabase queries, use `.abortSignal(AbortSignal.timeout(ms))`
 * which actually cancels the HTTP request vs just abandoning it.
 */
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
 * Source: public_ranked_leaderboard database publication authority.
 * Response-level caches may cache this result, but sorted-set position is not
 * rank authority.
 */
export async function getLeaderboard(
  supabase: SupabaseClient,
  params: {
    platform?: string
    period?: TradingPeriod
    limit?: number
    offset?: number
    minScore?: number
    /**
     * Compatibility-only. The public cohort view always excludes outliers as
     * part of its database eligibility contract.
     */
    excludeOutliers?: boolean
    sortBy?: 'rank' | 'arena_score' | 'roi' | 'pnl'
    /** Optional SQL allowlist applied before finite pagination. */
    allowedSources?: readonly string[]
    /** Optional source quarantine for ranking callers. */
    excludeSources?: readonly string[]
    /** Allow data up to 24h old instead of 6h (graceful degradation) */
    allowStale?: boolean
    /** Share a caller-owned cancellation deadline across related Supabase queries. */
    signal?: AbortSignal
  }
): Promise<{
  traders: UnifiedTrader[]
  /**
   * Exact cohort total, when a same-predicate count authority is available.
   * This reader deliberately has none, so it omits this field rather than
   * presenting a page-derived lower bound as a total. `undefined` preserves
   * the existing API contract, whose response layer omits unknown totals.
   */
  total?: number
  totalCountIsExact: boolean
  /** Whether this SQL-filtered cohort has another row after this page. */
  hasMore: boolean
  error?: string
}> {
  const {
    platform,
    period = '90D',
    limit = 50,
    offset = 0,
    minScore,
    sortBy = 'rank',
    allowedSources = [],
    excludeSources = [],
    signal,
  } = params
  if (platform && !isPublicRankingSourceAllowed(platform)) {
    return { traders: [], totalCountIsExact: false, hasMore: false }
  }
  const requiredExclusions = [
    ...new Set([...excludeSources, ...PUBLIC_RANKING_QUARANTINED_SOURCES]),
  ]

  // The security-barrier view applies rank membership, source freshness, and
  // complete/non-estimated row eligibility before every caller predicate and
  // before the finite range below. Do not query leaderboard_ranks and filter a
  // page in application code.
  //
  // The view is not in generated Supabase types until the migration has run in
  // each environment. This local relation cast is the rolling-deploy bridge;
  // do not hand-edit lib/supabase/database.types.ts.
  let query = supabase
    .from(PUBLIC_RANKED_LEADERBOARD as never)
    .select(
      `${LR.source_trader_id}, ${LR.handle}, ${LR.source}, source_type, ${LR.roi}, ${LR.pnl}, win_rate, max_drawdown,
       trades_count, followers, copiers, ${LR.arena_score}, ${LR.avatar_url}, ${LR.rank}, rank_change, is_new, computed_at,
       profitability_score, risk_control_score, execution_score, score_completeness, metrics_estimated,
       trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio,
       trader_type, is_outlier, ${LR.season_id}`
    )
    .eq(LR.season_id, period)

  if (allowedSources.length > 0) {
    query = query.in(LR.source, [...new Set(allowedSources)])
  }
  if (requiredExclusions.length > 0) {
    query = query.not(LR.source, 'in', `(${requiredExclusions.join(',')})`)
  }
  if (platform) {
    query = query.eq(LR.source, platform)
  }

  if (minScore != null) {
    query = query.gt('arena_score', minScore)
  }

  // Graceful freshness: prefer data <6h old, but fall back to <24h rather than
  // showing empty rankings. The UI should indicate staleness for >6h data.
  const STALE_FALLBACK_HOURS = 24
  const freshCutoff = new Date(Date.now() - PUBLIC_LEADERBOARD_FRESH_COMPUTED_AGE_MS).toISOString()
  const staleCutoff = new Date(Date.now() - STALE_FALLBACK_HOURS * 3600_000).toISOString()
  const effectiveCutoff = params.allowStale ? staleCutoff : freshCutoff
  query = query.gte('computed_at', effectiveCutoff)

  // Sorting
  const sortColumn =
    sortBy === 'arena_score'
      ? 'arena_score'
      : sortBy === 'roi'
        ? 'roi'
        : sortBy === 'pnl'
          ? 'pnl'
          : 'rank'

  const ascending = sortBy === 'rank'
  query = query.order(sortColumn, { ascending, nullsFirst: false })
  if (sortColumn !== 'rank') {
    query = query.order('rank', { ascending: true, nullsFirst: false })
  }

  // Supabase range end is inclusive. Fetch one extra row from the already
  // security-filtered view so callers get truthful pagination without an
  // expensive or differently-scoped exact count request.
  query = query.range(offset, offset + limit)

  const querySignal = signal ?? AbortSignal.timeout(SSR_HEAVY_QUERY_TIMEOUT_MS)
  const { data, error } = await Promise.resolve(query.abortSignal(querySignal)).catch(() => ({
    data: null as Record<string, unknown>[] | null,
    error: { message: `Query timeout after ${SSR_HEAVY_QUERY_TIMEOUT_MS}ms` },
  }))

  if (error) {
    logger.error('[unified.getLeaderboard] Query error:', error.message)
    return {
      traders: [],
      totalCountIsExact: false,
      hasMore: false,
      error: error.message,
    }
  }

  const cohortRows = data || []
  const hasMore = cohortRows.length > limit
  const pageRows = hasMore ? cohortRows.slice(0, limit) : cohortRows
  const traders = pageRows.map((row: Record<string, unknown>) => mapLeaderboardRow(row))

  // Do not read leaderboard_count_cache or return a page-derived lower bound
  // as `total`: neither proves the total for this view plus caller predicates.
  // A dedicated same-predicate count authority may populate `total` in a
  // future reader revision. Until then `hasMore` is the only paging contract.
  const totalCountIsExact = false

  return { traders, totalCountIsExact, hasMore }
}

/**
 * Get full trader detail for the trader profile page.
 * Used by: /trader/[handle], /api/traders/[handle]
 *
 * Per-period ranking data comes only from public_ranked_leaderboard. The
 * security-barrier view suppresses any incomplete/estimated/raw observation;
 * profile identity can still render with unknown ranking fields.
 *
 * Legacy enrichment data (equity curve, asset breakdown, positions, stats)
 * remains available to non-public callers such as compare. Public profile
 * callers must explicitly opt into the quarantine below: absence of an arena
 * publication proof is not a zero-valued historical observation.
 */
export async function getTraderDetail(
  supabase: SupabaseClient,
  params: {
    platform: string
    traderKey: string
    /**
     * Public profile routes cannot publish unsealed legacy history. This is
     * opt-in rather than the default because `/api/compare` remains outside
     * the public-profile containment scope.
     */
    publicProfileHistoryQuarantine?: boolean
  }
): Promise<TraderDetail | null> {
  const { platform, traderKey, publicProfileHistoryQuarantine = false } = params
  const sourceAliases = getSourceAliases(platform)

  // --- Phase 1: Fetch ranked cohort + identity/profile in parallel ---
  // Profile queries do not establish rank authority. Run them alongside the
  // sealed cohort query so an unranked profile can retain its identity.
  // Each query carries AbortSignal so PostgREST requests are cancelled on timeout.
  const phase1Signal = AbortSignal.timeout(SSR_HEAVY_QUERY_TIMEOUT_MS)
  const [rankingCohort, sourceProfileResult, profileV2Result] = await withTimeout(
    Promise.all([
      fetchPublicProfileRankingRows(
        supabase,
        {
          source: platform,
          sourceTraderId: traderKey,
          periods: PUBLIC_PROFILE_RANKING_PERIODS,
        },
        phase1Signal
      ),
      // Profile from trader_sources table
      safeQuery(() =>
        supabase
          .from('trader_sources')
          .select('source_trader_id, handle, profile_url, avatar_url, market_type')
          .eq('source', platform)
          .eq('source_trader_id', traderKey)
          .limit(1)
          .abortSignal(phase1Signal)
          .maybeSingle()
      ),
      // Bio from trader_profiles_v2
      safeQuery(() =>
        supabase
          .from('trader_profiles_v2')
          .select('bio, display_name, avatar_url')
          .eq('platform', platform)
          .eq('trader_key', traderKey)
          .limit(1)
          .abortSignal(phase1Signal)
          .maybeSingle()
      ),
    ]),
    SSR_HEAVY_QUERY_TIMEOUT_MS + 1000 // outer fallback: AbortSignal should fire first
  )

  // Extract profile observations independently from the rank cohort. The
  // helper has already converted a missing/unverified cohort to no rows.
  const lrRows = rankingCohort.rows as Record<string, unknown>[]
  const sourceProfile = unwrap(sourceProfileResult) as Record<string, unknown> | null | undefined
  const profileV2 = unwrap(profileV2Result) as Record<string, unknown> | null | undefined

  // Build each requested period from the sealed public cohort only.
  const periods: Record<TradingPeriod, Partial<UnifiedTrader> | null> = {
    '7D': null,
    '30D': null,
    '90D': null,
  }

  for (const p of ['90D', '30D', '7D'] as TradingPeriod[]) {
    // The sealed public view projects season_id → period.
    const lrRow = lrRows.find((r) => normalizePeriod(r[LR.season_id] as string) === p)
    if (lrRow) {
      periods[p] = mapLeaderboardRow(lrRow)
    }
  }

  // A profile can exist without a published ranking row. Retain its identity,
  // but leave all ranking-derived fields null so callers render unknown rather
  // than coercing an unavailable cohort to zero or a fabricated position.
  const hasAnyData = periods['90D'] || periods['30D'] || periods['7D']
  const hasIdentityData = sourceProfile || profileV2
  if (!hasAnyData && !hasIdentityData) {
    return null
  }

  // Build the primary trader record (prefer 90D, then 30D, then 7D).
  // With a profile-only trader, `primaryData` is intentionally blank.
  const primaryPeriod: TradingPeriod = periods['90D']
    ? '90D'
    : periods['30D']
      ? '30D'
      : periods['7D']
        ? '7D'
        : '90D'
  const primaryData = periods[primaryPeriod] ?? ({} as Partial<UnifiedTrader>)

  const trader: UnifiedTrader = {
    platform,
    traderKey,
    handle:
      (sourceProfile?.handle as string) ||
      (profileV2?.display_name as string) ||
      primaryData.handle ||
      null,
    avatarUrl:
      (sourceProfile?.avatar_url as string) ||
      (profileV2?.avatar_url as string) ||
      primaryData.avatarUrl ||
      null,
    profileUrl: (sourceProfile?.profile_url as string) || null,
    marketType:
      (sourceProfile?.market_type as string) ||
      primaryData.marketType ||
      SOURCE_TYPE_MAP[platform] ||
      null,
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
  // Each query carries AbortSignal so PostgREST requests are cancelled on timeout.
  const phase2Signal = AbortSignal.timeout(SSR_HEAVY_QUERY_TIMEOUT_MS)
  // Preserve the default detail behavior for compare, but make public-profile
  // containment an actual read fence rather than a post-read cosmetic filter.
  // `null` is an unavailable value; no historical metric is replaced with 0.
  const unavailableLegacyEnrichment = <T>(): Promise<DataResult<T | null>> =>
    Promise.resolve(success<T | null>(null))
  const [
    allEquityCurveResult,
    allAssetBreakdownResult,
    statsDetailResult,
    portfolioResult,
    trackedSinceResult,
    similarTradersResult,
    positionSummaryResult,
  ] = await withTimeout(
    Promise.all([
      // Equity curves — all periods in single query, split client-side
      publicProfileHistoryQuarantine
        ? unavailableLegacyEnrichment()
        : safeQuery(() =>
            supabase
              .from('trader_equity_curve')
              .select('period, data_date, roi_pct, pnl_usd')
              .in(ENRICH.source, sourceAliases)
              .eq(ENRICH.source_trader_id, traderKey)
              .in('period', ['90D', '30D', '7D'])
              .order('data_date', { ascending: true })
              .limit(130)
              .abortSignal(phase2Signal)
          ),
      // Asset breakdowns — all periods in single query, split client-side
      publicProfileHistoryQuarantine
        ? unavailableLegacyEnrichment()
        : safeQuery(() =>
            supabase
              .from('trader_asset_breakdown')
              .select('period, symbol, weight_pct')
              .in(ENRICH.source, sourceAliases)
              .eq(ENRICH.source_trader_id, traderKey)
              .in('period', ['90D', '30D', '7D'])
              .order('weight_pct', { ascending: false })
              .limit(60)
              .abortSignal(phase2Signal)
          ),
      // Stats detail (all periods) — enrichment tables use v1 naming
      publicProfileHistoryQuarantine
        ? unavailableLegacyEnrichment()
        : safeQuery(() =>
            supabase
              .from('trader_stats_detail')
              .select(
                'sharpe_ratio, copiers_pnl, copiers_count, winning_positions, total_positions, total_trades, profitable_trades_pct, avg_holding_time_hours, avg_profit, avg_loss, largest_win, largest_loss, aum, period'
              )
              .in(ENRICH.source, sourceAliases)
              .eq(ENRICH.source_trader_id, traderKey)
              .order('captured_at', { ascending: false })
              .limit(3)
              .abortSignal(phase2Signal)
          ),
      // Portfolio — enrichment tables use v1 naming
      publicProfileHistoryQuarantine
        ? unavailableLegacyEnrichment()
        : safeQuery(() =>
            supabase
              .from('trader_portfolio')
              .select('symbol, direction, invested_pct, entry_price, pnl')
              .in(ENRICH.source, sourceAliases)
              .eq(ENRICH.source_trader_id, traderKey)
              .order('captured_at', { ascending: false })
              .limit(50)
              .abortSignal(phase2Signal)
          ),
      // Tracked since — migrated off retiring trader_snapshots_v2 to
      // trader_sources.created_at (when this trader identity was first recorded).
      safeQuery(() =>
        supabase
          .from('trader_sources')
          .select('created_at')
          .eq('source', platform)
          .eq('source_trader_id', traderKey)
          .limit(1)
          .abortSignal(phase2Signal)
          .maybeSingle()
      ),
      // Similar traders (by arena score range)
      fetchSimilarTraders(supabase, platform, traderKey, trader.arenaScore, trader.roi),
      // Position summary (avg leverage, long/short counts)
      publicProfileHistoryQuarantine
        ? unavailableLegacyEnrichment()
        : safeQuery(() =>
            supabase
              .from('trader_position_summary')
              .select(
                'avg_leverage, long_positions, short_positions, total_positions, total_margin_usd, total_unrealized_pnl'
              )
              .eq('platform', platform)
              .eq('trader_key', traderKey)
              .abortSignal(phase2Signal)
              .maybeSingle()
          ),
    ]),
    SSR_HEAVY_QUERY_TIMEOUT_MS + 1000 // outer fallback: AbortSignal should fire first
  )

  // Map equity curves — split merged result by period
  type EqRow = { period: string; data_date: string; roi_pct: number | null; pnl_usd: number | null }
  const allEqRows = (unwrap(allEquityCurveResult) || []) as EqRow[]
  const mapEquity = (period: string): EquityPoint[] =>
    allEqRows
      .filter((r) => r.period === period)
      .map((r) => ({ date: r.data_date, roi: r.roi_pct, pnl: r.pnl_usd }))

  const equityCurve: Record<TradingPeriod, EquityPoint[]> = {
    '90D': mapEquity('90D'),
    '30D': mapEquity('30D'),
    '7D': mapEquity('7D'),
  }

  // Map asset breakdowns — split merged result by period
  type AbRow = { period: string; symbol: string; weight_pct: number }
  const allAbRows = (unwrap(allAssetBreakdownResult) || []) as AbRow[]
  const mapAssets = (period: string): AssetWeight[] =>
    allAbRows
      .filter((r) => r.period === period)
      .map((r) => ({ symbol: r.symbol, weightPct: r.weight_pct }))

  const assetBreakdown: Record<TradingPeriod, AssetWeight[]> = {
    '90D': mapAssets('90D'),
    '30D': mapAssets('30D'),
    '7D': mapAssets('7D'),
  }

  // Map stats detail (prefer 90D)
  type StatsRow = {
    sharpe_ratio: number | null
    copiers_pnl: number | null
    copiers_count: number | null
    winning_positions: number | null
    total_positions: number | null
    total_trades: number | null
    profitable_trades_pct: number | null
    avg_holding_time_hours: number | null
    avg_profit: number | null
    avg_loss: number | null
    largest_win: number | null
    largest_loss: number | null
    aum: number | null
    period: string | null
  }
  const statsRows = (unwrap(statsDetailResult) || []) as StatsRow[]
  // Prefer 90D row with actual data (non-null fields) over empty newer rows
  const hasData = (s: StatsRow) =>
    s.avg_profit != null ||
    s.largest_win != null ||
    s.sharpe_ratio != null ||
    s.winning_positions != null ||
    s.total_trades != null
  const statsPrimary =
    statsRows.find((s) => s.period === '90D' && hasData(s)) ||
    statsRows.find((s) => s.period === '90D') ||
    statsRows.find((s) => hasData(s)) ||
    statsRows[0] ||
    null

  const stats = statsPrimary
    ? {
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
      }
    : null

  // Map portfolio
  type PortRow = {
    symbol: string | null
    direction: string | null
    invested_pct: number | null
    entry_price: number | null
    pnl: number | null
  }
  const portfolio: TraderPosition[] = ((unwrap(portfolioResult) || []) as PortRow[]).map((r) => ({
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

  // Legacy closed-position rows have no terminal acquisition evidence bound to
  // them. They stay quarantined until the arena.position_history authority can
  // prove completeness, price trust, and cost basis for the requested window.
  const positionHistory: TraderPosition[] = []

  // Tracked since
  const trackedSince =
    ((unwrap(trackedSinceResult) as Record<string, unknown> | null)?.created_at as string | null) ??
    null

  // Position summary (live positions: avg leverage, long/short)
  const posSummary = unwrap(positionSummaryResult) as {
    avg_leverage?: number | null
    long_positions?: number | null
    short_positions?: number | null
    total_positions?: number | null
    total_margin_usd?: number | null
    total_unrealized_pnl?: number | null
  } | null

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
    positionSummary: posSummary
      ? {
          avgLeverage: posSummary.avg_leverage ?? null,
          longPositions: posSummary.long_positions ?? null,
          shortPositions: posSummary.short_positions ?? null,
          totalPositions: posSummary.total_positions ?? null,
          totalMarginUsd: posSummary.total_margin_usd ?? null,
          totalUnrealizedPnl: posSummary.total_unrealized_pnl ?? null,
        }
      : null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function searchCandidateKey(platform: string, traderKey: string): string {
  return JSON.stringify([platform, traderKey])
}

function normalizePublicSearchCandidate(value: unknown): PublicSearchTraderCandidate | null {
  if (!isRecord(value)) return null
  const platform = value.platform
  const traderKey = value.traderKey
  if (
    typeof platform !== 'string' ||
    platform.length === 0 ||
    platform !== platform.trim() ||
    typeof traderKey !== 'string' ||
    traderKey.length === 0 ||
    traderKey !== traderKey.trim()
  ) {
    return null
  }

  return {
    platform: platform.toLowerCase(),
    traderKey,
    handle: typeof value.handle === 'string' && value.handle.length > 0 ? value.handle : null,
    avatarUrl:
      typeof value.avatarUrl === 'string' && value.avatarUrl.length > 0 ? value.avatarUrl : null,
    traderType:
      typeof value.traderType === 'string' && value.traderType.length > 0 ? value.traderType : null,
  }
}

function identityOnlySearchTrader(candidate: PublicSearchTraderCandidate): UnifiedTrader {
  const platform = candidate.platform
  return {
    platform,
    traderKey: candidate.traderKey,
    handle: candidate.handle,
    avatarUrl: candidate.avatarUrl,
    profileUrl: null,
    marketType: SOURCE_TYPE_MAP[platform] || null,
    sourceType: SOURCE_TYPE_MAP[platform] || null,
    roi: null,
    pnl: null,
    winRate: null,
    maxDrawdown: null,
    tradesCount: null,
    followers: null,
    copiers: null,
    arenaScore: null,
    returnScore: null,
    pnlScore: null,
    drawdownScore: null,
    stabilityScore: null,
    profitabilityScore: null,
    riskControlScore: null,
    executionScore: null,
    scoreConfidence: null,
    scoreCompleteness: null,
    metricsEstimated: null,
    rank: null,
    rankChange: null,
    isNew: false,
    period: PUBLIC_SEARCH_PERIOD,
    sharpeRatio: null,
    sortinoRatio: null,
    profitFactor: null,
    calmarRatio: null,
    tradingStyle: null,
    avgHoldingHours: null,
    traderType: candidate.traderType || (platform === 'web3_bot' ? 'bot' : null),
    isOutlier: false,
    lastUpdated: null,
  }
}

type PublicSearchRankingRow = Record<string, unknown> & {
  source: string
  source_trader_id: string
  season_id: TradingPeriod
  rank: number
}

function isExactPublicSearchRow(
  row: unknown,
  candidateKeys: ReadonlySet<string>
): row is PublicSearchRankingRow {
  return (
    isRecord(row) &&
    typeof row.source === 'string' &&
    typeof row.source_trader_id === 'string' &&
    row.season_id === PUBLIC_SEARCH_PERIOD &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0 &&
    candidateKeys.has(searchCandidateKey(row.source, row.source_trader_id))
  )
}

/**
 * Re-materialize identity candidates against the current sealed public cohort.
 * Fuzzy/Meilisearch/trader_sources may nominate candidates only. Missing,
 * stale, partial, or malformed proof intentionally leaves every rank-derived
 * field null rather than falling back to the nomination source.
 */
export async function materializePublicSearchTraders(
  supabase: SupabaseClient,
  candidates: readonly PublicSearchTraderCandidate[]
): Promise<UnifiedTrader[]> {
  const normalizedCandidates: PublicSearchTraderCandidate[] = []
  const seenCandidates = new Set<string>()
  for (const candidate of candidates) {
    const normalized = normalizePublicSearchCandidate(candidate)
    if (!normalized) continue
    const key = searchCandidateKey(normalized.platform, normalized.traderKey)
    if (seenCandidates.has(key)) continue
    seenCandidates.add(key)
    normalizedCandidates.push(normalized)
    if (normalizedCandidates.length >= MAX_PUBLIC_SEARCH_CANDIDATES) break
  }
  if (normalizedCandidates.length === 0) return []

  const publicCandidates = normalizedCandidates.filter((candidate) =>
    isPublicRankingSourceAllowed(candidate.platform)
  )
  const candidateKeys = new Set(
    publicCandidates.map((candidate) => searchCandidateKey(candidate.platform, candidate.traderKey))
  )
  const publicRowsByCandidate = new Map<string, Record<string, unknown>>()
  const ambiguousCandidateKeys = new Set<string>()

  if (publicCandidates.length > 0) {
    try {
      const sources = [...new Set(publicCandidates.map((candidate) => candidate.platform))]
      const traderKeys = [...new Set(publicCandidates.map((candidate) => candidate.traderKey))]
      const { data, error } = await supabase
        .from(PUBLIC_RANKED_LEADERBOARD as never)
        .select(PUBLIC_SEARCH_RANKING_COLUMNS)
        .eq(LR.season_id, PUBLIC_SEARCH_PERIOD)
        .in(LR.source, sources)
        .in(LR.source_trader_id, traderKeys)
        .not(LR.rank, 'is', null)

      if (error) {
        logger.warn('[search] public cohort lookup failed', { error: error.message })
      } else {
        const sanitized = sanitizePublicRankingPayload(
          { traders: data ?? [], period: PUBLIC_SEARCH_PERIOD },
          { expectedPeriod: PUBLIC_SEARCH_PERIOD }
        ) as { traders?: unknown[] }
        for (const row of sanitized.traders ?? []) {
          if (!isExactPublicSearchRow(row, candidateKeys)) continue
          const key = searchCandidateKey(row.source, row.source_trader_id)
          if (publicRowsByCandidate.has(key)) {
            ambiguousCandidateKeys.add(key)
            publicRowsByCandidate.delete(key)
            continue
          }
          if (!ambiguousCandidateKeys.has(key)) publicRowsByCandidate.set(key, row)
        }
      }
    } catch (err) {
      logger.warn('[search] public cohort lookup threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return normalizedCandidates.map((candidate) => {
    const row = publicRowsByCandidate.get(
      searchCandidateKey(candidate.platform, candidate.traderKey)
    )
    if (!row) return identityOnlySearchTrader(candidate)

    const publicTrader = mapLeaderboardRow(row)
    return {
      ...publicTrader,
      // Identity can be discovered through fuzzy/indexed sources. All
      // performance, score, and rank fields above came from the sealed row.
      platform: candidate.platform,
      traderKey: candidate.traderKey,
      handle: candidate.handle ?? publicTrader.handle,
      avatarUrl: candidate.avatarUrl ?? publicTrader.avatarUrl,
      traderType: candidate.traderType ?? publicTrader.traderType,
    }
  })
}

/**
 * Search traders by name/handle with fuzzy matching.
 * Used by: search bar, /search
 *
 * Strategy: fuzzy RPC and trader_sources nominate identity/relevance only;
 * materializePublicSearchTraders then proves every rank-derived field from the
 * current public_ranked_leaderboard view.
 */
export async function searchTraders(
  supabase: SupabaseClient,
  params: {
    query: string
    limit?: number
    platform?: string
  }
): Promise<UnifiedTrader[]> {
  const { query, limit = 10, platform } = params

  if (!query || query.length < 1) return []

  // 8s timeout — search should be fast; prevents UI hang on degraded Supabase
  return withTimeout(searchTradersInner(supabase, { query, limit, platform }), 8_000).catch(
    (err) => {
      logger.warn(
        '[unified.searchTraders] Timeout or error:',
        err instanceof Error ? err.message : String(err)
      )
      return [] as UnifiedTrader[]
    }
  )
}

async function searchTradersInner(
  supabase: SupabaseClient,
  params: {
    query: string
    limit: number
    platform?: string
  }
): Promise<UnifiedTrader[]> {
  const { query, limit, platform } = params

  // Callers pass the raw query. `textQuery` is compared against handles/ids in
  // JS; `sanitizedQuery` is the LIKE-escaped form for SQL only. Comparing the
  // escaped form in JS made every name containing `_`, `%` or `\` unfindable.
  const textQuery = query
    .slice(0, 100)
    .replace(/[.,()]/g, '')
    .trim()
  const sanitizedQuery = textQuery.replace(/[\\%_]/g, (c) => `\\${c}`)

  if (!sanitizedQuery) return []

  type FuzzyIdentityResult = {
    source_trader_id: string
    handle: string | null
    source: string
    avatar_url: string | null
    trader_type?: string | null
  }
  let sourcesData: FuzzyIdentityResult[] | null = null

  try {
    const { data: fuzzyData, error: fuzzyErr } = await supabase.rpc('search_traders_fuzzy', {
      search_query: sanitizedQuery,
      result_limit: Math.min(limit * 4, MAX_PUBLIC_SEARCH_CANDIDATES),
      platform_filter: platform || null,
    })
    if (!fuzzyErr && Array.isArray(fuzzyData) && fuzzyData.length > 0) {
      const qLower = textQuery.toLowerCase()
      const filtered = (fuzzyData as FuzzyIdentityResult[]).filter((candidate) => {
        if (
          typeof candidate.source_trader_id !== 'string' ||
          typeof candidate.source !== 'string' ||
          candidate.source_trader_id.length === 0 ||
          candidate.source.length === 0
        ) {
          return false
        }
        const handle = (candidate.handle || '').toLowerCase()
        const id = candidate.source_trader_id.toLowerCase()
        // The RPC relevance_score is derived from raw leaderboard score and
        // follower inputs. It may nominate only an identity that textually
        // matches the query; it can never admit or reorder a public result.
        return handle.includes(qLower) || id.includes(qLower)
      })
      if (filtered.length > 0) {
        sourcesData = filtered
      }
    }
  } catch (err) {
    // RPC not available (migration not applied), fall through to ILIKE.
    logger.debug(
      '[search] fuzzy RPC unavailable, falling back to ILIKE:',
      err instanceof Error ? err.message : String(err)
    )
  }

  // --- Fallback: ILIKE search using trader_sources table ---
  if (!sourcesData) {
    let sourcesQuery = supabase
      .from('trader_sources')
      .select('source_trader_id, handle, source, avatar_url')
      .or(
        `handle.ilike.%${sanitizedQuery.replace(/[,.()\[\]]/g, '')}%,source_trader_id.ilike.%${sanitizedQuery.replace(/[,.()\[\]]/g, '')}%`
      )

    if (platform) {
      sourcesQuery = sourcesQuery.eq('source', platform)
    }

    const { data, error } = await sourcesQuery.limit(
      Math.min(limit * 4, MAX_PUBLIC_SEARCH_CANDIDATES)
    )
    if (error || !data || data.length === 0) return []
    sourcesData = data.map(
      (d: {
        source_trader_id: string
        handle: string | null
        source: string
        avatar_url: string | null
      }) => ({
        source_trader_id: d.source_trader_id,
        handle: d.handle,
        source: d.source,
        avatar_url: d.avatar_url,
        trader_type: null,
      })
    )
  }

  const deadSet = new Set(DEAD_BLOCKED_PLATFORMS as string[])
  const filteredSources = sourcesData.filter(
    (candidate) =>
      typeof candidate.source === 'string' &&
      typeof candidate.source_trader_id === 'string' &&
      !deadSet.has(candidate.source)
  )
  if (filteredSources.length === 0) return []

  // Text matching is the only ordering input here. Never let an RPC/index
  // relevance score reorder or admit identity candidates before public proof.
  const queryLower = textQuery.toLowerCase()
  const sorted = filteredSources
    .map((candidate) => {
      const handleLower = (candidate.handle || '').toLowerCase()
      const idLower = candidate.source_trader_id.toLowerCase()
      let textRelevance = 0
      if (handleLower === queryLower || idLower === queryLower) textRelevance += 10000
      if (handleLower.startsWith(queryLower) || idLower.startsWith(queryLower)) {
        textRelevance += 1000
      }
      if (handleLower.includes(queryLower) || idLower.includes(queryLower)) textRelevance += 100
      return { candidate, textRelevance }
    })
    .filter(({ textRelevance }) => textRelevance > 0)
    .sort(
      (left, right) =>
        right.textRelevance - left.textRelevance ||
        left.candidate.source.localeCompare(right.candidate.source) ||
        left.candidate.source_trader_id.localeCompare(right.candidate.source_trader_id)
    )

  const seenHandlePlatform = new Set<string>()
  const rankedCandidates: PublicSearchTraderCandidate[] = []
  for (const { candidate } of sorted) {
    const handle = (candidate.handle || '').toLowerCase()
    const dedupKey = handle
      ? `${handle}|${candidate.source}`
      : `__id__${candidate.source_trader_id}|${candidate.source}`
    if (seenHandlePlatform.has(dedupKey)) continue
    seenHandlePlatform.add(dedupKey)
    rankedCandidates.push({
      platform: candidate.source,
      traderKey: candidate.source_trader_id,
      handle: candidate.handle || null,
      avatarUrl: candidate.avatar_url || null,
      traderType: candidate.trader_type ?? null,
    })
    if (rankedCandidates.length >= limit) break
  }

  return materializePublicSearchTraders(supabase, rankedCandidates)
}

/**
 * Get "did you mean" suggestions for a search query with few/no results.
 * Uses pg_trgm similarity to find closest matching trader handles.
 */
export async function getSearchSuggestions(
  supabase: SupabaseClient,
  query: string
): Promise<string[]> {
  if (!query || query.length < 2) return []

  try {
    const { data, error } = await supabase.rpc('search_did_you_mean', {
      search_query: query,
      suggestion_limit: 3,
    })
    if (error || !data) return []
    return (data as Array<{ suggested_query: string; similarity_score: number }>)
      .filter((d) => d.similarity_score > 0.2)
      .map((d) => d.suggested_query)
  } catch (err) {
    logger.debug(
      '[search] did-you-mean RPC failed:',
      err instanceof Error ? err.message : String(err)
    )
    return []
  }
}

/**
 * Resolve a trader handle/ID to their canonical identity.
 * Used by: trader detail page to find the right trader
 *
 * Resolution chain:
 * 1. trader_sources by handle/source_trader_id (pure identity)
 * 2. public_ranked_leaderboard by handle/source_trader_id (sealed publication)
 * 3. trader_profiles_v2 by trader_key/display_name (pure identity)
 *
 * A handle or source key shared by multiple identities is intentionally not
 * resolved. The resolver feeds public profile, badge, equity, positions, and
 * compare routes, so choosing a candidate from a raw score would both expose
 * an unverified ranking authority and associate the request with the wrong
 * account. Callers can provide `platform` when they have an explicit source.
 */
export async function resolveTrader(
  supabase: SupabaseClient,
  params: {
    handle: string
    platform?: string
  }
): Promise<{
  platform: string
  traderKey: string
  handle: string | null
  avatarUrl: string | null
} | null> {
  // Candidate queries are intentionally bounded so a malformed/common handle
  // cannot create an unbounded public request. Fetch one sentinel row beyond
  // the maximum and fail closed if it appears: a truncated result can never
  // establish that an identity is unique.
  const MAX_RESOLVE_IDENTITY_CANDIDATES = 100
  // Sanitize handle for PostgREST .or() filter safety — reject chars that break filter syntax.
  // Do NOT decode here — callers are responsible for decoding (page.tsx already decodes).
  // Only strip characters that actually break PostgREST .or() syntax: commas and parentheses.
  // Dots are safe in PostgREST filters and must be preserved (many handles contain dots).
  let decodedHandle = params.handle.replace(/[(),]/g, '')

  // ETH-address normalization: incoming URLs sometimes carry mixed-case
  // checksum addresses (0x880Ac484...) but the DB always stores lowercase.
  // Postgres .eq() is case-sensitive → lookup misses → notFound() → 404.
  // Lowercase any handle matching ETH address shape before querying.
  // This is safe because lowercase ETH addresses are still valid identifiers.
  if (/^0x[a-fA-F0-9]{40}$/.test(decodedHandle)) {
    decodedHandle = decodedHandle.toLowerCase()
  }

  const platformFilter = params.platform
  // Only characters that break PostgREST `.or()` syntax are removed. These
  // filters are exact `.eq` matches, so `_`, `%`, `\`, `[`, `]` carry no LIKE
  // meaning; stripping them turned "crypto_king" into "cryptoking" and the
  // trader could never be resolved.
  const sanitizedForFilter = decodedHandle.replace(/[,()"]/g, '')

  type ResolvedIdentity = {
    platform: string
    traderKey: string
    handle: string | null
    avatarUrl: string | null
  }

  const identityKey = (identity: Pick<ResolvedIdentity, 'platform' | 'traderKey'>) =>
    JSON.stringify([identity.platform, identity.traderKey])

  const sourceIdentity = (value: unknown): ResolvedIdentity | null => {
    if (!isRecord(value)) return null
    const platform = value.source
    const traderKey = value.source_trader_id
    if (
      typeof platform !== 'string' ||
      platform.length === 0 ||
      platform !== platform.trim() ||
      typeof traderKey !== 'string' ||
      traderKey.length === 0 ||
      traderKey !== traderKey.trim() ||
      (platformFilter !== undefined && platform !== platformFilter)
    ) {
      return null
    }
    return {
      platform,
      traderKey,
      handle: typeof value.handle === 'string' && value.handle.length > 0 ? value.handle : null,
      avatarUrl:
        typeof value.avatar_url === 'string' && value.avatar_url.length > 0
          ? value.avatar_url
          : null,
    }
  }

  const profileIdentity = (value: unknown): ResolvedIdentity | null => {
    if (!isRecord(value)) return null
    const platform = value.platform
    const traderKey = value.trader_key
    if (
      typeof platform !== 'string' ||
      platform.length === 0 ||
      platform !== platform.trim() ||
      typeof traderKey !== 'string' ||
      traderKey.length === 0 ||
      traderKey !== traderKey.trim() ||
      (platformFilter !== undefined && platform !== platformFilter)
    ) {
      return null
    }
    return {
      platform,
      traderKey,
      handle:
        typeof value.display_name === 'string' && value.display_name.length > 0
          ? value.display_name
          : null,
      avatarUrl:
        typeof value.avatar_url === 'string' && value.avatar_url.length > 0
          ? value.avatar_url
          : null,
    }
  }

  const exactlyMatchesRequestedIdentity = (identity: ResolvedIdentity) =>
    identity.traderKey === sanitizedForFilter || identity.handle === sanitizedForFilter

  const uniqueIdentity = (
    rows: readonly unknown[],
    toIdentity: (value: unknown) => ResolvedIdentity | null
  ): ResolvedIdentity | 'ambiguous' | null => {
    const identities = new Map<string, ResolvedIdentity>()
    for (const row of rows) {
      const identity = toIdentity(row)
      if (!identity || !exactlyMatchesRequestedIdentity(identity)) continue
      identities.set(identityKey(identity), identity)
    }
    if (identities.size === 0) return null
    if (identities.size > 1) return 'ambiguous'
    return [...identities.values()][0] ?? null
  }

  const publicIdentity = (value: unknown): ResolvedIdentity | null => {
    const identity = sourceIdentity(value)
    return identity && isPublicRankingSourceAllowed(identity.platform) ? identity : null
  }

  const sanitizedPublicIdentity = (value: unknown): ResolvedIdentity | 'ambiguous' | null => {
    if (!Array.isArray(value)) return null

    // Keep the period order fixed so a returned handle/avatar is deterministic
    // when the same safely-published identity appears in multiple windows.
    const safeRows: unknown[] = []
    for (const period of ['90D', '30D', '7D'] as const) {
      const rawRows = value.filter((row) => isRecord(row) && row.season_id === period)
      const sanitized = sanitizePublicRankingPayload(
        { traders: rawRows, period },
        { expectedPeriod: period }
      ) as { traders?: unknown[] }
      safeRows.push(...(sanitized.traders ?? []))
    }

    return uniqueIdentity(safeRows, publicIdentity)
  }

  // Steps 1+2 combined: Try trader_sources by handle OR source_trader_id (single query)
  {
    let query = supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle, avatar_url')
      .or(`handle.eq.${sanitizedForFilter},source_trader_id.eq.${sanitizedForFilter}`)

    if (platformFilter) {
      query = query.eq('source', platformFilter)
    }

    const { data: rawCandidates, error: candidatesError } = await query.limit(
      MAX_RESOLVE_IDENTITY_CANDIDATES + 1
    )
    if (candidatesError) {
      // Never collapse a query error into "not found" — that 404s a valid
      // trader with no signal (the exact latent bug resolve.ts already fixed).
      logger.error('[resolveTrader] trader_sources candidate query failed', {
        handle: decodedHandle,
        error: candidatesError.message,
      })
    }
    // Never resolve to a RETIRED source. One exchange_trader_id can collide
    // across sources (e.g. okx_web3 RETIRED + okx_futures live); this query has
    // NO deterministic ORDER BY, so without filtering it would non-
    // deterministically return the retired row → generateMetadata's
    // isRetiredSource() check 404'd a valid serving trader (~1406 ids affected).
    const candidates = (rawCandidates ?? []).filter(
      (candidate: unknown) =>
        isRecord(candidate) &&
        typeof candidate.source === 'string' &&
        !isRetiredSource(candidate.source)
    )
    if ((rawCandidates?.length ?? 0) > MAX_RESOLVE_IDENTITY_CANDIDATES) {
      logger.warn('[resolveTrader] trader_sources candidate query exceeded safe ambiguity bound', {
        handle: decodedHandle,
        platform: platformFilter ?? null,
      })
      return null
    }
    const resolvedSourceIdentity = uniqueIdentity(candidates, sourceIdentity)
    if (resolvedSourceIdentity === 'ambiguous') {
      logger.warn('[resolveTrader] ambiguous trader_sources identity', {
        handle: decodedHandle,
        platform: platformFilter ?? null,
      })
      return null
    }
    if (resolvedSourceIdentity) {
      return resolvedSourceIdentity
    }
  }

  // The sealed view may recover a legacy identity absent from trader_sources.
  // It is intentionally read in parallel with the pure identity profile table;
  // neither branch may use a raw leaderboard row or raw arena score as a
  // tie-breaker.
  {
    let publicRankQuery = supabase
      .from(PUBLIC_RANKED_LEADERBOARD as never)
      .select(PUBLIC_PROFILE_RANKING_COLUMNS)
      .or(`${LR.source_trader_id}.eq.${sanitizedForFilter},${LR.handle}.eq.${sanitizedForFilter}`)
      .in(LR.season_id, PUBLIC_PROFILE_RANKING_PERIODS)
      .not(LR.rank, 'is', null)

    let profileQuery = supabase
      .from('trader_profiles_v2')
      .select('platform, trader_key, display_name, avatar_url')
      .or(`trader_key.eq.${sanitizedForFilter},display_name.eq.${sanitizedForFilter}`)

    if (platformFilter) {
      publicRankQuery = publicRankQuery.eq(LR.source, platformFilter)
      profileQuery = profileQuery.eq('platform', platformFilter)
    }

    // Fetch a small bounded candidate set rather than `maybeSingle()`: a
    // database limit of one would hide an ambiguous identity and make the
    // chosen row depend on an unstated physical order.
    const [publicRankResult, profileResult] = await Promise.all([
      publicRankQuery.limit(MAX_RESOLVE_IDENTITY_CANDIDATES + 1),
      profileQuery.limit(MAX_RESOLVE_IDENTITY_CANDIDATES + 1),
    ])

    if (publicRankResult.error || profileResult.error) {
      logger.error('[resolveTrader] fallback lookup failed', {
        handle: decodedHandle,
        publicRankError: publicRankResult.error?.message,
        profileError: profileResult.error?.message,
      })
    }

    if (
      (publicRankResult.data?.length ?? 0) > MAX_RESOLVE_IDENTITY_CANDIDATES ||
      (profileResult.data?.length ?? 0) > MAX_RESOLVE_IDENTITY_CANDIDATES
    ) {
      logger.warn('[resolveTrader] fallback candidate query exceeded safe ambiguity bound', {
        handle: decodedHandle,
        platform: platformFilter ?? null,
      })
      return null
    }

    const resolvedPublicIdentity = sanitizedPublicIdentity(publicRankResult.data ?? [])
    if (resolvedPublicIdentity === 'ambiguous') {
      logger.warn('[resolveTrader] ambiguous published identity', {
        handle: decodedHandle,
        platform: platformFilter ?? null,
      })
      return null
    }
    if (resolvedPublicIdentity) {
      return resolvedPublicIdentity
    }

    const resolvedProfileIdentity = uniqueIdentity(profileResult.data ?? [], profileIdentity)
    if (resolvedProfileIdentity === 'ambiguous') {
      logger.warn('[resolveTrader] ambiguous trader_profiles_v2 identity', {
        handle: decodedHandle,
        platform: platformFilter ?? null,
      })
      return null
    }
    if (resolvedProfileIdentity) {
      return resolvedProfileIdentity
    }
  }

  return null
}
