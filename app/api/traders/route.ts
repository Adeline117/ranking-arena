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
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { getOrSetWithLock } from '@/lib/cache'
import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import { validateTradersResponse } from '@/lib/api/traders-response-schema'

const logger = createLogger('traders-api')

export const runtime = 'nodejs'
export const preferredRegion = ['iad1', 'sfo1', 'hnd1']
export const dynamic = 'force-dynamic'

// ── Input validation schema ──────────────────────────────────────────────────
const tradersQuerySchema = z.object({
  timeRange: z.string().toUpperCase().pipe(z.enum(['7D', '30D', '90D'])).catch('90D'),
  exchange: z.string().optional(),
  sortBy: z.enum(['arena_score', 'roi', 'win_rate', 'max_drawdown']).catch('arena_score'),
  order: z.enum(['asc', 'desc']).catch('desc'),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).catch(50),
  page: z.coerce.number().int().min(0).optional(),
})

// In-memory cache for available sources (shared across requests, TTL 30 min)
const availableSourcesCache = new Map<string, { sources: string[]; ts: number }>()
const SOURCES_TTL = 30 * 60 * 1000 // 30 min — sources change only on cron runs
const SOURCES_CACHE_MAX = 50 // prevent unbounded growth

// Select only needed columns from leaderboard_ranks (avoid SELECT *)
const LEADERBOARD_COLUMNS = 'source_trader_id, handle, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, source, source_type, avatar_url, arena_score, rank, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, style_confidence, computed_at, season_id, sharpe_ratio, trader_type'

export const GET = withPublic(
  async ({ supabase, request }) => {
    const searchParams = request.nextUrl.searchParams
    const rawParams = Object.fromEntries(searchParams)
    const parsed = tradersQuerySchema.safeParse(rawParams)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid parameters', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { timeRange: timeRangeStr, exchange: exchangeFilter, sortBy, order, limit } = parsed.data
    const timeRange = timeRangeStr as Period
    const cursor = parsed.data.cursor != null ? String(parsed.data.cursor) : null
    const page = parsed.data.page ?? NaN
    const useLegacyPaging = !isNaN(page) && !cursor

    const effectiveSortBy = sortBy || 'arena_score'

    // Cache key
    const cacheKey = `leaderboard:${timeRange}:${exchangeFilter || 'all'}:${effectiveSortBy}:${order}:${cursor || 'start'}:${limit}${useLegacyPaging ? `:p${page}` : ''}`

    const cachedData = await getOrSetWithLock(
      cacheKey,
      async () => {
        return await fetchFromLeaderboard(supabase, {
          timeRange,
          exchangeFilter: exchangeFilter ?? null,
          sortBy: effectiveSortBy,
          order,
          cursor: cursor ? parseInt(cursor, 10) : null,
          limit,
          useLegacyPaging,
          page: useLegacyPaging ? Math.max(0, page) : 0,
        })
      },
      { ttl: 60, lockTtl: 10 }
    )

    // Dev-only: validate output shape to catch response drift early (no-op in prod)
    validateTradersResponse(cachedData, logger)

    // Data is already sanitized before caching (in the fetcher below)
    const response = NextResponse.json(cachedData)
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
    return response
  },
  { name: 'traders', rateLimit: 'read' }
)

// Column mapping for sortBy
const SORT_COLUMN: Record<string, string> = {
  arena_score: 'arena_score',
  roi: 'roi',
  win_rate: 'win_rate',
  max_drawdown: 'max_drawdown',
}

async function fetchFromLeaderboard(
  supabase: ReturnType<typeof import('@/lib/supabase/server').getSupabaseAdmin>,
  params: {
    timeRange: Period
    exchangeFilter: string | null
    sortBy: string
    order: 'asc' | 'desc'
    cursor: number | null
    limit: number
    useLegacyPaging: boolean
    page: number
  }
) {
  const { timeRange, exchangeFilter, sortBy, order, cursor, limit, useLegacyPaging, page } = params

  // Build query — select only needed columns (avoid SELECT *)
  // Use 'planned' count (fastest) instead of 'estimated' which adds ~300ms per query.
  // The totalCount is approximate but sufficient for pagination UI.
  let query = supabase
    .from('leaderboard_ranks')
    .select(LEADERBOARD_COLUMNS, { count: 'planned' })
    .eq('season_id', timeRange)

  if (exchangeFilter) {
    query = query.eq('source', exchangeFilter)
  }

  // Include all scored traders (score > 0 means valid ROI data)
  // Filter out outlier traders from rankings display
  query = query.gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')

  // Cursor-based: filter by rank
  if (cursor != null) {
    if (sortBy === 'arena_score' && order === 'desc') {
      // Default: rank > cursor
      query = query.gt('rank', cursor)
    } else {
      // For other sorts, use rank as cursor
      query = query.gt('rank', cursor)
    }
  }

  // Sort
  const sortColumn = SORT_COLUMN[sortBy] || 'arena_score'
  const ascending = order === 'asc'

  if (sortBy === 'arena_score') {
    // Use pre-computed rank order
    query = query.order('rank', { ascending: true })
  } else {
    query = query.order(sortColumn, { ascending, nullsFirst: false })
  }

  // Pagination
  if (useLegacyPaging) {
    const startIdx = page * limit
    query = query.range(startIdx, startIdx + limit - 1)
  } else {
    query = query.limit(limit)
  }

  const { data, error, count } = await query

  if (error) {
    logger.error('leaderboard_ranks query error:', error)
    throw new Error(`leaderboard_ranks query failed: ${error.message}`)
  }

  const totalCount = count ?? 0

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
    // Bot classification
    is_bot: row.source === 'web3_bot' || row.trader_type === 'bot',
    trader_type: (row.trader_type as string) || (row.source === 'web3_bot' ? 'bot' : null),
  }))

  // Deduplicate 0x addresses (case-insensitive) — VPS imports may write checksum-case
  const seen = new Set<string>()
  let dedupedTraders = traders.filter((t: { id: string; source: string }) => {
    const key = (t.id.startsWith('0x') ? t.id.toLowerCase() : t.id) + '|' + t.source
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Platform diversity: when viewing overall (no exchange filter) with small limits,
  // cap per-platform to prevent a single platform from monopolizing the first page
  if (!exchangeFilter && sortBy === 'arena_score' && !cursor && limit <= 100) {
    const MAX_PER_PLATFORM = Math.max(5, Math.ceil(limit * 0.4))
    const platformCounts = new Map<string, number>()
    dedupedTraders = dedupedTraders.filter((t: { source: string }) => {
      const count = platformCounts.get(t.source) || 0
      if (count >= MAX_PER_PLATFORM) return false
      platformCounts.set(t.source, count + 1)
      return true
    })
  }

  // Next cursor
  const lastTrader = dedupedTraders[dedupedTraders.length - 1]
  const nextCursor = lastTrader ? lastTrader.rank : null
  const hasMore = useLegacyPaging
    ? (page + 1) * limit < totalCount
    : traders.length === limit

  // Available sources (for UI filter) — cached in-memory with 5-min TTL
  const sourceCacheEntry = availableSourcesCache.get(timeRange)
  let availableSources: string[]
  if (sourceCacheEntry && Date.now() - sourceCacheEntry.ts < SOURCES_TTL) {
    availableSources = sourceCacheEntry.sources
  } else {
    // Extract distinct sources from the full query data (already fetched above)
    // Plus a lightweight supplementary query for sources not in the current page
    const allSourceSet = new Set<string>()
    for (const r of (data || [])) allSourceSet.add((r as { source: string }).source)
    // Supplementary: get distinct sources via lightweight query
    const { data: sourceRows } = await supabase
      .from('leaderboard_ranks')
      .select('source')
      .eq('season_id', timeRange)
      .gt('arena_score', 0)
      .limit(500)
    for (const r of (sourceRows || [])) allSourceSet.add((r as { source: string }).source)
    availableSources = [...allSourceSet].sort()
    if (availableSourcesCache.size >= SOURCES_CACHE_MAX) {
      availableSourcesCache.clear()
    }
    availableSourcesCache.set(timeRange, { sources: availableSources, ts: Date.now() })
  }

  // Latest computed_at
  const computedAt = data?.[0]?.computed_at || new Date().toISOString()

  // Apply profanity filter to all handles before returning
  const sanitizedTraders = dedupedTraders.map((t: { handle: string | null; [key: string]: unknown }) => ({
    ...t,
    handle: sanitizeDisplayName(t.handle)
  }))

  return {
    traders: sanitizedTraders,
    timeRange,
    totalCount,
    rankingMode: 'arena_score',
    lastUpdated: computedAt,
    isStale: false,
    // Cursor-based pagination
    nextCursor,
    hasMore,
    // Legacy compat
    page: useLegacyPaging ? page : undefined,
    limit,
    availableSources,
  }
}
