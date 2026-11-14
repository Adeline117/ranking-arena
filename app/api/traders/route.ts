/**
 * 排行榜交易员数据 API (V3 — reads from the public-ranked cohort view)
 *
 * Supports:
 * - Cursor-based pagination: ?cursor=xxx&limit=50
 * - Exchange filter: ?exchange=binance_futures
 * - Sort: ?sortBy=arena_score|roi|pnl|win_rate|max_drawdown|sortino_ratio&order=desc|asc
 * - Time range: ?timeRange=7D|30D|90D
 * - Legacy page-based pagination still works: ?page=0&limit=500
 *
 * Performance: one bounded public cohort query + Redis cache of raw view rows.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import { getOrSetWithLock, readSharedCacheWriteFence, set as setCache } from '@/lib/cache'
import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { computeAntiGamingFlags } from '@/lib/scoring/anti-gaming'
import { getVerifiedTraderKeys, verifiedTraderKey } from '@/lib/data/verified-traders'
import { applyPublicCohortFilters, isInPublicCohort } from '@/lib/rankings/public-cohort'
import { validateTradersResponse } from '@/lib/api/traders-response-schema'
import { attachAvatarMirrors } from '@/lib/data/avatar-mirrors'
import { claimedTraderBadgeKey, getClaimedTraderBadgeKeys } from '@/lib/data/claimed-trader-badges'
import { SOURCE_TYPE_MAP, parsePublicActiveRankingSource } from '@/lib/constants/exchanges'
import type { PublicTradersListResponse } from '@/lib/contracts/traders-list'
import {
  sourceFreshnessStatusMap,
  summarizeSourceFreshness,
  type SourceFreshnessRow,
} from '@/lib/rankings/source-freshness'
import {
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  filterPublicRankingSources,
  isPublicRankingSourceQuarantined,
  publicRankingCacheKey,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

const logger = createLogger('traders-api')
const PUBLIC_RANKING_RESPONSE_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate'

export const runtime = 'nodejs'
export const preferredRegion = ['iad1', 'sfo1', 'hnd1']
export const dynamic = 'force-dynamic'

const PUBLIC_TRADERS_SORT_BY = [
  'arena_score',
  'roi',
  'pnl',
  'win_rate',
  'max_drawdown',
  'sortino_ratio',
] as const

type PublicTradersSortBy = (typeof PUBLIC_TRADERS_SORT_BY)[number]

// ── Input validation schema ──────────────────────────────────────────────────
/** Upper bound for a rank cursor / legacy page offset (rows). */
const MAX_PUBLIC_RANK = 50_000
const tradersQuerySchema = z.object({
  // Omission has a safe default; an explicit malformed value is a client
  // error. Silently changing a shared URL's period/order changes the cohort
  // it claims to describe.
  timeRange: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.toUpperCase() : value),
      z.enum(['7D', '30D', '90D'])
    )
    .optional()
    .default('90D'),
  exchange: z.string().optional(),
  category: z.enum(['futures', 'spot', 'onchain']).optional(),
  // Omitted means Arena Score; an explicitly unsupported field is a client
  // contract error. Never silently publish an Arena Score cohort as `alpha`
  // (or any other requested metric).
  sortBy: z.enum(PUBLIC_TRADERS_SORT_BY).optional().default('arena_score'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  // Every accepted value becomes part of the Redis cache key, so each bound
  // below also bounds cache-key cardinality (one DB read + one ≤limit+1-row
  // Redis value per distinct key). Bounds sit well above the real cohort:
  // the whole public board is ~34k traders.
  cursor: z.coerce.number().int().min(0).max(MAX_PUBLIC_RANK).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  page: z.coerce.number().int().min(0).max(1_000).optional(),
})

// Select only the response fields plus row-level publication proof required to
// validate Redis payloads at read time. These proof fields never leave the API.
const PUBLIC_RANKED_LEADERBOARD_COLUMNS =
  'source_trader_id, handle, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, source, source_type, avatar_url, arena_score, rank, rank_change, is_new, profitability_score, risk_control_score, execution_score, score_completeness, metrics_estimated, trading_style, avg_holding_hours, style_confidence, computed_at, season_id, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trader_type, is_outlier'

interface TradersCacheKeyParams {
  timeRange: Period
  exchangeFilter: string | null
  categoryFilter: string | null
  sortBy: PublicTradersSortBy
  order: 'asc' | 'desc'
  cursor: number | null
  limit: number
  useLegacyPaging: boolean
  page: number
}

/**
 * Every raw cohort entry is bound to the complete parsed request. Besides
 * defending against an accidental key change, this makes cache payloads
 * self-authenticating at the read boundary: an `exchange=all` request is not
 * interchangeable with an omitted `exchange` filter.
 */
interface PublicRankedCohortCacheScope {
  timeRange: Period
  exchangeFilter: string | null
  categoryFilter: string | null
  sortBy: PublicTradersSortBy
  order: 'asc' | 'desc'
  cursor: number | null
  limit: number
  useLegacyPaging: boolean
  page: number
}

function publicRankedCohortCacheScope(params: TradersCacheKeyParams): PublicRankedCohortCacheScope {
  return {
    timeRange: params.timeRange,
    exchangeFilter: params.exchangeFilter,
    categoryFilter: params.categoryFilter,
    sortBy: params.sortBy,
    order: params.order,
    cursor: params.cursor,
    limit: params.limit,
    useLegacyPaging: params.useLegacyPaging,
    page: params.page,
  }
}

function hasPublicRankedCohortCacheScope(
  value: unknown,
  expected: TradersCacheKeyParams
): value is PublicRankedCohortCacheScope {
  if (!isRecord(value)) return false
  const scope = publicRankedCohortCacheScope(expected)
  return (
    value.timeRange === scope.timeRange &&
    value.exchangeFilter === scope.exchangeFilter &&
    value.categoryFilter === scope.categoryFilter &&
    value.sortBy === scope.sortBy &&
    value.order === scope.order &&
    value.cursor === scope.cursor &&
    value.limit === scope.limit &&
    value.useLegacyPaging === scope.useLegacyPaging &&
    value.page === scope.page
  )
}

function tradersResponseCacheKey(params: TradersCacheKeyParams): string {
  // Serialize the complete normalized scope in a fixed field order. In
  // particular, JSON preserves `null` for an omitted exchange while retaining
  // the literal string for `exchange=all`.
  const scope = encodeURIComponent(JSON.stringify(publicRankedCohortCacheScope(params)))
  return publicRankingCacheKey(`leaderboard:v5:public-cohort:${scope}`)
}

type PublicRankedLeaderboardRow = Record<string, unknown>

interface PublicRankedCohortCacheValue {
  scope: PublicRankedCohortCacheScope
  rows: unknown[]
  /** A full sanitizer rejected a row or the cache envelope at some point. */
  integrityCompromised?: true
}

interface SanitizedPublicRankedCohort {
  rows: PublicRankedLeaderboardRow[]
  integrityCompromised: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasPositivePublishedRank(row: unknown): row is PublicRankedLeaderboardRow {
  return (
    isRecord(row) && typeof row.rank === 'number' && Number.isSafeInteger(row.rank) && row.rank > 0
  )
}

function isWithinPublicServingFreshness(
  row: PublicRankedLeaderboardRow,
  nowMs = Date.now()
): boolean {
  // Same predicate the SQL applied (shared with SSR and /api/rankings).
  return isInPublicCohort(
    { arena_score: row.arena_score, roi: row.roi, computed_at: row.computed_at },
    nowMs
  )
}

/**
 * Cache entries retain raw view rows rather than the projected API DTO. That
 * lets every cache hit re-run the complete publication proof (including age
 * and period), instead of merely checking the source quarantine.
 */
function sanitizePublicRankedCohort(
  value: unknown,
  expected: TradersCacheKeyParams
): SanitizedPublicRankedCohort {
  const envelope = isRecord(value) ? value : null
  const cachedRows = envelope?.rows
  const validEnvelope =
    hasPublicRankedCohortCacheScope(envelope?.scope, expected) && Array.isArray(cachedRows)
  // A cache key is not sufficient proof on its own: fail closed when an entry
  // is cross-scope or malformed instead of treating its rows as this cohort.
  const rows = validEnvelope && Array.isArray(cachedRows) ? cachedRows : []
  const priorIntegrityCompromised = envelope?.integrityCompromised === true
  const sanitizedPayload = sanitizePublicRankingPayload(
    { traders: rows, timeRange: expected.timeRange },
    { expectedPeriod: expected.timeRange }
  ) as { traders?: unknown[] }
  const proofRows = Array.isArray(sanitizedPayload.traders) ? sanitizedPayload.traders : []
  const safeRows = proofRows
    .filter(hasPositivePublishedRank)
    .filter((row) => isWithinPublicServingFreshness(row))

  return {
    rows: safeRows,
    integrityCompromised:
      !validEnvelope ||
      priorIntegrityCompromised ||
      safeRows.length !== rows.length ||
      proofRows.length !== rows.length ||
      safeRows.length !== proofRows.length,
  }
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    const searchParams = request.nextUrl.searchParams
    const rawParams = Object.fromEntries(searchParams)
    const parsed = tradersQuerySchema.safeParse(rawParams)
    if (!parsed.success) {
      return badRequest('Invalid parameters')
    }

    const {
      timeRange: timeRangeStr,
      exchange: exchangeFilter,
      category: categoryFilter,
      sortBy,
      order,
      limit,
    } = parsed.data
    const timeRange = timeRangeStr as Period
    const cursor = parsed.data.cursor ?? null
    const page = parsed.data.page ?? null
    const legacyPage = page ?? 0
    const useLegacyPaging = page !== null && cursor === null

    // A rank cursor is a continuation only for the persisted arena-score
    // order. Silently ignoring it for another sort repeats page one and makes
    // the returned cursor false.
    if (cursor !== null && (sortBy !== 'arena_score' || order !== 'desc')) {
      return badRequest('Cursor pagination requires arena_score descending order')
    }

    if (useLegacyPaging && legacyPage * limit > MAX_PUBLIC_RANK) {
      return badRequest('Invalid parameters')
    }

    // Exact canonical source ids only (same parser as /api/rankings). An
    // arbitrary string would otherwise mint a fresh cache key + DB read per
    // value. Quarantined sources stay accepted: they return an explicit empty
    // response below without touching cache or DB.
    if (
      exchangeFilter !== undefined &&
      parsePublicActiveRankingSource(exchangeFilter) === null &&
      !isPublicRankingSourceQuarantined(exchangeFilter)
    ) {
      return badRequest('Invalid exchange')
    }

    if (isPublicRankingSourceQuarantined(exchangeFilter)) {
      return NextResponse.json(
        {
          traders: [],
          timeRange,
          totalCount: 0,
          totalCountIsExact: true,
          rankingMode: sortBy,
          lastUpdated: null,
          isStale: true,
          dataAgeMinutes: null,
          source_freshness: [],
          nextCursor: null,
          hasMore: false,
          page: useLegacyPaging ? legacyPage : undefined,
          limit,
          availableSources: [],
          ranking_visibility: 'partial',
          ranking_visibility_reason: 'publication_policy_filtered',
          ranking_visibility_reasons: ['quarantined_source_requested'],
        } satisfies PublicTradersListResponse,
        { headers: { 'Cache-Control': PUBLIC_RANKING_RESPONSE_CACHE_CONTROL } }
      )
    }

    // Cache key
    const cacheParams: TradersCacheKeyParams = {
      timeRange,
      exchangeFilter: exchangeFilter ?? null,
      categoryFilter: categoryFilter ?? null,
      sortBy,
      order,
      cursor,
      limit,
      useLegacyPaging,
      page: useLegacyPaging ? legacyPage : 0,
    }
    const cacheKey = tradersResponseCacheKey(cacheParams)

    const cachedCohort = await getOrSetWithLock<PublicRankedCohortCacheValue>(
      cacheKey,
      async () => {
        const fetched = await fetchPublicRankedCohort(supabase, cacheParams)
        const sanitized = sanitizePublicRankedCohort(fetched, cacheParams)
        return {
          scope: publicRankedCohortCacheScope(cacheParams),
          rows: sanitized.rows,
          ...(sanitized.integrityCompromised ? { integrityCompromised: true as const } : {}),
        }
      },
      {
        ttl: 300,
        lockTtl: 10,
        tags: [PUBLIC_RANKING_REDIS_TAG, `season:${timeRange}`],
        skipMemory: true,
        writeFenceKey: PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
      }
    )
    // Revalidate after every cache read. A cached row may cross the six-hour
    // serving boundary while it is still inside the short Redis TTL.
    const cohort = sanitizePublicRankedCohort(cachedCohort, cacheParams)
    const cachedData = await buildPublicTradersResponse(supabase, cacheParams, cohort)

    // Dev-only: validate output shape to catch response drift early (no-op in prod)
    validateTradersResponse(cachedData, logger)

    const response = NextResponse.json(cachedData)
    // The Redis generation is actively invalidated by publication; an opaque
    // CDN SWR object is not. Keep the response fleet-coherent via Redis only.
    response.headers.set('Cache-Control', PUBLIC_RANKING_RESPONSE_CACHE_CONTROL)
    // Expose data age for monitoring and frontend staleness indicators
    if (cachedData?.dataAgeMinutes != null) {
      response.headers.set('X-Data-Age-Minutes', String(cachedData.dataAgeMinutes))
    }
    if (cachedData?.isStale) {
      response.headers.set('X-Data-Stale', 'true')
    }
    return response
  },
  { name: 'traders', rateLimit: 'read' }
)

// This map is intentionally exhaustive over the public-view sort contract.
// Do not add a source-table-only metric here without first projecting it from
// `public_ranked_leaderboard` and reviewing its publication proof.
const SORT_COLUMN: Record<PublicTradersSortBy, PublicTradersSortBy> = {
  arena_score: 'arena_score',
  roi: 'roi',
  pnl: 'pnl',
  win_rate: 'win_rate',
  max_drawdown: 'max_drawdown',
  sortino_ratio: 'sortino_ratio',
}

/**
 * Warm the exact default raw public-cohort key consumed by `/api/traders`.
 * Projection, avatars, and source freshness are intentionally rebuilt on each
 * request; only complete proof-bearing view rows are shared in Redis.
 */
export async function warmDefaultPublicTradersCache(
  supabase: ReturnType<typeof import('@/lib/supabase/server').getSupabaseAdmin>,
  timeRange: Period,
  limit = 50
): Promise<number> {
  const writeFence = await readSharedCacheWriteFence(PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY)
  if (!writeFence) {
    throw new Error(`[${timeRange}] public traders cache write fence was not available`)
  }
  const params: TradersCacheKeyParams = {
    timeRange,
    exchangeFilter: null,
    categoryFilter: null,
    sortBy: 'arena_score',
    order: 'desc',
    cursor: null,
    limit,
    useLegacyPaging: false,
    page: 0,
  }
  const fetched = await fetchPublicRankedCohort(supabase, params)
  const cohort = sanitizePublicRankedCohort(fetched, params)
  if (!cohort.rows.length) {
    throw new Error(`[${timeRange}] public traders cache warmup returned no ranked rows`)
  }
  const cacheValue: PublicRankedCohortCacheValue = {
    scope: publicRankedCohortCacheScope(params),
    rows: cohort.rows,
    ...(cohort.integrityCompromised ? { integrityCompromised: true as const } : {}),
  }
  const written = await setCache(tradersResponseCacheKey(params), cacheValue, {
    ttl: 300,
    tags: [PUBLIC_RANKING_REDIS_TAG, `season:${timeRange}`],
    skipMemory: true,
    writeFence,
  })
  if (!written) {
    throw new Error(`[${timeRange}] public traders Redis cache write was not confirmed`)
  }
  return Math.min(cohort.rows.length, limit)
}

async function fetchPublicRankedCohort(
  supabase: ReturnType<typeof import('@/lib/supabase/server').getSupabaseAdmin>,
  params: TradersCacheKeyParams
): Promise<PublicRankedCohortCacheValue> {
  const {
    timeRange,
    exchangeFilter,
    categoryFilter,
    sortBy,
    order,
    cursor,
    limit,
    useLegacyPaging,
    page,
  } = params

  // The security-barrier view is the only public cohort authority. Do not
  // reproduce its proof predicates here or read the wider raw rank table.
  // Shared public cohort predicate (score floor, ROI bound, 48h window) —
  // identical to the homepage SSR page and /api/rankings.
  let query = applyPublicCohortFilters(
    supabase
      .from('public_ranked_leaderboard')
      .select(PUBLIC_RANKED_LEADERBOARD_COLUMNS)
      .eq('season_id', timeRange)
  )

  if (exchangeFilter) {
    query = query.eq('source', exchangeFilter)
  }

  // Category filter: map frontend category to source_type in DB
  if (categoryFilter && !exchangeFilter) {
    const sourceType = categoryFilter === 'onchain' ? 'web3' : categoryFilter
    query = query.eq('source_type', sourceType)
  }

  // Cursor-based pagination keys on `rank`, which is a total order derived from
  // arena_score DESC. So `rank > cursor` is a valid continuation ONLY for the
  // default arena_score-desc sort. For roi/win_rate/etc. `rank` has no relation
  // to the sort order, so a rank cursor would silently drop an arbitrary set of
  // rows (page 2 not a continuation of page 1). Apply it only where it's correct;
  // non-default sorts must use page-based pagination.
  if (cursor != null) {
    query = query.gt('rank', cursor)
  }

  // Sort
  const sortColumn = SORT_COLUMN[sortBy]
  const ascending = order === 'asc'

  if (sortBy === 'arena_score') {
    query = query.order('arena_score', { ascending, nullsFirst: false })
  } else {
    query = query.order(sortColumn, { ascending, nullsFirst: false })
  }
  // Persisted rank is the publication authority's deterministic tie-break.
  // The rerank writer resolves equal arena_score rows into rank order, and the
  // rank cursor continues that same order. A source_trader_id tie-break here
  // disagrees with the writer and can permanently skip a tied row at a page
  // boundary. Non-default metric sorts use rank as their final stable key too.
  query = query.order('rank', { ascending: true, nullsFirst: false })

  // Fetch one lookahead row. `hasMore` is derived only from this same view
  // cohort; the old count cache is deliberately not a total authority.
  // The platform-diversity cap was REMOVED (owner decision 2026-07-11): capping
  // per-platform is incompatible with offset pagination (it broke the raw↔display
  // bijection → duplicate/skipped traders on page ≥ 1), and suppressing
  // legitimately top-ranked traders to balance platforms undercuts Arena's
  // neutral-ranking pitch. The board now shows true Arena-Score order.
  const fetchLimit = limit + 1
  if (useLegacyPaging) {
    const startIdx = page * limit
    // PostgREST range endpoints are inclusive, so this returns limit + 1.
    query = query.range(startIdx, startIdx + fetchLimit - 1)
  } else {
    query = query.limit(fetchLimit)
  }

  const { data, error } = await query

  if (error) {
    logger.error('public_ranked_leaderboard query error:', error)
    throw new Error(`public_ranked_leaderboard query failed: ${error.message}`)
  }

  return { scope: publicRankedCohortCacheScope(params), rows: data || [] }
}

async function buildPublicTradersResponse(
  supabase: ReturnType<typeof import('@/lib/supabase/server').getSupabaseAdmin>,
  params: TradersCacheKeyParams,
  cohort: SanitizedPublicRankedCohort
): Promise<PublicTradersListResponse> {
  const { timeRange, exchangeFilter, categoryFilter, sortBy, order, limit, useLegacyPaging, page } =
    params
  const hasLookahead = cohort.rows.length > limit
  const rankedRows = cohort.rows.slice(0, limit)

  // There is no view-native, generation-bound count authority yet. Returning
  // a lower bound would be interpreted by existing consumers as an exact total.
  const totalCount = null
  const totalCountIsExact = false

  const categorySourceType =
    categoryFilter === 'onchain' ? 'web3' : categoryFilter === 'spot' ? 'spot' : 'futures'

  // Verified-data set (A1): traders with an active read-only API-key
  // authorization → ✓ Verified badge (vs scraped "Tracked"). Cached, O(1) lookup.
  const verifiedKeys = await getVerifiedTraderKeys(supabase)

  // Map to trader response format (compatible with existing frontend)
  const traders = rankedRows.map((row) => ({
    id: row.source_trader_id as string,
    handle: (row.handle as string) || null,
    roi: row.roi != null ? Number(row.roi) : null,
    pnl: row.pnl != null ? Number(row.pnl) : null,
    win_rate: row.win_rate != null ? Number(row.win_rate) : null,
    max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
    trades_count: row.trades_count != null ? Number(row.trades_count) : null,
    followers: row.followers != null ? Number(row.followers) : null,
    copiers: row.copiers != null ? Number(row.copiers) : null,
    source: row.source as string,
    source_type: row.source_type as string,
    avatar_url: row.avatar_url as string | null,
    arena_score: row.arena_score != null ? Number(row.arena_score) : null,
    rank: Number(row.rank),
    // Rank-movement signals — RankDisplay's ↑/↓ arrows + NEW badge were wired
    // in the UI all along but this endpoint never selected the columns, so the
    // homepage/leaderboard (which fetch /api/traders) never showed them.
    rank_change: row.rank_change != null ? Number(row.rank_change) : null,
    is_new: row.is_new === true,
    // Score breakdown
    profitability_score: row.profitability_score != null ? Number(row.profitability_score) : null,
    risk_control_score: row.risk_control_score != null ? Number(row.risk_control_score) : null,
    execution_score: row.execution_score != null ? Number(row.execution_score) : null,
    score_completeness: (row.score_completeness as string) || null,
    // Trading style
    trading_style: (row.trading_style as string) || null,
    avg_holding_hours: row.avg_holding_hours != null ? Number(row.avg_holding_hours) : null,
    style_confidence: row.style_confidence != null ? Number(row.style_confidence) : null,
    // Risk metrics
    sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
    sortino_ratio: row.sortino_ratio != null ? Number(row.sortino_ratio) : null,
    profit_factor: row.profit_factor != null ? Number(row.profit_factor) : null,
    calmar_ratio: row.calmar_ratio != null ? Number(row.calmar_ratio) : null,
    // Bot classification
    is_bot:
      row.source === 'web3_bot' || row.trader_type === 'bot' || row.trader_type === 'suspected_bot',
    trader_type: (row.trader_type as string) || (row.source === 'web3_bot' ? 'bot' : null),
    is_outlier: row.is_outlier === true,
    computed_at: (row.computed_at as string) || null,
    // Trust-facing anti-gaming flags — derived at read time from serving-row
    // fields (no pipeline/migration change). Empty [] for the ~97% of rows
    // with plausible metrics.
    anti_gaming_flags: computeAntiGamingFlags({
      winRate: row.win_rate != null ? Number(row.win_rate) : null,
      tradesCount: row.trades_count != null ? Number(row.trades_count) : null,
    }),
    // A1: data-authenticity — true when this trader connected a read-only API
    // key (active authorization) → their numbers are API-verified, not scraped.
    is_verified_data: verifiedKeys.has(
      verifiedTraderKey(row.source as string, row.source_trader_id as string)
    ),
  }))

  // Deduplicate 0x addresses (case-insensitive) — VPS imports may write checksum-case
  const seen = new Set<string>()
  let dedupedTraders = traders.filter((t: { id: string; source: string }) => {
    const key = (t.id.startsWith('0x') ? t.id.toLowerCase() : t.id) + '|' + t.source
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const deduplicatedPage = dedupedTraders.length !== traders.length

  // A removed proof row or duplicate can invalidate the cursor boundary. A
  // smaller truthful page is preferable to a continuation that can skip rows.
  const hasMore = hasLookahead && !cohort.integrityCompromised && !deduplicatedPage

  // Without a matching view-native source census, this is intentionally the
  // visible page's source list rather than a stale count-cache approximation.
  // (Avatar mirrors / claimed badges below never change row membership or
  // sources, so this can be computed before those enrichments.)
  const availableSources = filterPublicRankingSources(dedupedTraders.map((trader) => trader.source))

  const relevantSources = exchangeFilter
    ? [exchangeFilter]
    : categoryFilter
      ? availableSources.filter(
          (source) => (SOURCE_TYPE_MAP[source] || 'futures') === categorySourceType
        )
      : availableSources

  // Three independent per-request reads, issued concurrently:
  //  - avatar mirrors: prefer our own CDN mirror over the exchange-CDN proxy
  //    (no 429 cold-burst). Fail-open; per-trader in-process TTL cache, so
  //    only uncached traders hit the RPC.
  //  - claimed (verified_traders) badges (P3-P3, 2026-07-09): tiny table,
  //    in-process 60s TTL cache. Fail-open — an error just means no badges.
  //  - source freshness watermarks: deliberately NOT cached — they are the
  //    per-request serving lease that gates stale rows below.
  const [mirroredTraders, claimedKeys, freshnessResult] = await Promise.all([
    attachAvatarMirrors(supabase, dedupedTraders),
    getClaimedTraderBadgeKeys(supabase),
    supabase
      .from('leaderboard_source_freshness')
      .select('source,source_as_of')
      .eq('season_id', timeRange),
  ])
  dedupedTraders =
    claimedKeys.size > 0
      ? mirroredTraders.map((t) =>
          claimedKeys.has(claimedTraderBadgeKey(t.source, t.id)) ? { ...t, is_verified: true } : t
        )
      : mirroredTraders

  const lastTrader = dedupedTraders[dedupedTraders.length - 1]
  const nextCursor =
    hasMore && sortBy === 'arena_score' && order === 'desc' && lastTrader ? lastTrader.rank : null

  const { data: sourceWatermarks, error: freshnessError } = freshnessResult
  if (freshnessError) {
    // Fail closed below (missing watermarks → stale); log so drift is visible.
    logger.error('leaderboard_source_freshness query error:', freshnessError)
  }
  const freshnessSummary = summarizeSourceFreshness(
    (sourceWatermarks || []) as SourceFreshnessRow[],
    relevantSources
  )
  const freshnessBySource = sourceFreshnessStatusMap(freshnessSummary)
  const dataAgeMinutes =
    freshnessSummary.ageSeconds == null ? null : Math.round(freshnessSummary.ageSeconds / 60)

  // Redis retains raw view rows for five minutes, while source watermarks can
  // lose their serving lease between the view read and a cache hit. A stale or
  // missing upstream watermark is not a display-only warning: returning its
  // row would reintroduce an untrusted trader into the ranking surface.
  if (dedupedTraders.length > 0 && freshnessSummary.isStale) {
    return {
      traders: [],
      timeRange,
      totalCount,
      totalCountIsExact,
      rankingMode: sortBy,
      lastUpdated: freshnessSummary.asOf,
      isStale: true,
      dataAgeMinutes,
      source_freshness: freshnessSummary.sources,
      nextCursor: null,
      hasMore: false,
      page: useLegacyPaging ? page : undefined,
      limit,
      availableSources: [],
      ranking_visibility: 'partial' as const,
      ranking_visibility_reason: 'source_freshness_unverified' as const,
      ranking_visibility_reasons: ['source_freshness_unverified'] as const,
    }
  }

  // Apply profanity filter to all handles before returning
  const sanitizedTraders = dedupedTraders.map((t) => ({
    ...t,
    handle: sanitizeDisplayName(t.handle),
    updated_at: freshnessBySource.get(String(t.source))?.updated_at ?? null,
    is_stale: freshnessBySource.get(String(t.source))?.is_stale ?? true,
  }))

  return {
    traders: sanitizedTraders,
    timeRange,
    totalCount,
    totalCountIsExact,
    // This echoes the actual view column used for ordering. `rank` remains the
    // deterministic tie-break, but it must never be presented as an Arena
    // Score sort when the caller requested a different published metric.
    rankingMode: sortBy,
    lastUpdated: freshnessSummary.asOf,
    isStale: freshnessSummary.isStale,
    dataAgeMinutes,
    source_freshness: freshnessSummary.sources,
    // Cursor-based pagination
    nextCursor,
    hasMore,
    // Legacy compat
    page: useLegacyPaging ? page : undefined,
    limit,
    availableSources,
    ...(cohort.integrityCompromised
      ? {
          ranking_visibility: 'partial',
          ranking_visibility_reason: 'publication_policy_filtered',
          ranking_visibility_reasons: ['ineligible_cached_cohort_row_removed'],
        }
      : {}),
  }
}
