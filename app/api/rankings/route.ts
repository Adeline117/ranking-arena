/**
 * GET /api/rankings
 *
 * Legacy-compatible public leaderboard endpoint. The only ranked cohort this
 * route may read is `public_ranked_leaderboard`: its security-barrier view
 * applies publication eligibility before caller filters, sorting, and range
 * pagination. A page must never be assembled from a wider relation and then
 * filtered in application code.
 *
 * Query parameters:
 * - window: 7d | 30d | 90d | composite (required; composite is served and labelled as 90D)
 * - category: futures | spot | onchain (optional; platform takes precedence)
 * - platform: canonical active source (optional)
 * - limit: 1..500 (default 100)
 * - offset: 0..20,000,000 (default 0)
 * - sort_by: one of the published view metrics below (default arena_score)
 * - sort_dir: asc | desc (default desc)
 * - min_pnl, min_trades, trader_type: optional SQL filters
 *
 * `cursor` was never implemented by this legacy endpoint. Reject it rather
 * than silently returning page one under a false continuation contract.
 */

import type { Platform } from '@/lib/types/leaderboard'
import type { TradingPeriod } from '@/lib/types/unified-trader'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess } from '@/lib/api/response'
import { withPublic } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import {
  sourceFreshnessStatusMap,
  summarizeSourceFreshness,
  type SourceFreshnessRow,
} from '@/lib/rankings/source-freshness'
import {
  filterPublicRankingSources,
  isPublicRankingSourceQuarantined,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import { parsePublicActiveRankingSource } from '@/lib/constants/exchanges'
import type {
  PublicRankingsData,
  PublicRankingsTrader,
  PublicRankingsWindow,
} from '@/lib/contracts/rankings'
import { applyPublicCohortFilters } from '@/lib/rankings/public-cohort'

const logger = createLogger('rankings-api')
const PUBLIC_RANKING_RESPONSE_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate'
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 100
const MAX_OFFSET = 20_000_000

const VALID_WINDOWS = ['7d', '30d', '90d', 'composite'] as const
const VALID_CATEGORIES = ['futures', 'spot', 'onchain'] as const
const VALID_SORT_BY = [
  'arena_score',
  'roi',
  'pnl',
  'drawdown',
  'copiers',
  'win_rate',
  'sharpe_ratio',
  'trades_count',
] as const
const VALID_TRADER_TYPES = ['human', 'bot'] as const
const ALLOWED_QUERY_PARAMS = new Set([
  'window',
  'category',
  'platform',
  'limit',
  'offset',
  'sort_by',
  'sort_dir',
  'min_pnl',
  'min_trades',
  'trader_type',
])

type PublicRankingWindow = (typeof VALID_WINDOWS)[number]
type PublicRankingCategory = (typeof VALID_CATEGORIES)[number]
type PublicRankingSortBy = (typeof VALID_SORT_BY)[number]
type PublicRankingTraderType = (typeof VALID_TRADER_TYPES)[number]

const SORT_COLUMN: Record<PublicRankingSortBy, string> = {
  arena_score: 'arena_score',
  roi: 'roi',
  pnl: 'pnl',
  drawdown: 'max_drawdown',
  copiers: 'copiers',
  win_rate: 'win_rate',
  sharpe_ratio: 'sharpe_ratio',
  trades_count: 'trades_count',
}

const PUBLIC_RANKED_LEADERBOARD_COLUMNS =
  'source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, avatar_url, rank, rank_change, is_new, computed_at, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, calmar_ratio, profit_factor, trader_type, is_outlier, metrics_estimated, season_id'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function singleQueryParam(searchParams: URLSearchParams, name: string): string | null {
  const values = searchParams.getAll(name)
  if (values.length > 1) {
    throw ApiError.validation(`Query parameter ${name} may only be specified once`)
  }
  return values[0] ?? null
}

function parseStrictInteger(
  raw: string | null,
  fallback: number,
  name: string,
  min: number,
  max: number
): number {
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) {
    throw ApiError.validation(`Invalid ${name}`)
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw ApiError.validation(`Invalid ${name}`)
  }
  return parsed
}

function parseOptionalFiniteNumber(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined
  if (raw.trim() === '') throw ApiError.validation(`Invalid ${name}`)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw ApiError.validation(`Invalid ${name}`)
  return parsed
}

function publicSeason(window: PublicRankingWindow): TradingPeriod {
  return (window === 'composite' ? '90D' : window.toUpperCase()) as TradingPeriod
}

/**
 * The response labels the season actually served. There is no published
 * 70/25/5 composite cohort — `window=composite` is served from the 90D
 * season — so labelling it `COMPOSITE` claimed a score that was never
 * computed. lib/contracts/core-api.ts allows only 7D/30D/90D here.
 */
function responseWindow(window: PublicRankingWindow): '7D' | '30D' | '90D' {
  return publicSeason(window)
}

function sourceTypeForCategory(category: PublicRankingCategory): string {
  return category === 'onchain' ? 'web3' : category
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function hasPositivePublishedRank(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.rank === 'number' &&
    Number.isSafeInteger(value.rank) &&
    value.rank > 0
  )
}

function truncateAddress(value: string): string | null {
  if (value.startsWith('0x') && value.length >= 10)
    return `${value.slice(0, 6)}...${value.slice(-4)}`
  if (/^[1-9A-HJ-NP-Za-km-z]{30,50}$/.test(value)) {
    return `${value.slice(0, 4)}...${value.slice(-4)}`
  }
  return null
}

function displayName(handle: unknown, traderId: string): string {
  const placeholderNames = new Set(['Enter Name', 'enter name', 'Unknown', 'null', 'undefined', ''])
  if (typeof handle === 'string' && !placeholderNames.has(handle)) {
    return truncateAddress(handle) ?? handle
  }
  if (traderId.includes(':')) {
    const address = traderId.split(':')[1]
    if (address) return truncateAddress(address) ?? address
  }
  return (truncateAddress(traderId) ?? traderId) || 'Anonymous'
}

function mapPublicRankedRow(
  row: Record<string, unknown>,
  sourceFreshness: ReturnType<typeof sourceFreshnessStatusMap>
): PublicRankingsTrader {
  const source = String(row.source)
  const traderId = String(row.source_trader_id)
  let platform = source
  let traderKey = traderId
  if (platform === 'copin' && traderId.includes(':')) {
    const [underlyingPlatform, ...rest] = traderId.split(':')
    platform = underlyingPlatform
    traderKey = rest.join(':')
  }

  const freshness = sourceFreshness.get(source)
  return {
    platform: platform as Platform,
    trader_key: traderKey,
    display_name: displayName(row.handle, traderKey),
    avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    roi: nullableFiniteNumber(row.roi),
    pnl: nullableFiniteNumber(row.pnl),
    arena_score: nullableFiniteNumber(row.arena_score),
    win_rate: nullableFiniteNumber(row.win_rate),
    max_drawdown: nullableFiniteNumber(row.max_drawdown),
    sharpe_ratio: nullableFiniteNumber(row.sharpe_ratio),
    trades_count: nullableFiniteNumber(row.trades_count),
    followers: nullableFiniteNumber(row.followers),
    copiers: nullableFiniteNumber(row.copiers),
    rank: Number(row.rank),
    rank_change: nullableFiniteNumber(row.rank_change),
    is_new: row.is_new === true,
    quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 1 },
    // Backward-compatible per-row freshness fields. They are upstream source
    // watermarks, never a score computation timestamp.
    updated_at: freshness?.updated_at ?? null,
    is_stale: freshness?.is_stale ?? true,
    computed_at: typeof row.computed_at === 'string' ? row.computed_at : null,
    profitability_score: nullableFiniteNumber(row.profitability_score),
    risk_control_score: nullableFiniteNumber(row.risk_control_score),
    execution_score: nullableFiniteNumber(row.execution_score),
    score_completeness: typeof row.score_completeness === 'string' ? row.score_completeness : null,
    trading_style: typeof row.trading_style === 'string' ? row.trading_style : null,
    avg_holding_hours: nullableFiniteNumber(row.avg_holding_hours),
    style_confidence: null,
    is_bot:
      source === 'web3_bot' || row.trader_type === 'bot' || row.trader_type === 'suspected_bot',
    trader_type:
      typeof row.trader_type === 'string' ? row.trader_type : source === 'web3_bot' ? 'bot' : null,
  }
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    for (const [name] of searchParams) {
      if (!ALLOWED_QUERY_PARAMS.has(name)) {
        throw ApiError.validation(`Unsupported query parameter: ${name}`)
      }
    }

    const rawWindow = singleQueryParam(searchParams, 'window')
    const normalizedWindow = rawWindow?.toLowerCase() as PublicRankingWindow | undefined
    if (!normalizedWindow || !VALID_WINDOWS.includes(normalizedWindow)) {
      throw ApiError.validation(
        'Invalid or missing window parameter. Must be one of: 7d, 30d, 90d, composite'
      )
    }

    const rawCategory = singleQueryParam(searchParams, 'category')
    const category = rawCategory as PublicRankingCategory | null
    if (category && !VALID_CATEGORIES.includes(category)) {
      throw ApiError.validation('Invalid category. Must be one of: futures, spot, onchain')
    }

    const requestedPlatform = singleQueryParam(searchParams, 'platform')
    const platform = requestedPlatform ? parsePublicActiveRankingSource(requestedPlatform) : null
    if (requestedPlatform && !platform) {
      throw ApiError.validation(`Invalid platform: ${requestedPlatform}`)
    }

    const rawSortBy = singleQueryParam(searchParams, 'sort_by')
    const sortBy = (rawSortBy ?? 'arena_score') as PublicRankingSortBy
    if (!VALID_SORT_BY.includes(sortBy)) {
      throw ApiError.validation(`Invalid sort_by. Must be one of: ${VALID_SORT_BY.join(', ')}`)
    }

    const rawSortDir = singleQueryParam(searchParams, 'sort_dir')
    const sortDir = rawSortDir ?? 'desc'
    if (sortDir !== 'asc' && sortDir !== 'desc') {
      throw ApiError.validation('Invalid sort_dir. Must be one of: asc, desc')
    }

    const limit = parseStrictInteger(
      singleQueryParam(searchParams, 'limit'),
      DEFAULT_LIMIT,
      'limit',
      1,
      MAX_LIMIT
    )
    const offset = parseStrictInteger(
      singleQueryParam(searchParams, 'offset'),
      0,
      'offset',
      0,
      MAX_OFFSET
    )
    const minPnl = parseOptionalFiniteNumber(singleQueryParam(searchParams, 'min_pnl'), 'min_pnl')
    const minTradesRaw = singleQueryParam(searchParams, 'min_trades')
    const minTrades = parseStrictInteger(minTradesRaw, 0, 'min_trades', 0, Number.MAX_SAFE_INTEGER)
    const hasMinTrades = minTradesRaw !== null
    const rawTraderType = singleQueryParam(searchParams, 'trader_type')
    const traderType = rawTraderType as PublicRankingTraderType | null
    if (traderType && !VALID_TRADER_TYPES.includes(traderType)) {
      throw ApiError.validation('Invalid trader_type. Must be one of: human, bot')
    }

    const window = responseWindow(normalizedWindow)
    const seasonId = publicSeason(normalizedWindow)

    // The policy itself proves that this requested source has no public rank
    // population. Zero is exact for this intentionally empty scope.
    if (isPublicRankingSourceQuarantined(platform)) {
      const response = apiSuccess({
        traders: [],
        window,
        totalCount: 0,
        totalCountIsExact: true,
        totalcount: 0,
        total_count: 0,
        as_of: null,
        is_stale: true,
        source_freshness: [],
        availableSources: [],
        availableSourcesIsExact: true,
        next_cursor: null,
        hasMore: false,
        rankingMode: sortBy,
        sort_by: sortBy,
        sort_dir: sortDir,
        limit,
        offset,
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'publication_policy_filtered',
        ranking_visibility_reasons: ['quarantined_source_requested'],
      } satisfies PublicRankingsData)
      response.headers.set('Cache-Control', PUBLIC_RANKING_RESPONSE_CACHE_CONTROL)
      return response
    }

    // The security-barrier view enforces public rank membership before every
    // predicate below. Keep all additional filters and the finite range in the
    // database; mapping code must never repair a page assembled from raw rows.
    let query = supabase
      .from('public_ranked_leaderboard')
      .select(PUBLIC_RANKED_LEADERBOARD_COLUMNS)
      .eq('season_id', seasonId)
      // Redundant to the view, but records the persisted-rank contract at this
      // endpoint boundary and protects a rolling migration with an older view.
      .not('rank', 'is', null)
    // Shared public cohort predicate (score floor, ROI bound, 48h window) —
    // identical to the homepage SSR page and /api/traders.
    query = applyPublicCohortFilters(query)

    if (platform) {
      query = query.eq('source', platform)
    } else if (category) {
      query = query.eq('source_type', sourceTypeForCategory(category))
    }
    if (minPnl !== undefined) query = query.gte('pnl', minPnl)
    if (hasMinTrades) query = query.gte('trades_count', minTrades)
    if (traderType === 'bot') {
      query = query.or('trader_type.eq.bot,trader_type.eq.suspected_bot,source.eq.web3_bot')
    } else if (traderType === 'human') {
      query = query.neq('source', 'web3_bot').or('trader_type.is.null,trader_type.eq.human')
    }

    const sortColumn = SORT_COLUMN[sortBy]
    query = query.order(sortColumn, { ascending: sortDir === 'asc', nullsFirst: false })
    if (sortColumn !== 'rank') {
      query = query.order('rank', { ascending: true, nullsFirst: false })
    }

    // PostgREST ranges are inclusive: one extra view row is the only
    // pagination witness. There is intentionally no count fallback.
    const { data, error } = await query.range(offset, offset + limit)
    if (error) {
      logger.error('public ranked cohort query failed', error)
      throw new Error('Public ranked cohort query failed')
    }

    const rawRows = Array.isArray(data) ? data : []
    const sanitized = sanitizePublicRankingPayload(
      { traders: rawRows, window: seasonId },
      { expectedPeriod: seasonId }
    )
    const safeRows = Array.isArray(sanitized.traders)
      ? sanitized.traders.filter(hasPositivePublishedRank)
      : ([] as Record<string, unknown>[])
    const integrityCompromised = safeRows.length !== rawRows.length
    // The view is expected to make this impossible. If a rolling schema,
    // proxy, or cache layer nevertheless returns an invalid row, do not shift
    // a later row into this finite page: that would create a false offset
    // continuation. Fail the complete page closed instead.
    if (integrityCompromised) {
      const response = apiSuccess({
        traders: [],
        window,
        totalCount: null,
        totalCountIsExact: false,
        totalcount: null,
        total_count: null,
        as_of: null,
        is_stale: true,
        source_freshness: [],
        availableSources: [],
        availableSourcesIsExact: false,
        next_cursor: null,
        hasMore: false,
        rankingMode: sortBy,
        sort_by: sortBy,
        sort_dir: sortDir,
        limit,
        offset,
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'publication_policy_filtered',
        ranking_visibility_reasons: ['ineligible_public_cohort_row_removed'],
      } satisfies PublicRankingsData)
      response.headers.set('Cache-Control', PUBLIC_RANKING_RESPONSE_CACHE_CONTROL)
      return response
    }
    const pageRows = safeRows.slice(0, limit)
    const visibleSources = filterPublicRankingSources(pageRows.map((row) => row.source))

    // `source_as_of` remains the compatibility freshness field. It is queried
    // only for displayed sources and is fail-closed: a missing/error watermark
    // means no row is returned as ranked even if the view query was successful.
    const freshnessResult =
      visibleSources.length > 0
        ? await supabase
            .from('leaderboard_source_freshness')
            .select('source,source_as_of')
            .eq('season_id', seasonId)
            .in('source', visibleSources)
        : { data: [] as SourceFreshnessRow[], error: null }
    if (freshnessResult.error) {
      logger.warn('source freshness metadata query failed', freshnessResult.error)
    }
    const freshnessSummary = summarizeSourceFreshness(
      freshnessResult.error ? [] : ((freshnessResult.data || []) as SourceFreshnessRow[]),
      visibleSources
    )

    if (pageRows.length > 0 && freshnessSummary.isStale) {
      const response = apiSuccess({
        traders: [],
        window,
        totalCount: null,
        totalCountIsExact: false,
        totalcount: null,
        total_count: null,
        as_of: freshnessSummary.asOf,
        is_stale: true,
        source_freshness: freshnessSummary.sources,
        availableSources: [],
        availableSourcesIsExact: false,
        next_cursor: null,
        hasMore: false,
        rankingMode: sortBy,
        sort_by: sortBy,
        sort_dir: sortDir,
        limit,
        offset,
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'source_freshness_unverified',
        ranking_visibility_reasons: ['source_freshness_unverified'],
      } satisfies PublicRankingsData)
      response.headers.set('Cache-Control', PUBLIC_RANKING_RESPONSE_CACHE_CONTROL)
      return response
    }

    const freshnessBySource = sourceFreshnessStatusMap(freshnessSummary)
    const traders = pageRows.map((row) => mapPublicRankedRow(row, freshnessBySource))
    const hasMore = rawRows.length > limit && !integrityCompromised
    const response = apiSuccess({
      traders,
      window,
      // No same-predicate, view-native count authority exists. A visible page
      // or lookahead must never be represented as an exact total.
      totalCount: null,
      totalCountIsExact: false,
      totalcount: null,
      total_count: null,
      as_of: freshnessSummary.asOf,
      is_stale: freshnessSummary.isStale,
      source_freshness: freshnessSummary.sources,
      // This is the visible page's source set, not an exhaustive cohort census.
      availableSources: visibleSources,
      availableSourcesIsExact: false,
      next_cursor: null,
      hasMore,
      rankingMode: sortBy,
      sort_by: sortBy,
      sort_dir: sortDir,
      limit,
      offset,
    } satisfies PublicRankingsData)
    response.headers.set('Cache-Control', PUBLIC_RANKING_RESPONSE_CACHE_CONTROL)
    return response
  },
  { name: 'rankings', rateLimit: { requests: 30, window: 60, prefix: 'rankings' } }
)
