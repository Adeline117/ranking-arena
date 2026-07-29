/**
 * GET /api/rankings
 *
 * Returns ranked traders for a given window, with optional platform/category filters.
 * Reads from leaderboard_ranks (pre-computed by compute-leaderboard cron).
 *
 * Query params:
 *   window: '7d' | '30d' | '90d' (required)
 *   category: 'futures' | 'spot' | 'onchain' (optional)
 *   platform: Platform string (optional, overrides category)
 *   limit: number (default 100, max 500)
 *   offset: number (default 0) — the supported pagination mechanism
 *   cursor: RESERVED / not implemented. Keyset pagination was documented but never
 *     wired (the fallback ignores it → passing cursor alone silently re-returns
 *     page 0). Use offset. Do not advertise cursor to API consumers until keyset
 *     is actually implemented over (arena_score, source_trader_id).
 *   sort_by: 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers' | 'win_rate' | 'sharpe_ratio' | 'trades_count'
 *   sort_dir: 'asc' | 'desc'
 *   min_pnl: number (optional)
 *   min_trades: number (optional)
 *
 * Response:
 *   { data:[], meta: { window, category, platform, totalcount, ... } }
 *
 * Caching: s-maxage=60, stale-while-revalidate=300
 */

import type {
  RankingWindow,
  TradingCategory,
  GranularPlatform,
  Platform,
  RankingsQuery,
} from '@/lib/types/leaderboard'
import { PLATFORM_CATEGORY } from '@/lib/types/leaderboard'
import type { TradingPeriod } from '@/lib/types/unified-trader'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { success as apiSuccess, withCache } from '@/lib/api/response'
import { withPublic } from '@/lib/api/middleware'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'
import { createLogger } from '@/lib/utils/logger'
import { sourceFreshnessStatusMap } from '@/lib/rankings/source-freshness'
import {
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  filterPublicRankingSources,
  isPublicRankingSourceQuarantined,
  publicRankingCacheKey,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'
import {
  PUBLIC_ACTIVE_RANKING_SOURCES,
  parsePublicActiveRankingSource,
} from '@/lib/constants/exchanges'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import type { SealedLeaderboardPublicationProofSet } from '@/lib/rankings/read-publication-proofs'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'
import {
  parseSealedCompositeCacheEntry,
  type SealedCompositePublications,
} from '@/lib/rankings/sealed-composite-cache'

const logger = createLogger('rankings-api')

function rankingProofSources(rankingsQuery: RankingsQuery): string[] {
  if (rankingsQuery.platform) return [rankingsQuery.platform]

  return filterPublicRankingSources(
    rankingsQuery.category
      ? PUBLIC_ACTIVE_RANKING_SOURCES.filter(
          (source) => PLATFORM_CATEGORY[source] === rankingsQuery.category
        )
      : PUBLIC_ACTIVE_RANKING_SOURCES
  )
}

const VALID_WINDOWS: (RankingWindow | 'composite')[] = ['7d', '30d', '90d', 'composite']
const VALID_CATEGORIES: TradingCategory[] = ['futures', 'spot', 'onchain']
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

// Data quality: ROI values above this threshold are considered anomalous
const ROI_ANOMALY_THRESHOLD = 50000 // 50000% = 500x — only filter extreme data errors, not legitimate high performers
const COMPOSITE_CACHE_VERSION = 'v3'

interface CompositeRankingPayload {
  readonly traders: readonly Record<string, unknown>[]
  readonly window: 'COMPOSITE'
  readonly totalCount: number
  readonly totalcount: number
  readonly total_count: number
  readonly as_of: string | null
  readonly is_stale: boolean
  readonly source_freshness: readonly unknown[]
  readonly availableSources: readonly string[]
  readonly next_cursor: null
  readonly precomputed: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseCompositeRankingPayload(
  value: unknown,
  publications: SealedCompositePublications
): CompositeRankingPayload | null {
  if (!isRecord(value) || value.window !== 'COMPOSITE' || value.precomputed !== true) return null
  if (
    !Array.isArray(value.traders) ||
    !Array.isArray(value.availableSources) ||
    !Array.isArray(value.source_freshness) ||
    typeof value.is_stale !== 'boolean' ||
    (value.as_of !== null &&
      (typeof value.as_of !== 'string' || !Number.isFinite(Date.parse(value.as_of))))
  ) {
    return null
  }

  const provedSources = new Set(
    Object.values(publications).flatMap((publication) =>
      publication.proofs.map((proof) => proof.source)
    )
  )
  const availableSources: string[] = []
  for (const source of value.availableSources) {
    if (
      typeof source !== 'string' ||
      !provedSources.has(source) ||
      availableSources.includes(source)
    ) {
      return null
    }
    availableSources.push(source)
  }

  const traders: Record<string, unknown>[] = []
  const identities = new Set<string>()
  let priorScore = Number.POSITIVE_INFINITY
  for (const [index, trader] of value.traders.entries()) {
    if (!isRecord(trader)) return null
    const platform = trader.platform
    const traderKey = trader.trader_key
    const arenaScore = trader.arena_score
    const rank = trader.rank
    if (
      typeof platform !== 'string' ||
      !provedSources.has(platform) ||
      !availableSources.includes(platform) ||
      typeof traderKey !== 'string' ||
      traderKey.length === 0 ||
      typeof arenaScore !== 'number' ||
      !Number.isFinite(arenaScore) ||
      arenaScore < 0 ||
      arenaScore > 100 ||
      !Number.isSafeInteger(rank) ||
      rank !== index + 1 ||
      arenaScore > priorScore
    ) {
      return null
    }
    for (const key of [
      'roi',
      'pnl',
      'win_rate',
      'max_drawdown',
      'sharpe_ratio',
      'sortino_ratio',
      'trades_count',
      'followers',
      'copiers',
      'profitability_score',
      'risk_control_score',
      'execution_score',
      'avg_holding_hours',
    ] as const) {
      const metric = trader[key]
      if (metric !== null && metric !== undefined) {
        if (typeof metric !== 'number' || !Number.isFinite(metric)) return null
        if (
          (key === 'trades_count' || key === 'followers' || key === 'copiers') &&
          (!Number.isSafeInteger(metric) || metric < 0)
        ) {
          return null
        }
      }
    }
    const identity = `${platform}:${traderKey}`
    if (identities.has(identity)) return null
    identities.add(identity)
    priorScore = arenaScore
    traders.push({ ...trader })
  }

  const freshnessSources = new Set<string>()
  for (const freshness of value.source_freshness) {
    if (!isRecord(freshness)) return null
    const source = freshness.source
    const updatedAt = freshness.updated_at
    const ageSeconds = freshness.age_seconds
    if (
      typeof source !== 'string' ||
      !availableSources.includes(source) ||
      freshnessSources.has(source) ||
      typeof freshness.is_stale !== 'boolean' ||
      (updatedAt !== null &&
        (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)))) ||
      (ageSeconds !== null && (!Number.isSafeInteger(ageSeconds) || (ageSeconds as number) < 0))
    ) {
      return null
    }
    freshnessSources.add(source)
  }
  if (
    freshnessSources.size !== availableSources.length ||
    availableSources.some((source) => !freshnessSources.has(source))
  ) {
    return null
  }

  const countFields = [value.totalCount, value.totalcount, value.total_count]
  if (
    countFields.some(
      (count) => !Number.isSafeInteger(count) || (count as number) !== traders.length
    )
  ) {
    return null
  }

  return {
    traders,
    window: 'COMPOSITE',
    totalCount: traders.length,
    totalcount: traders.length,
    total_count: traders.length,
    as_of: value.as_of,
    is_stale: value.is_stale,
    source_freshness: value.source_freshness,
    availableSources,
    next_cursor: null,
    precomputed: true,
  }
}

function nullableSortValue(row: Record<string, unknown>, sortBy: (typeof VALID_SORT_BY)[number]) {
  const key = sortBy === 'drawdown' ? 'max_drawdown' : sortBy
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function compareCompositeRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  sortBy: (typeof VALID_SORT_BY)[number],
  sortDir: 'asc' | 'desc'
): number {
  const leftValue = nullableSortValue(left, sortBy)
  const rightValue = nullableSortValue(right, sortBy)
  if (leftValue === null && rightValue !== null) return 1
  if (leftValue !== null && rightValue === null) return -1
  if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
    return sortDir === 'asc' ? leftValue - rightValue : rightValue - leftValue
  }
  return (
    Number(left.rank ?? Number.MAX_SAFE_INTEGER) - Number(right.rank ?? Number.MAX_SAFE_INTEGER) ||
    String(left.platform).localeCompare(String(right.platform)) ||
    String(left.trader_key).localeCompare(String(right.trader_key))
  )
}

async function readCompositeRankings(input: {
  category: TradingCategory | null
  platform: string | null
  sortBy: (typeof VALID_SORT_BY)[number]
  sortDir: 'asc' | 'desc'
  limit: number
  offset: number
  minPnl: number | undefined
  minTrades: number | undefined
  traderType: 'human' | 'bot' | null
}): Promise<CompositeRankingPayload> {
  const scope = input.platform ? `platform:${input.platform}` : input.category || 'all'
  const cacheKey = publicRankingCacheKey(
    `precomputed:composite:${scope}:${COMPOSITE_CACHE_VERSION}`
  )
  const entry = parseSealedCompositeCacheEntry<unknown>(
    (await tieredGet<unknown>(cacheKey, 'hot')).data
  )
  const payload = entry ? parseCompositeRankingPayload(entry.value, entry.publications) : null
  if (!payload) {
    throw new ApiError('Composite rankings are temporarily unavailable', {
      code: ErrorCode.SERVICE_UNAVAILABLE,
    })
  }

  const cacheScopeMatches = payload.traders.every((trader) => {
    const source = String(trader.platform)
    if (input.platform) return source === input.platform
    if (input.category) {
      return (PLATFORM_CATEGORY[source as GranularPlatform] || 'futures') === input.category
    }
    return true
  })
  const metadataScopeMatches = payload.availableSources.every((source) => {
    if (input.platform) return source === input.platform
    if (input.category) {
      return (PLATFORM_CATEGORY[source as GranularPlatform] || 'futures') === input.category
    }
    return true
  })
  if (!cacheScopeMatches || !metadataScopeMatches) {
    throw new ApiError('Composite ranking cache scope is invalid', {
      code: ErrorCode.SERVICE_UNAVAILABLE,
    })
  }

  const filtered = payload.traders.filter((trader) => {
    if (
      input.minPnl !== undefined &&
      (typeof trader.pnl !== 'number' || trader.pnl < input.minPnl)
    ) {
      return false
    }
    if (
      input.minTrades !== undefined &&
      (typeof trader.trades_count !== 'number' || trader.trades_count < input.minTrades)
    ) {
      return false
    }
    if (input.traderType === 'bot') {
      return (
        trader.is_bot === true ||
        trader.trader_type === 'bot' ||
        trader.trader_type === 'suspected_bot'
      )
    }
    if (input.traderType === 'human') {
      return (
        trader.is_bot !== true &&
        trader.trader_type !== 'bot' &&
        trader.trader_type !== 'suspected_bot'
      )
    }
    return true
  })
  filtered.sort((left, right) => compareCompositeRows(left, right, input.sortBy, input.sortDir))
  const page = filtered.slice(input.offset, input.offset + input.limit).map((trader, index) => ({
    ...trader,
    rank: input.offset + index + 1,
  }))

  return {
    ...payload,
    traders: page,
    totalCount: filtered.length,
    totalcount: filtered.length,
    total_count: filtered.length,
  }
}

export const GET = withPublic(
  async ({ request }) => {
    const { searchParams } = new URL(request.url)

    // Parse & validate window (required)
    const window = searchParams.get('window') as RankingWindow | 'composite' | null
    const normalizedWindow = window?.toLowerCase() as RankingWindow | 'composite'
    if (!normalizedWindow || !VALID_WINDOWS.includes(normalizedWindow)) {
      throw ApiError.validation(
        'Invalid or missing window parameter. Must be one of: 7d, 30d, 90d, composite'
      )
    }

    // Parse optional params
    const category = searchParams.get('category') as TradingCategory | null
    if (category && !VALID_CATEGORIES.includes(category)) {
      throw ApiError.validation('Invalid category. Must be one of: futures, spot, onchain')
    }

    const requestedPlatform = searchParams.get('platform')
    const platform = requestedPlatform ? parsePublicActiveRankingSource(requestedPlatform) : null
    if (requestedPlatform && !platform) {
      throw ApiError.validation(`Invalid platform: ${requestedPlatform}`)
    }

    const sortBy = (searchParams.get('sort_by') || 'arena_score') as (typeof VALID_SORT_BY)[number]
    if (!VALID_SORT_BY.includes(sortBy)) {
      throw ApiError.validation(`Invalid sort_by. Must be one of: ${VALID_SORT_BY.join(', ')}`)
    }

    const requestedSortDir = searchParams.get('sort_dir') || 'desc'
    if (requestedSortDir !== 'asc' && requestedSortDir !== 'desc') {
      throw ApiError.validation('Invalid sort_dir. Must be one of: asc, desc')
    }
    const sortDir = requestedSortDir

    const limit = parseLimit(searchParams.get('limit'), 100, 500)
    const offset = parseOffset(searchParams.get('offset'))
    const cursor = searchParams.get('cursor') || undefined // format: "score:id" for keyset pagination
    if (cursor) {
      throw ApiError.validation('cursor pagination is not implemented; use offset')
    }
    const requestedMinPnl = searchParams.get('min_pnl')
    const minPnl = requestedMinPnl === null ? undefined : Number(requestedMinPnl)
    if (minPnl !== undefined && !Number.isFinite(minPnl)) {
      throw ApiError.validation('Invalid min_pnl. Must be a finite number')
    }
    const requestedMinTrades = searchParams.get('min_trades')
    const minTrades = requestedMinTrades === null ? undefined : Number(requestedMinTrades)
    if (minTrades !== undefined && (!Number.isSafeInteger(minTrades) || minTrades < 0)) {
      throw ApiError.validation('Invalid min_trades. Must be a non-negative integer')
    }
    const requestedTraderType = searchParams.get('trader_type')
    if (
      requestedTraderType !== null &&
      requestedTraderType !== 'human' &&
      requestedTraderType !== 'bot'
    ) {
      throw ApiError.validation('Invalid trader_type. Must be one of: human, bot')
    }
    const traderType = requestedTraderType

    if (isPublicRankingSourceQuarantined(platform)) {
      return withCache(
        apiSuccess({
          traders: [],
          window: normalizedWindow === 'composite' ? 'COMPOSITE' : normalizedWindow.toUpperCase(),
          totalCount: 0,
          totalcount: 0,
          total_count: 0,
          as_of: null,
          is_stale: true,
          source_freshness: [],
          availableSources: [],
          next_cursor: null,
          ranking_visibility: 'partial',
          ranking_visibility_reason: 'publication_policy_filtered',
          ranking_visibility_reasons: ['quarantined_source_requested'],
        }),
        { maxAge: 60, staleWhileRevalidate: 300 }
      )
    }

    if (normalizedWindow === 'composite') {
      const composite = await readCompositeRankings({
        category,
        platform,
        sortBy,
        sortDir,
        limit,
        offset,
        minPnl,
        minTrades,
        traderType,
      })
      return withCache(apiSuccess(sanitizePublicRankingSourcePayload(composite)), {
        maxAge: 60,
        staleWhileRevalidate: 300,
      })
    }

    // Only cache "hot" default queries (no filters, default sort, first page)
    // Filtered/paginated queries skip cache to avoid key explosion (thousands of permutations)
    const isDefaultQuery =
      sortBy === 'arena_score' &&
      sortDir === 'desc' &&
      !platform &&
      minPnl === undefined &&
      minTrades === undefined &&
      !traderType &&
      !cursor &&
      offset === 0
    const cacheKey = isDefaultQuery
      ? publicRankingCacheKey(
          `api:rankings:sealed-v4:${normalizedWindow}:${category || 'all'}:${limit}`
        )
      : null // skip cache for filtered queries

    const query: RankingsQuery = {
      window: normalizedWindow,
      category: category || undefined,
      platform: (platform || undefined) as Platform | undefined,
      limit,
      offset,
      sort_by: sortBy,
      sort_dir: sortDir,
      min_pnl: minPnl,
      min_trades: minTrades,
      trader_type: traderType || undefined,
    }
    const cacheSeason = query.window.toUpperCase() as TradingPeriod
    const expectedCacheSources = rankingProofSources(query)
    let result: unknown

    try {
      const cachedEntry = cacheKey
        ? parseSealedRankingCacheEntry<unknown>(
            (await tieredGet<unknown>(cacheKey, 'hot')).data,
            cacheSeason,
            expectedCacheSources
          )
        : null

      if (cachedEntry) {
        result = cachedEntry.value
      } else {
        const sealedRead = await getRankingsFallback(query, cursor)
        const safeValue = sanitizePublicRankingSourcePayload(sealedRead.value)
        const safeRead = { ...sealedRead, value: safeValue }
        if (cacheKey) {
          await tieredSet(cacheKey, createSealedRankingCacheEntry(safeRead), 'hot', ['rankings'])
        }
        result = safeValue
      }
    } catch (fetchError) {
      // DB query failed — try to serve last-known-good cached data instead of returning 500.
      // Only attempt fallback for default (cacheable) queries; filtered queries have no cache.
      if (cacheKey) {
        const staleEntry = parseSealedRankingCacheEntry<Record<string, unknown>>(
          (await tieredGet<unknown>(cacheKey, 'hot')).data,
          cacheSeason,
          expectedCacheSources
        )
        if (staleEntry) {
          logger.warn(
            `Rankings DB query failed, serving stale cache for ${cacheKey}:`,
            fetchError instanceof Error ? fetchError.message : String(fetchError)
          )
          result = {
            ...staleEntry.value,
            is_stale: true,
            stale_reason: 'db_fallback',
          }
        } else {
          // No cache either — re-throw to let the error handler respond
          throw fetchError
        }
      } else {
        throw fetchError
      }
    }

    result = sanitizePublicRankingSourcePayload(result)
    const response = apiSuccess(result)
    return withCache(response, { maxAge: 60, staleWhileRevalidate: 300 })
  },
  { name: 'rankings', rateLimit: { requests: 30, window: 60, prefix: 'rankings' } }
)

/**
 * Fetch rankings via unified data layer (leaderboard_ranks).
 * Returns the same response shape as the legacy getRankingsFallback.
 */
async function getRankingsFallback(rankingsQuery: RankingsQuery, cursor?: string) {
  const { getReadReplica } = await import('@/lib/supabase/read-replica')
  const supabase = getReadReplica()
  const season = rankingsQuery.window.toUpperCase() as TradingPeriod
  const proofSources = rankingProofSources(rankingsQuery)

  return readSealedRankingGeneration(
    supabase,
    { season, sources: proofSources },
    (publication) => getRankingsFallbackForCohort(rankingsQuery, cursor, supabase, publication),
    { timeoutMs: 10_000 }
  )
}

async function getRankingsFallbackForCohort(
  rankingsQuery: RankingsQuery,
  _cursor: string | undefined,
  supabase: ReturnType<typeof import('@/lib/supabase/read-replica').getReadReplica>,
  publication: SealedLeaderboardPublicationProofSet
) {
  const {
    window,
    category,
    platform,
    limit = 100,
    offset = 0,
    sort_by = 'arena_score',
    sort_dir = 'desc',
    min_pnl,
    min_trades,
    trader_type,
  } = rankingsQuery

  // Cap at 1000: limit=5000 triggers 5 parallel chunk queries on a 314k-row
  // table under the CHUNK_SIZE pagination logic, saturating the Supabase
  // connection pool with little user benefit. Nobody actually needs 5000
  // traders in one request — pagination is already cursor-friendly.
  const safeLimit = Math.min(limit, 1000)
  const seasonId = window.toUpperCase() as TradingPeriod

  // Map sort_by to unified sortBy parameter
  const sortByMap: Record<string, string> = {
    arena_score: 'arena_score',
    roi: 'roi',
    pnl: 'pnl',
    drawdown: 'max_drawdown',
    copiers: 'copiers',
    win_rate: 'win_rate',
    sharpe_ratio: 'sharpe_ratio',
    trades_count: 'trades_count',
  }
  const unifiedSortBy = sortByMap[sort_by] || 'arena_score'

  // Determine platform filter based on category
  const platformFilter: string | undefined = platform || undefined
  let platformsInCategory: string[] | undefined
  if (!platformFilter && category) {
    platformsInCategory = filterPublicRankingSources(
      Object.entries(PLATFORM_CATEGORY)
        .filter(([, cat]) => cat === category)
        .map(([p]) => p)
    )
  }

  // Sorting
  const sortColumn = unifiedSortBy === 'rank' ? 'rank' : unifiedSortBy
  const ascending = sort_dir === 'asc'

  // Helper: build base query with all filters applied (reusable for chunked fetches)
  const SELECT_COLS = `source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown,
       trades_count, followers, copiers, arena_score, avatar_url, rank, rank_change, is_new, computed_at,
       profitability_score, risk_control_score, execution_score, score_completeness,
       trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, calmar_ratio, profit_factor, trader_type, is_outlier, metrics_estimated`

  function buildBaseQuery(opts?: { count?: 'exact' | 'planned' | 'estimated' }) {
    let q = supabase
      .from('leaderboard_ranks')
      .select(SELECT_COLS, opts ? { count: opts.count } : undefined)
      .eq('season_id', seasonId)
      .filter('rank_publication_id', 'eq', publication.scoreCohortId)
      // >0 (not just non-null): excluded/zeroed traders are set to arena_score=0
      // by zeroOutExcluded; live board + Redis sync already use >0, so align the
      // main board's tail & counts with them (was .not(null) → leaked 0-score rows).
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .lte('roi', ROI_ANOMALY_THRESHOLD)
      .gte('roi', -ROI_ANOMALY_THRESHOLD)

    if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
      q = q.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
    }

    if (platformFilter) {
      q = q.eq('source', platformFilter)
    } else if (platformsInCategory && platformsInCategory.length > 0) {
      q = q.in('source', platformsInCategory)
    } else {
      q = q.in('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])
    }

    if (min_pnl != null) {
      q = q.gte('pnl', min_pnl)
    }
    if (min_trades != null) {
      q = q.gte('trades_count', min_trades)
    }

    // Filter by trader type (human/bot/suspected_bot)
    if (trader_type === 'bot') {
      q = q.or('trader_type.eq.bot,trader_type.eq.suspected_bot,source.eq.web3_bot')
    } else if (trader_type === 'human') {
      q = q.neq('source', 'web3_bot').or('trader_type.is.null,trader_type.eq.human')
    }

    q = q.order(sortColumn, { ascending, nullsFirst: false })
    // Deterministic tiebreak: ~1800 rows share an arena_score. Without a secondary
    // key, offset pagination + parallel chunked fetches can duplicate/drop a tied
    // row at a page/chunk boundary and ranks jump on refresh (Postgres gives no
    // stable order among equal keys).
    q = q.order('source_trader_id', { ascending: true })
    return q
  }

  // Supabase PostgREST has a max_rows limit (typically 1000) per request.
  // Paginate in 1000-row chunks when safeLimit > 1000 to get complete data.
  const CHUNK_SIZE = 1000
  let rows: Record<string, unknown>[] = []
  let totalCount: number | null = null
  let error: { message: string } | null = null

  if (safeLimit <= CHUNK_SIZE) {
    // A generic count cache can be from a different publication generation.
    // The sealed proof set below is the only generation-bound count authority.
    const result = await buildBaseQuery().range(offset, offset + safeLimit - 1)
    rows = (result.data || []) as Record<string, unknown>[]
    error = result.error
  } else {
    // Chunked fetch: first chunk, no count
    const firstResult = await buildBaseQuery().range(offset, offset + CHUNK_SIZE - 1)
    if (firstResult.error) {
      error = firstResult.error
    } else {
      rows = (firstResult.data || []) as Record<string, unknown>[]
      totalCount = null // Will be set after all chunks

      // Calculate remaining chunks needed
      const remaining = safeLimit - CHUNK_SIZE
      if (remaining > 0 && rows.length === CHUNK_SIZE) {
        const chunkCount = Math.ceil(remaining / CHUNK_SIZE)
        const chunkPromises = Array.from({ length: chunkCount }, (_, i) => {
          const chunkOffset = offset + CHUNK_SIZE * (i + 1)
          const chunkEnd = Math.min(chunkOffset + CHUNK_SIZE - 1, offset + safeLimit - 1)
          return buildBaseQuery().range(chunkOffset, chunkEnd)
        })
        const chunkResults = await Promise.all(chunkPromises)
        for (const cr of chunkResults) {
          if (cr.error) {
            error = cr.error
            break
          }
          if (cr.data) rows = rows.concat(cr.data as Record<string, unknown>[])
        }
      }
    }
  }

  if (error) {
    throw new Error(`Leaderboard query failed: ${error.message}`)
  }

  const hasResultFilters = min_pnl != null || min_trades != null || trader_type != null
  totalCount = hasResultFilters
    ? offset + rows.length + (rows.length === safeLimit ? 1 : 0)
    : publication.proofs.reduce((sum, proof) => sum + proof.published_rank_count, 0)

  // Deduplicate by source:source_trader_id (case-insensitive for 0x addresses)
  const seenRowKeys = new Set<string>()
  const paginatedRows = (rows || []).filter((r: Record<string, unknown>) => {
    const tid = String(r.source_trader_id || '')
    const normalizedTid = tid.startsWith('0x') ? tid.toLowerCase() : tid
    const key = `${r.source}:${normalizedTid}`
    if (seenRowKeys.has(key)) return false
    seenRowKeys.add(key)
    return true
  })

  // Source membership and watermarks must come from the exact proof generation
  // that authorized these rows. Generic freshness/count tables can cross a
  // publication cutover and describe a different leaderboard.
  const availableSources = publication.proofs
    .filter((proof) => proof.published_rank_count > 0)
    .map((proof) => proof.source)
  const nowMs = Date.now()
  const sourceFreshness = publication.proofs
    .filter((proof) => proof.published_rank_count > 0)
    .map((proof) => {
      const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(proof.source_as_of)) / 1000))
      return {
        source: proof.source,
        updated_at: proof.source_as_of,
        is_stale: false,
        age_seconds: ageSeconds,
      }
    })
  const asOf =
    sourceFreshness.length > 0
      ? sourceFreshness.reduce(
          (oldest, status) => (status.updated_at < oldest ? status.updated_at : oldest),
          sourceFreshness[0].updated_at
        )
      : null
  const freshnessSummary = {
    asOf,
    isStale: false,
    ageSeconds:
      sourceFreshness.length > 0
        ? Math.max(...sourceFreshness.map((status) => status.age_seconds))
        : null,
    sources: sourceFreshness,
  }
  const freshnessBySource = sourceFreshnessStatusMap(freshnessSummary)

  // Transform to response format
  const PLACEHOLDER_NAMES = new Set([
    'Enter Name',
    'enter name',
    'Unknown',
    'null',
    'undefined',
    '',
  ])
  // Truncate raw wallet addresses (0x hex or bare base58 Solana/Tron) so they
  // don't overflow the name cell on mobile. Returns null if not address-like.
  const truncAddr = (s: string): string | null => {
    if (s.startsWith('0x') && s.length >= 10) return `${s.slice(0, 6)}...${s.slice(-4)}`
    if (/^[1-9A-HJ-NP-Za-km-z]{30,50}$/.test(s)) return `${s.slice(0, 4)}...${s.slice(-4)}`
    return null
  }
  const formatDisplayName = (handle: string | null, traderId: string): string => {
    // A real handle may itself be a raw address (e.g. okx_web3_solana stores the
    // full base58 address as handle) — truncate those before returning.
    if (handle && !PLACEHOLDER_NAMES.has(handle)) return truncAddr(handle) ?? handle
    // Format 0x addresses as "0x1234...5678"
    if (traderId?.startsWith('0x') && traderId.length >= 10) {
      return `${traderId.slice(0, 6)}...${traderId.slice(-4)}`
    }
    // Copin format: "protocol:0xAddr" → show the address part
    if (traderId?.includes(':')) {
      const addr = traderId.split(':')[1]
      if (addr?.startsWith('0x') && addr.length >= 10)
        return `${addr.slice(0, 6)}...${addr.slice(-4)}`
    }
    return truncAddr(traderId) ?? traderId ?? 'Anonymous'
  }

  const traders = paginatedRows.map((row: Record<string, unknown>, idx: number) => {
    const traderId = row.source_trader_id as string
    // For copin aggregator: extract real platform from trader_key (e.g., "hyperliquid:0x..." → "hyperliquid")
    let displayPlatform = row.source as string
    let displayTraderKey = traderId
    if (displayPlatform === 'copin' && traderId?.includes(':')) {
      const [realPlatform, ...rest] = traderId.split(':')
      displayPlatform = realPlatform
      displayTraderKey = rest.join(':')
    }

    const roi = row.roi != null ? Number(row.roi) : null
    const pnl = row.pnl != null ? Number(row.pnl) : null
    const arenaScore = row.arena_score != null ? Number(row.arena_score) : null
    const sourceFreshness = freshnessBySource.get(String(row.source))

    return {
      platform: displayPlatform as Platform,
      trader_key: displayTraderKey,
      display_name: formatDisplayName(row.handle as string | null, displayTraderKey),
      avatar_url: (row.avatar_url as string) || null,
      // Top-level metrics for frontend compatibility
      roi,
      pnl,
      arena_score: arenaScore,
      win_rate: row.win_rate != null ? Number(row.win_rate) : null,
      max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
      sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
      trades_count: (row.trades_count as number) ?? null,
      followers: (row.followers as number) ?? null,
      copiers: row.copiers != null ? Number(row.copiers) : null,
      rank: (row.rank as number) ?? offset + idx + 1,
      rank_change: (row.rank_change as number) ?? null,
      is_new: (row.is_new as boolean) ?? false,
      // Nested `metrics: { ... }` duplicate removed — all fields are already
      // exposed at the top level and no consumer read from the nested shape
      // (verified by repo-wide grep for `\.metrics\.roi` etc. in app/ and
      // lib/hooks/ — only lib/connectors/* uses that shape internally).
      // Saved ~30-40% response payload size.
      quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 1.0 },
      // Compatibility name retained, but the value is now the source-data
      // watermark rather than Arena's score computation timestamp.
      updated_at: sourceFreshness?.updated_at ?? null,
      is_stale: sourceFreshness?.is_stale ?? true,
      computed_at: (row.computed_at as string) || null,
      profitability_score: row.profitability_score != null ? Number(row.profitability_score) : null,
      risk_control_score: row.risk_control_score != null ? Number(row.risk_control_score) : null,
      execution_score: row.execution_score != null ? Number(row.execution_score) : null,
      score_completeness: (row.score_completeness as string) || null,
      trading_style: (row.trading_style as string) || null,
      avg_holding_hours: row.avg_holding_hours != null ? Number(row.avg_holding_hours) : null,
      style_confidence: null,
      is_bot:
        row.source === 'web3_bot' ||
        row.trader_type === 'bot' ||
        row.trader_type === 'suspected_bot',
      trader_type: (row.trader_type as string) || (row.source === 'web3_bot' ? 'bot' : null),
    }
  })

  return {
    traders,
    window: seasonId as '7D' | '30D' | '90D' | 'COMPOSITE',
    // totalCount (camelCase) is what the frontend actually reads
    // (useTraderData.ts:275: `data.totalCount ?? totalCountRef.current`).
    // totalcount + total_count kept for backward compat with tests/older clients.
    totalCount: totalCount || 0,
    totalcount: totalCount || 0,
    total_count: totalCount || 0,
    as_of: freshnessSummary.asOf,
    is_stale: freshnessSummary.isStale,
    source_freshness: freshnessSummary.sources,
    availableSources,
    next_cursor: null,
  }
}
