/**
 * Near-real-time public rankings.
 *
 * The security-barrier `public_ranked_leaderboard` view is the only authority
 * for a public ranked row. It validates the sealed serving head before this
 * route applies its finite page; raw rank rows and estimated totals are never
 * a fallback for this surface.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import {
  filterPublicRankingSources,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const logger = createLogger('rankings-live')
const PUBLIC_RANKING_RESPONSE_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate'
const LIVE_QUERY_KEYS = new Set(['period', 'limit', 'offset'])

const liveRankingsSchema = z.object({
  period: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.toUpperCase() : value),
      z.enum(['7D', '30D', '90D'])
    )
    .optional()
    .default('90D'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  // Keeps the inclusive PostgREST range bounded even for a malformed share URL.
  offset: z.coerce.number().int().min(0).max(20_000_000).optional().default(0),
})

const PUBLIC_RANKED_LEADERBOARD_COLUMNS =
  'source_trader_id,handle,roi,pnl,win_rate,max_drawdown,trades_count,followers,copiers,source,source_type,avatar_url,arena_score,rank,rank_change,is_new,profitability_score,risk_control_score,execution_score,score_completeness,metrics_estimated,trading_style,avg_holding_hours,style_confidence,computed_at,season_id,sharpe_ratio,sortino_ratio,profit_factor,calmar_ratio,trader_type,is_outlier'

interface PublicRankedLeaderboardQueryResult {
  data: unknown[] | null
  error: { message: string } | null
}

type PublicRankedLeaderboardQuery = PromiseLike<PublicRankedLeaderboardQueryResult> & {
  select(columns: string): PublicRankedLeaderboardQuery
  eq(column: string, value: string): PublicRankedLeaderboardQuery
  not(column: string, operator: string, value: null): PublicRankedLeaderboardQuery
  order(
    column: string,
    options: { ascending: boolean; nullsFirst: boolean }
  ): PublicRankedLeaderboardQuery
  range(from: number, to: number): PublicRankedLeaderboardQuery
}

type PublicRankedLeaderboardClient = {
  from(relation: 'public_ranked_leaderboard'): PublicRankedLeaderboardQuery
}

type PublicRankedLeaderboardRow = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPublicRankedLeaderboardClient(value: unknown): value is PublicRankedLeaderboardClient {
  return isRecord(value) && typeof value.from === 'function'
}

function publicRankedLeaderboardClient(
  supabase: ReturnType<typeof getSupabaseAdmin>
): PublicRankedLeaderboardClient {
  // The view is introduced by a migration and is not yet in generated types.
  // Keep this tiny checked bridge local rather than widening the entire client.
  if (!isPublicRankedLeaderboardClient(supabase)) {
    throw new TypeError('Supabase client does not expose the public ranking cohort')
  }
  return supabase
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function hasPositiveRank(row: unknown): row is PublicRankedLeaderboardRow {
  return (
    isRecord(row) && typeof row.rank === 'number' && Number.isSafeInteger(row.rank) && row.rank > 0
  )
}

function mapPublicRankedRow(row: PublicRankedLeaderboardRow) {
  const source = stringOrNull(row.source)
  const traderType = stringOrNull(row.trader_type)
  return {
    id: stringOrNull(row.source_trader_id),
    source_trader_id: stringOrNull(row.source_trader_id),
    handle: stringOrNull(row.handle),
    source,
    source_type: stringOrNull(row.source_type),
    arena_score: finiteOrNull(row.arena_score),
    rank: row.rank,
    roi: finiteOrNull(row.roi),
    pnl: finiteOrNull(row.pnl),
    win_rate: finiteOrNull(row.win_rate),
    max_drawdown: finiteOrNull(row.max_drawdown),
    trades_count: finiteOrNull(row.trades_count),
    followers: finiteOrNull(row.followers),
    copiers: finiteOrNull(row.copiers),
    avatar_url: stringOrNull(row.avatar_url),
    profitability_score: finiteOrNull(row.profitability_score),
    risk_control_score: finiteOrNull(row.risk_control_score),
    execution_score: finiteOrNull(row.execution_score),
    trading_style: stringOrNull(row.trading_style),
    sharpe_ratio: finiteOrNull(row.sharpe_ratio),
    sortino_ratio: finiteOrNull(row.sortino_ratio),
    profit_factor: finiteOrNull(row.profit_factor),
    calmar_ratio: finiteOrNull(row.calmar_ratio),
    rank_change: finiteOrNull(row.rank_change),
    is_new: row.is_new === true,
    computed_at: stringOrNull(row.computed_at),
    trader_type: traderType,
    is_bot: source === 'web3_bot' || traderType === 'bot' || traderType === 'suspected_bot',
  }
}

function invalidParameters(searchParams: URLSearchParams): boolean {
  for (const key of searchParams.keys()) {
    if (!LIVE_QUERY_KEYS.has(key) || searchParams.getAll(key).length !== 1) return true
  }
  return false
}

function response(body: Record<string, unknown>, cache: 'BYPASS' | 'MISS') {
  const next = NextResponse.json(body)
  next.headers.set('Cache-Control', PUBLIC_RANKING_RESPONSE_CACHE_CONTROL)
  next.headers.set('X-Cache', cache)
  return next
}

function partialResponse(
  period: '7D' | '30D' | '90D',
  limit: number,
  offset: number,
  reason: string
) {
  return response(
    {
      traders: [],
      period,
      source: 'public_cohort',
      total: null,
      totalCount: null,
      total_count: null,
      totalCountIsExact: false,
      hasMore: false,
      as_of: null,
      is_stale: true,
      source_freshness: [],
      availableSources: [],
      availableSourcesIsExact: false,
      limit,
      offset,
      ranking_visibility: 'partial',
      ranking_visibility_reason: reason,
      ranking_visibility_reasons: [reason],
    },
    'BYPASS'
  )
}

export async function GET(request: NextRequest) {
  const rateLimited = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimited) return rateLimited

  const searchParams = request.nextUrl.searchParams
  if (invalidParameters(searchParams)) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 })
  }
  const parsed = liveRankingsSchema.safeParse(Object.fromEntries(searchParams))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid parameters', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { period, limit, offset } = parsed.data
  try {
    const query = publicRankedLeaderboardClient(getSupabaseAdmin())
      .from('public_ranked_leaderboard')
      .select(PUBLIC_RANKED_LEADERBOARD_COLUMNS)
      .eq('season_id', period)
      .not('rank', 'is', null)
      .order('rank', { ascending: true, nullsFirst: false })
      // PostgREST ranges are inclusive; the extra row is the sole continuation
      // witness. Never substitute an estimated/raw table count.
      .range(offset, offset + limit)

    const { data, error } = await query
    if (error) {
      logger.error('[rankings-live] public cohort query failed', error)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    const rawRows = Array.isArray(data) ? data : []
    const sanitized = sanitizePublicRankingPayload(
      { traders: rawRows, period },
      { expectedPeriod: period }
    ) as { traders?: unknown[] }
    const safeRows = Array.isArray(sanitized.traders)
      ? sanitized.traders.filter(hasPositiveRank)
      : ([] as PublicRankedLeaderboardRow[])

    // A valid security-barrier view cannot return an ineligible row. Treat a
    // proxy/schema mismatch as a whole-page proof failure rather than shifting
    // later entries into this offset and making `hasMore` untrue.
    if (safeRows.length !== rawRows.length) {
      return partialResponse(period, limit, offset, 'publication_policy_filtered')
    }

    const pageRows = safeRows.slice(0, limit)
    const visibleSources = filterPublicRankingSources(pageRows.map((row) => row.source))
    return response(
      {
        traders: pageRows.map(mapPublicRankedRow),
        period,
        source: 'public_cohort',
        total: null,
        totalCount: null,
        total_count: null,
        totalCountIsExact: false,
        hasMore: rawRows.length > limit,
        // The view's serving head validates source freshness internally. It
        // intentionally does not expose receipt/watermark proof tokens here.
        as_of: null,
        is_stale: false,
        source_freshness: [],
        availableSources: visibleSources,
        availableSourcesIsExact: false,
        limit,
        offset,
      },
      'MISS'
    )
  } catch (error) {
    logger.error('[rankings-live] Unexpected error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
