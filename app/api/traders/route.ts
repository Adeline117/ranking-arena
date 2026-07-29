/**
 * 排行榜交易员数据 API (V2 — reads from pre-computed leaderboard_ranks)
 *
 * Supports:
 * - Cursor-based pagination: ?cursor=xxx&limit=50
 * - Exchange filter: ?exchange=binance_futures
 * - Sort: ?sortBy=arena_score|roi|win_rate|max_drawdown&order=desc|asc
 * - Time range: ?timeRange=7D|30D|90D
 * - Legacy page-based pagination still works: ?page=0&limit=500
 *
 * Performance: single indexed query on leaderboard_ranks + Redis cache.
 */

import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import { del, getOrSetWithLock } from '@/lib/cache'
import type { Period } from '@/lib/utils/arena-score'
import { safeParseInt } from '@/lib/utils/safe-parse'
import { createLogger } from '@/lib/utils/logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { computeAntiGamingFlags } from '@/lib/scoring/anti-gaming'
import { getVerifiedTraderKeys, verifiedTraderKey } from '@/lib/data/verified-traders'
import { validateTradersResponse } from '@/lib/api/traders-response-schema'
import { attachAvatarMirrors } from '@/lib/data/avatar-mirrors'
import { SOURCE_TYPE_MAP, parsePublicActiveRankingSource } from '@/lib/constants/exchanges'
import {
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  filterPublicRankingSources,
  isPublicRankingSourceQuarantined,
  publicRankingCacheKey,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import { readLeaderboardPublicationAuthority } from '@/lib/rankings/read-publication-authority'
import type { SealedLeaderboardPublicationProofSet } from '@/lib/rankings/read-publication-proofs'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

const logger = createLogger('traders-api')

export const runtime = 'nodejs'
export const preferredRegion = ['iad1', 'sfo1', 'hnd1']
export const dynamic = 'force-dynamic'

// ── Input validation schema ──────────────────────────────────────────────────
const tradersQuerySchema = z.object({
  timeRange: z
    .string()
    .toUpperCase()
    .pipe(z.enum(['7D', '30D', '90D']))
    .catch('90D'),
  exchange: z.string().optional(),
  category: z.enum(['futures', 'spot', 'onchain']).optional(),
  sortBy: z
    .enum(['arena_score', 'roi', 'pnl', 'win_rate', 'max_drawdown', 'sortino_ratio'])
    .catch('arena_score'),
  order: z.enum(['asc', 'desc']).catch('desc'),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).catch(50),
  page: z.coerce.number().int().min(0).optional(),
})

// Select only needed columns from leaderboard_ranks (avoid SELECT *)
const LEADERBOARD_COLUMNS =
  'source_trader_id, handle, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, source, source_type, avatar_url, arena_score, rank, rank_change, is_new, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, style_confidence, computed_at, season_id, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trader_type, is_outlier'

interface TradersRankingResponse {
  traders: unknown[]
  dataAgeMinutes: number | null
  isStale: boolean
  [key: string]: unknown
}

interface TradersQueryParams {
  timeRange: Period
  exchangeFilter: string | null
  categoryFilter: string | null
  sortBy: string
  order: 'asc' | 'desc'
  cursor: number | null
  limit: number
  useLegacyPaging: boolean
  page: number
}

function tradersProofSources(
  authoritySources: readonly string[],
  exchangeFilter: string | null,
  categoryFilter: string | null
): string[] {
  const publicAuthoritySources = filterPublicRankingSources(authoritySources)
  if (exchangeFilter) {
    return publicAuthoritySources.includes(exchangeFilter) ? [exchangeFilter] : []
  }

  return filterPublicRankingSources(
    categoryFilter
      ? publicAuthoritySources.filter((source) => {
          const sourceType = SOURCE_TYPE_MAP[source] || 'futures'
          return sourceType === (categoryFilter === 'onchain' ? 'web3' : categoryFilter)
        })
      : publicAuthoritySources
  )
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
    const canonicalExchange = exchangeFilter ? parsePublicActiveRankingSource(exchangeFilter) : null
    if (exchangeFilter && !canonicalExchange) {
      return badRequest('Invalid exchange')
    }
    const cursor = parsed.data.cursor != null ? String(parsed.data.cursor) : null
    const page = parsed.data.page ?? NaN
    const useLegacyPaging = !isNaN(page) && !cursor

    const effectiveSortBy = sortBy || 'arena_score'

    if (isPublicRankingSourceQuarantined(canonicalExchange)) {
      return NextResponse.json({
        traders: [],
        timeRange,
        totalCount: 0,
        rankingMode: 'arena_score',
        lastUpdated: null,
        isStale: true,
        dataAgeMinutes: null,
        source_freshness: [],
        nextCursor: null,
        hasMore: false,
        page: useLegacyPaging ? Math.max(0, page) : undefined,
        limit,
        availableSources: [],
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'publication_policy_filtered',
        ranking_visibility_reasons: ['quarantined_source_requested'],
      })
    }

    const authoritySources = await readLeaderboardPublicationAuthority(supabase, timeRange, {
      timeoutMs: 10_000,
    })
    const expectedSources = tradersProofSources(
      authoritySources,
      canonicalExchange,
      categoryFilter ?? null
    )
    if (expectedSources.length === 0) {
      return NextResponse.json({
        traders: [],
        timeRange,
        totalCount: 0,
        rankingMode: 'arena_score',
        lastUpdated: null,
        isStale: true,
        dataAgeMinutes: null,
        source_freshness: [],
        nextCursor: null,
        hasMore: false,
        page: useLegacyPaging ? Math.max(0, page) : undefined,
        limit,
        availableSources: [],
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'publication_authority_filtered',
        ranking_visibility_reasons: [
          canonicalExchange
            ? 'source_outside_publication_authority'
            : 'category_outside_publication_authority',
        ],
      })
    }

    const authorityFingerprint = createHash('sha256')
      .update(authoritySources.join('\u0000'))
      .digest('hex')
      .slice(0, 16)
    // Cache key
    const cacheKey = publicRankingCacheKey(
      `leaderboard:sealed-v5:${authorityFingerprint}:${timeRange}:${canonicalExchange || 'all'}:${categoryFilter || 'all'}:${effectiveSortBy}:${order}:${cursor || 'start'}:${limit}${useLegacyPaging ? `:p${page}` : ''}`
    )

    const fetchSealedEntry = async () => {
      const sealedRead = await fetchFromLeaderboard(
        supabase,
        {
          timeRange,
          exchangeFilter: canonicalExchange,
          categoryFilter: categoryFilter ?? null,
          sortBy: effectiveSortBy,
          order,
          cursor: cursor ? safeParseInt(cursor, 0) : null,
          limit,
          useLegacyPaging,
          page: useLegacyPaging ? Math.max(0, page) : 0,
        },
        expectedSources
      )
      const safeRead = {
        ...sealedRead,
        value: sanitizePublicRankingSourcePayload(sealedRead.value),
      }
      return createSealedRankingCacheEntry(safeRead)
    }

    const readAuthorizedCache = async () => {
      const cached = await getOrSetWithLock(cacheKey, fetchSealedEntry, { ttl: 300, lockTtl: 10 })
      const cacheEntry = parseSealedRankingCacheEntry<TradersRankingResponse>(
        cached,
        timeRange,
        expectedSources
      )
      if (!cacheEntry) return null

      const currentGeneration = await readSealedRankingGeneration(
        supabase,
        { season: timeRange, sources: expectedSources },
        async () => null,
        { timeoutMs: 10_000 }
      )
      const currentSources = tradersProofSources(
        currentGeneration.authoritySources,
        canonicalExchange,
        categoryFilter ?? null
      )
      const authorityUnchanged =
        currentSources.length === expectedSources.length &&
        currentSources.every((source, index) => source === expectedSources[index])
      return authorityUnchanged &&
        currentGeneration.publicationIdentity === cacheEntry.publicationIdentity
        ? cacheEntry
        : null
    }

    let cacheEntry = await readAuthorizedCache()
    if (!cacheEntry) {
      await del(cacheKey)
      cacheEntry = await readAuthorizedCache()
    }
    if (!cacheEntry) {
      throw new Error('traders ranking cache returned an unsealed value')
    }
    const cachedData = sanitizePublicRankingSourcePayload(cacheEntry.value)

    // Dev-only: validate output shape to catch response drift early (no-op in prod)
    validateTradersResponse(cachedData, logger)

    // Data is already sanitized before caching (in the fetcher below)
    const response = NextResponse.json(cachedData)
    response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
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

// Column mapping for sortBy
const SORT_COLUMN: Record<string, string> = {
  arena_score: 'arena_score',
  roi: 'roi',
  pnl: 'pnl',
  win_rate: 'win_rate',
  max_drawdown: 'max_drawdown',
  sortino_ratio: 'sortino_ratio',
  // NOTE: no `alpha` — leaderboard_ranks has no such column; ?sort=alpha used to
  // reach query.order('alpha') → PostgREST 42703 500 (audit 2026-07-03).
}

async function fetchFromLeaderboard(
  supabase: ReturnType<typeof import('@/lib/supabase/server').getSupabaseAdmin>,
  params: TradersQueryParams,
  expectedSources: readonly string[]
) {
  const sealedRead = await readSealedRankingGeneration(
    supabase,
    { season: params.timeRange, sources: expectedSources },
    (publication) => fetchFromLeaderboardCohort(supabase, params, publication),
    { timeoutMs: 10_000 }
  )
  const currentSources = tradersProofSources(
    sealedRead.authoritySources,
    params.exchangeFilter,
    params.categoryFilter
  )
  if (
    currentSources.length !== expectedSources.length ||
    currentSources.some((source, index) => source !== expectedSources[index])
  ) {
    throw new Error('traders ranking authority changed before the sealed read')
  }
  return sealedRead
}

async function fetchFromLeaderboardCohort(
  supabase: ReturnType<typeof import('@/lib/supabase/server').getSupabaseAdmin>,
  params: TradersQueryParams,
  publication: SealedLeaderboardPublicationProofSet
) {
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

  // Build one generation-bound query and select only needed columns.
  let query = supabase
    .from('leaderboard_ranks')
    .select(LEADERBOARD_COLUMNS)
    .eq('season_id', timeRange)
    .filter('rank_publication_id', 'eq', publication.scoreCohortId)
    .in(
      'source',
      publication.proofs.map((proof) => proof.source)
    )

  if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
    query = query.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
  }

  if (exchangeFilter) {
    query = query.eq('source', exchangeFilter)
  }

  // Category filter: map frontend category to source_type in DB
  if (categoryFilter && !exchangeFilter) {
    const sourceType = categoryFilter === 'onchain' ? 'web3' : categoryFilter
    query = query.eq('source_type', sourceType)
  }

  // Include all scored traders (score > 0 means valid ROI data)
  // Filter out outlier traders from rankings display
  query = query.gt('arena_score', 0).or('is_outlier.is.null,is_outlier.eq.false')

  // Cursor-based pagination keys on `rank`, which is a total order derived from
  // arena_score DESC. So `rank > cursor` is a valid continuation ONLY for the
  // default arena_score-desc sort. For roi/win_rate/etc. `rank` has no relation
  // to the sort order, so a rank cursor would silently drop an arbitrary set of
  // rows (page 2 not a continuation of page 1). Apply it only where it's correct;
  // non-default sorts must use page-based pagination.
  if (cursor != null && sortBy === 'arena_score' && order === 'desc') {
    query = query.gt('rank', cursor)
  }

  // Sort
  const sortColumn = SORT_COLUMN[sortBy] || 'arena_score'
  const ascending = order === 'asc'

  if (sortBy === 'arena_score') {
    // ROOT CAUSE FIX: ORDER BY rank used wrong index path (5707ms).
    // ORDER BY arena_score uses idx_leaderboard_ranks_ssr_v2 (376ms).
    // Both produce identical ordering since rank is computed from arena_score DESC.
    query = query.order('arena_score', { ascending: false, nullsFirst: false })
  } else {
    query = query.order(sortColumn, { ascending, nullsFirst: false })
  }
  // Deterministic tiebreak: ~1800 of ~9600 rows share an arena_score (ties of 4
  // near the top). Without a secondary key Postgres does not guarantee stable
  // order among equal scores, so offset pagination could duplicate/skip a tied
  // row at a page boundary and ranks would visibly jump on refresh.
  query = query.order('source_trader_id', { ascending: true })

  // Pagination — one raw page per request, true rank order.
  // The platform-diversity cap was REMOVED (owner decision 2026-07-11): capping
  // per-platform is incompatible with offset pagination (it broke the raw↔display
  // bijection → duplicate/skipped traders on page ≥ 1), and suppressing
  // legitimately top-ranked traders to balance platforms undercuts Arena's
  // neutral-ranking pitch. The board now shows true Arena-Score order.
  const fetchLimit = limit
  if (useLegacyPaging) {
    const startIdx = page * limit
    query = query.range(startIdx, startIdx + fetchLimit - 1)
  } else {
    query = query.limit(fetchLimit)
  }

  const { data, error } = await query

  if (error) {
    logger.error('leaderboard_ranks query error:', error)
    throw new Error(`leaderboard_ranks query failed: ${error.message}`)
  }

  // Exact totals and source membership come from the same immutable proof set
  // that authorized the rank rows. A post-processing count cache can lag an
  // atomic generation cutover and must not define pagination.
  const publicSources = publication.proofs
    .filter((proof) => proof.published_rank_count > 0)
    .map((proof) => proof.source)
  const publishedTotal = publication.proofs.reduce(
    (total, proof) => total + proof.published_rank_count,
    0
  )
  const pageStart = useLegacyPaging ? page * limit : 0
  const totalCount = Math.max(publishedTotal, pageStart + (data?.length || 0))

  // Verified-data set (A1): traders with an active read-only API-key
  // authorization → ✓ Verified badge (vs scraped "Tracked"). Cached, O(1) lookup.
  const verifiedKeys = await getVerifiedTraderKeys(supabase)

  // Map to trader response format (compatible with existing frontend)
  const traders = (data || []).map((row: Record<string, unknown>) => ({
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

  // Prefer our own CDN avatar mirror over the exchange-CDN proxy (no 429 cold-burst).
  // Fail-open + cached (getOrSetWithLock ttl 300) → one indexed RPC per cache fill.
  dedupedTraders = await attachAvatarMirrors(supabase, dedupedTraders)

  // Verified (claimed) badge (P3-P3, 2026-07-09): verified_traders is tiny
  // (manual owner review), so one full fetch per request marks the page's
  // rows. Fail-open — a query error just means no badges this response.
  try {
    const { data: verifiedRows } = await supabase
      .from('verified_traders')
      .select('trader_id, source')
    if (verifiedRows?.length) {
      const verifiedKeys = new Set(verifiedRows.map((v) => `${v.source}|${v.trader_id}`))
      dedupedTraders = dedupedTraders.map((t) =>
        verifiedKeys.has(`${t.source}|${t.id}`) ? { ...t, is_verified: true } : t
      )
    }
  } catch {
    /* fail-open: badge is cosmetic */
  }

  // Next cursor
  const lastTrader = dedupedTraders[dedupedTraders.length - 1]
  const nextCursor = lastTrader ? lastTrader.rank : null
  const hasMore = useLegacyPaging ? (page + 1) * limit < totalCount : traders.length === limit

  const availableSources = filterPublicRankingSources(publicSources)
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
  const freshnessBySource = new Map(sourceFreshness.map((status) => [status.source, status]))
  const lastUpdated =
    sourceFreshness.length > 0
      ? sourceFreshness.reduce(
          (oldest, status) => (status.updated_at < oldest ? status.updated_at : oldest),
          sourceFreshness[0].updated_at
        )
      : null
  const dataAgeMinutes =
    sourceFreshness.length === 0
      ? null
      : Math.round(Math.max(...sourceFreshness.map((status) => status.age_seconds)) / 60)

  // Apply profanity filter to all handles before returning
  const sanitizedTraders = dedupedTraders.map(
    (t: { handle: string | null; [key: string]: unknown }) => ({
      ...t,
      handle: sanitizeDisplayName(t.handle),
      updated_at: freshnessBySource.get(String(t.source))?.updated_at ?? null,
      is_stale: freshnessBySource.get(String(t.source))?.is_stale ?? true,
    })
  )

  return {
    traders: sanitizedTraders,
    timeRange,
    totalCount,
    rankingMode: 'arena_score',
    lastUpdated,
    isStale: false,
    dataAgeMinutes,
    source_freshness: sourceFreshness,
    // Cursor-based pagination
    nextCursor,
    hasMore,
    // Legacy compat
    page: useLegacyPaging ? page : undefined,
    limit,
    availableSources,
  }
}
