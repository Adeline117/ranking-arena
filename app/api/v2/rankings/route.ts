/**
 * GET /api/v2/rankings
 *
 * Legacy-compatible single-source leaderboard endpoint. Its ranked cohort is
 * exclusively `public.public_ranked_leaderboard`: the database security-barrier
 * view establishes publication eligibility before this route applies caller
 * filters, ordering, or pagination. Do not substitute its retained parent
 * relation, a count cache, or a post-fetch filter for that boundary.
 *
 * `alpha` and `min_alpha` are deliberately unsupported. The public view does
 * not publish an alpha contract, so accepting either would silently label an
 * Arena Score page as a different ranking.
 */

import { NextResponse } from 'next/server'
import type { LeaderboardPlatform, MarketType, RankingEntry, Window } from '@/lib/types/leaderboard'
import {
  SOURCE_TYPE_MAP,
  parsePublicActiveRankingSource,
  type SourceType,
  type TraderSource,
} from '@/lib/constants/exchanges'
import {
  TRADING_STYLE_LEGACY_MAP,
  VALID_TRADING_STYLES,
  type TradingStyle,
} from '@/lib/utils/trading-style'
import { withPublic } from '@/lib/api/middleware'
import { summarizeSourceFreshness, type SourceFreshnessRow } from '@/lib/rankings/source-freshness'
import {
  isPublicRankingSourceQuarantined,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

// Publication actively invalidates its own serving authority. This route must
// not introduce a second CDN/ISR generation that can outlive that authority.
export const dynamic = 'force-dynamic'
const PUBLIC_RANKING_RESPONSE_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate'

const VALID_WINDOWS = ['7d', '30d', '90d'] as const
const VALID_MARKET_TYPES = ['futures', 'spot', 'web3'] as const
const VALID_SORTS = ['arena_score', 'arena_score_v3', 'roi', 'pnl', 'sortino', 'calmar'] as const
const ALLOWED_QUERY_PARAMS = new Set([
  'window',
  'platform',
  'market_type',
  'limit',
  'offset',
  'sort',
  'trading_style',
  'min_sortino',
  'min_roi',
  'min_pnl',
  'min_win_rate',
  'max_drawdown',
  'min_score',
])

const MAX_LIMIT = 500
const DEFAULT_LIMIT = 100
const MAX_OFFSET = 20_000_000

type PublicV2Window = (typeof VALID_WINDOWS)[number]
type PublicV2Sort = (typeof VALID_SORTS)[number]

const SORT_COLUMN: Record<
  PublicV2Sort,
  'arena_score' | 'arena_score_v3' | 'roi' | 'pnl' | 'sortino_ratio' | 'calmar_ratio'
> = {
  arena_score: 'arena_score',
  arena_score_v3: 'arena_score_v3',
  roi: 'roi',
  pnl: 'pnl',
  sortino: 'sortino_ratio',
  calmar: 'calmar_ratio',
}

// Explicitly select the public view projection plus the proof fields needed
// for the defensive response-boundary validation below. Those proof fields do
// not leave this endpoint as a separate publication contract.
const PUBLIC_RANKED_LEADERBOARD_COLUMNS =
  'source, source_trader_id, handle, avatar_url, source_type, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, arena_score_v3, rank, computed_at, season_id, sharpe_ratio, sortino_ratio, calmar_ratio, profitability_score, risk_control_score, execution_score, score_completeness, metrics_estimated, trading_style, avg_holding_hours, trader_type, is_outlier'

type PublicRankedLeaderboardRow = Record<string, unknown> & { rank: number }

type V2RankingEntry = RankingEntry & {
  arena_score_v3: number | null
  sortino_ratio: number | null
  calmar_ratio: number | null
  // Preserved for legacy callers as an explicit unknown. The public cohort has
  // no reviewed alpha basis, so it is never synthesized from Arena Score.
  alpha: null
  trading_style: string | null
}

interface V2RankingsResponse {
  traders: V2RankingEntry[]
  meta: {
    platform: LeaderboardPlatform
    market_type: MarketType
    window: Window
    // There is no view-native, generation-bound count authority. `null` is
    // intentionally distinct from a visible-page lower bound.
    total_count: number | null
    total_count_is_exact: boolean
    has_more: boolean
    updated_at: string | null
    staleness_seconds: number | null
    is_stale: boolean
    source_freshness: Array<{
      source: string
      updated_at: string | null
      is_stale: boolean
      age_seconds: number | null
    }>
    sort: PublicV2Sort
    limit: number
    offset: number
  }
  ranking_visibility?: 'partial'
  ranking_visibility_reason?: string
  ranking_visibility_reasons?: string[]
}

class InvalidV2RankingsParameter extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function singleQueryParam(searchParams: URLSearchParams, name: string): string | null {
  const values = searchParams.getAll(name)
  if (values.length > 1) {
    throw new InvalidV2RankingsParameter(`Query parameter ${name} may only be specified once`)
  }
  return values[0] ?? null
}

function requiredQueryParam(searchParams: URLSearchParams, name: string): string {
  const value = singleQueryParam(searchParams, name)
  if (value === null || value.length === 0) {
    throw new InvalidV2RankingsParameter(`Missing ${name}`)
  }
  return value
}

function parseStrictInteger(
  raw: string | null,
  fallback: number,
  name: string,
  min: number,
  max: number
): number {
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) throw new InvalidV2RankingsParameter(`Invalid ${name}`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new InvalidV2RankingsParameter(`Invalid ${name}`)
  }
  return parsed
}

function parseOptionalFiniteNumber(raw: string | null, name: string): number | null {
  if (raw === null) return null
  if (raw.trim() === '') throw new InvalidV2RankingsParameter(`Invalid ${name}`)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new InvalidV2RankingsParameter(`Invalid ${name}`)
  return parsed
}

function parseWindow(value: string): PublicV2Window {
  if (!(VALID_WINDOWS as readonly string[]).includes(value)) {
    throw new InvalidV2RankingsParameter('Invalid window')
  }
  return value as PublicV2Window
}

function parsePlatform(value: string): TraderSource {
  const source = parsePublicActiveRankingSource(value)
  if (!source) throw new InvalidV2RankingsParameter('Invalid platform')
  return source
}

function parseMarketType(value: string | null, platform: TraderSource): SourceType {
  if (value === null) {
    const canonical = SOURCE_TYPE_MAP[platform]
    if (!canonical) throw new InvalidV2RankingsParameter('Platform has no canonical market type')
    return canonical
  }
  if (!(VALID_MARKET_TYPES as readonly string[]).includes(value)) {
    throw new InvalidV2RankingsParameter('Invalid market_type')
  }
  return value as SourceType
}

function parseSort(value: string | null): PublicV2Sort {
  if (value === null) return 'arena_score'
  if (!(VALID_SORTS as readonly string[]).includes(value)) {
    throw new InvalidV2RankingsParameter(`Unsupported sort: ${value}`)
  }
  return value as PublicV2Sort
}

function parseTradingStyle(value: string | null): TradingStyle | null {
  if (value === null) return null
  const allValidStyles = new Set<string>([
    ...VALID_TRADING_STYLES,
    ...Object.keys(TRADING_STYLE_LEGACY_MAP),
  ])
  if (!allValidStyles.has(value)) {
    throw new InvalidV2RankingsParameter(
      `Invalid trading_style. Must be one of: ${VALID_TRADING_STYLES.join(', ')}`
    )
  }
  return (
    TRADING_STYLE_LEGACY_MAP[value as keyof typeof TRADING_STYLE_LEGACY_MAP] ??
    (value as TradingStyle)
  )
}

function isPositivePublishedRank(row: unknown): row is PublicRankedLeaderboardRow {
  return (
    isRecord(row) && typeof row.rank === 'number' && Number.isSafeInteger(row.rank) && row.rank > 0
  )
}

function isExpectedPublicRankedRow(
  row: unknown,
  platform: TraderSource,
  marketType: SourceType,
  seasonId: string
): row is PublicRankedLeaderboardRow {
  return (
    isPositivePublishedRank(row) &&
    row.source === platform &&
    row.source_type === marketType &&
    row.season_id === seasonId
  )
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function emptyResponse(
  platform: LeaderboardPlatform,
  marketType: MarketType,
  window: Window,
  sort: PublicV2Sort,
  limit: number,
  offset: number,
  options: {
    totalCount: number | null
    totalCountIsExact: boolean
    updatedAt?: string | null
    stalenessSeconds?: number | null
    sourceFreshness?: V2RankingsResponse['meta']['source_freshness']
    reason: string
    reasons: string[]
  }
): V2RankingsResponse {
  return {
    traders: [],
    meta: {
      platform,
      market_type: marketType,
      window,
      total_count: options.totalCount,
      total_count_is_exact: options.totalCountIsExact,
      has_more: false,
      updated_at: options.updatedAt ?? null,
      staleness_seconds: options.stalenessSeconds ?? null,
      is_stale: true,
      source_freshness: options.sourceFreshness ?? [],
      sort,
      limit,
      offset,
    },
    ranking_visibility: 'partial',
    ranking_visibility_reason: options.reason,
    ranking_visibility_reasons: options.reasons,
  }
}

function jsonResponse(payload: V2RankingsResponse, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': PUBLIC_RANKING_RESPONSE_CACHE_CONTROL },
  })
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)

    let window: PublicV2Window
    let requestedPlatform: TraderSource
    let marketType: SourceType
    let limit: number
    let offset: number
    let sort: PublicV2Sort
    let tradingStyle: TradingStyle | null
    let minSortino: number | null
    let minRoi: number | null
    let minPnl: number | null
    let minWinRate: number | null
    let maxDrawdown: number | null
    let minScore: number | null

    try {
      for (const [name] of searchParams) {
        if (!ALLOWED_QUERY_PARAMS.has(name)) {
          throw new InvalidV2RankingsParameter(`Unsupported query parameter: ${name}`)
        }
      }

      window = parseWindow(requiredQueryParam(searchParams, 'window'))
      requestedPlatform = parsePlatform(requiredQueryParam(searchParams, 'platform'))
      marketType = parseMarketType(singleQueryParam(searchParams, 'market_type'), requestedPlatform)
      limit = parseStrictInteger(
        singleQueryParam(searchParams, 'limit'),
        DEFAULT_LIMIT,
        'limit',
        1,
        MAX_LIMIT
      )
      offset = parseStrictInteger(
        singleQueryParam(searchParams, 'offset'),
        0,
        'offset',
        0,
        MAX_OFFSET
      )
      sort = parseSort(singleQueryParam(searchParams, 'sort'))
      tradingStyle = parseTradingStyle(singleQueryParam(searchParams, 'trading_style'))
      minSortino = parseOptionalFiniteNumber(
        singleQueryParam(searchParams, 'min_sortino'),
        'min_sortino'
      )
      minRoi = parseOptionalFiniteNumber(singleQueryParam(searchParams, 'min_roi'), 'min_roi')
      minPnl = parseOptionalFiniteNumber(singleQueryParam(searchParams, 'min_pnl'), 'min_pnl')
      minWinRate = parseOptionalFiniteNumber(
        singleQueryParam(searchParams, 'min_win_rate'),
        'min_win_rate'
      )
      maxDrawdown = parseOptionalFiniteNumber(
        singleQueryParam(searchParams, 'max_drawdown'),
        'max_drawdown'
      )
      minScore = parseOptionalFiniteNumber(singleQueryParam(searchParams, 'min_score'), 'min_score')
    } catch (error) {
      if (error instanceof InvalidV2RankingsParameter) {
        return NextResponse.json(
          { error: 'Invalid parameters', message: error.message },
          {
            status: 400,
            headers: { 'Cache-Control': PUBLIC_RANKING_RESPONSE_CACHE_CONTROL },
          }
        )
      }
      throw error
    }

    const platform = requestedPlatform as LeaderboardPlatform
    const responseMarketType = marketType as MarketType

    // Quarantine is a declared empty public scope, so zero is exact here. It
    // is not a fallback for a failed count or an unverified query.
    if (isPublicRankingSourceQuarantined(requestedPlatform)) {
      return jsonResponse(
        emptyResponse(platform, responseMarketType, window, sort, limit, offset, {
          totalCount: 0,
          totalCountIsExact: true,
          reason: 'publication_policy_filtered',
          reasons: ['quarantined_source_requested'],
        })
      )
    }

    const seasonId = window.toUpperCase()
    // The view's security barrier must run before all request-derived clauses.
    // Keep filters, deterministic order, and the bounded lookahead range in
    // one SQL builder; never construct this page from raw rank rows.
    let query = supabase
      .from('public_ranked_leaderboard')
      .select(PUBLIC_RANKED_LEADERBOARD_COLUMNS)
      .eq('source', requestedPlatform)
      .eq('source_type', marketType)
      .eq('season_id', seasonId)
      .not('rank', 'is', null)

    if (tradingStyle) query = query.eq('trading_style', tradingStyle)
    if (minSortino !== null) query = query.gte('sortino_ratio', minSortino)
    if (minRoi !== null) query = query.gte('roi', minRoi)
    if (minPnl !== null) query = query.gte('pnl', minPnl)
    if (minWinRate !== null) query = query.gte('win_rate', minWinRate)
    if (maxDrawdown !== null) query = query.lte('max_drawdown', maxDrawdown)
    if (minScore !== null) query = query.gte('arena_score', minScore)

    query = query.order(SORT_COLUMN[sort], { ascending: false, nullsFirst: false })
    // Persisted rank is the only final tiebreaker. It keeps pages stable even
    // for a metric sort whose primary values are equal.
    query = query.order('rank', { ascending: true, nullsFirst: false })

    // PostgREST ranges are inclusive. One same-cohort lookahead row is the
    // only pagination witness; no count cache can prove a total.
    const { data, error } = await query.range(offset, offset + limit)
    if (error) {
      throw new Error('public_ranked_leaderboard query failed')
    }

    const rawRows = Array.isArray(data) ? data : []
    const sanitized = sanitizePublicRankingPayload(
      { traders: rawRows, window: seasonId },
      { expectedPeriod: seasonId }
    ) as { traders?: unknown[] }
    const safeRows = Array.isArray(sanitized.traders)
      ? sanitized.traders.filter((row) =>
          isExpectedPublicRankedRow(row, requestedPlatform, marketType, seasonId)
        )
      : ([] as PublicRankedLeaderboardRow[])

    // A view/proxy/schema violation must not be repaired by removing one row
    // and shifting a later record into this offset page. Return the complete
    // page as partial/unknown instead.
    if (safeRows.length !== rawRows.length) {
      return jsonResponse(
        emptyResponse(platform, responseMarketType, window, sort, limit, offset, {
          totalCount: null,
          totalCountIsExact: false,
          reason: 'publication_policy_filtered',
          reasons: ['ineligible_public_cohort_row_removed'],
        })
      )
    }

    const pageRows = safeRows.slice(0, limit)
    // `source_as_of` is independent upstream evidence; score computation time
    // is never a freshness substitute. A missing/error watermark hides ranked
    // rows rather than downgrading them to a cosmetic stale warning.
    const freshnessResult = await supabase
      .from('leaderboard_source_freshness')
      .select('source,source_as_of')
      .eq('season_id', seasonId)
      .eq('source', requestedPlatform)
    const freshnessSummary = summarizeSourceFreshness(
      freshnessResult.error ? [] : ((freshnessResult.data || []) as SourceFreshnessRow[]),
      [requestedPlatform]
    )

    if (pageRows.length > 0 && freshnessSummary.isStale) {
      return jsonResponse(
        emptyResponse(platform, responseMarketType, window, sort, limit, offset, {
          totalCount: null,
          totalCountIsExact: false,
          updatedAt: freshnessSummary.asOf,
          stalenessSeconds: freshnessSummary.ageSeconds,
          sourceFreshness: freshnessSummary.sources,
          reason: 'source_freshness_unverified',
          reasons: ['source_freshness_unverified'],
        })
      )
    }

    const traders: V2RankingEntry[] = pageRows.map((row) => ({
      platform,
      market_type: responseMarketType,
      trader_key: String(row.source_trader_id),
      display_name: typeof row.handle === 'string' ? row.handle : null,
      avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
      window,
      metrics: {
        roi: nullableFiniteNumber(row.roi),
        pnl: nullableFiniteNumber(row.pnl),
        win_rate: nullableFiniteNumber(row.win_rate),
        max_drawdown: nullableFiniteNumber(row.max_drawdown),
        sharpe_ratio: nullableFiniteNumber(row.sharpe_ratio),
        sortino_ratio: nullableFiniteNumber(row.sortino_ratio),
        trades_count: nullableFiniteNumber(row.trades_count),
        followers: nullableFiniteNumber(row.followers),
        copiers: nullableFiniteNumber(row.copiers),
        aum: null,
        platform_rank: row.rank,
        arena_score: nullableFiniteNumber(row.arena_score),
        return_score: null,
        drawdown_score: null,
        stability_score: null,
        volatility_pct: null,
        avg_holding_hours: nullableFiniteNumber(row.avg_holding_hours),
        profit_factor: null,
      },
      quality_flags: {
        missing_fields: [],
        non_standard_fields: {},
        window_native: true,
        notes: [],
      },
      updated_at: freshnessSummary.asOf,
      is_stale: freshnessSummary.isStale,
      computed_at: typeof row.computed_at === 'string' ? row.computed_at : null,
      // V2's historical extension fields remain shape-compatible, but now
      // reflect only columns explicitly published by the SQL view. Alpha stays
      // `null` because there is no public alpha proof contract.
      arena_score_v3: nullableFiniteNumber(row.arena_score_v3),
      sortino_ratio: nullableFiniteNumber(row.sortino_ratio),
      calmar_ratio: nullableFiniteNumber(row.calmar_ratio),
      alpha: null,
      trading_style: typeof row.trading_style === 'string' ? row.trading_style : null,
    }))

    const response: V2RankingsResponse = {
      traders,
      meta: {
        platform,
        market_type: responseMarketType,
        window,
        total_count: null,
        total_count_is_exact: false,
        has_more: rawRows.length > limit,
        updated_at: freshnessSummary.asOf,
        staleness_seconds: freshnessSummary.ageSeconds,
        is_stale: freshnessSummary.isStale,
        source_freshness: freshnessSummary.sources,
        sort,
        limit,
        offset,
      },
    }
    return jsonResponse(response)
  },
  { name: 'v2-rankings' }
)
