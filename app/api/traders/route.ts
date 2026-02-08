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
import { withPublic } from '@/lib/api/middleware'
import { getOrSetWithLock, CacheKey } from '@/lib/cache'
import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('traders-api')

export const runtime = 'edge'
export const preferredRegion = ['iad1', 'sfo1', 'hnd1']
export const dynamic = 'force-dynamic'

export const GET = withPublic(
  async ({ supabase, request }) => {
    const searchParams = request.nextUrl.searchParams
    const timeRange = (searchParams.get('timeRange') || '90D') as Period
    const exchangeFilter = searchParams.get('exchange')
    const sortBy = searchParams.get('sortBy') as 'arena_score' | 'roi' | 'win_rate' | 'max_drawdown' | null
    const order = (searchParams.get('order') || 'desc') as 'asc' | 'desc'

    // Cursor-based pagination (preferred)
    const cursor = searchParams.get('cursor') // rank value to start after
    const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '50', 10) || 50))

    // Legacy page-based pagination fallback
    const page = parseInt(searchParams.get('page') || '', 10)
    const useLegacyPaging = !isNaN(page) && !cursor

    const effectiveSortBy = sortBy || 'arena_score'

    // Cache key
    const cacheKey = `leaderboard:${timeRange}:${exchangeFilter || 'all'}:${effectiveSortBy}:${order}:${cursor || 'start'}:${limit}${useLegacyPaging ? `:p${page}` : ''}`

    const cachedData = await getOrSetWithLock(
      cacheKey,
      async () => {
        return await fetchFromLeaderboard(supabase, {
          timeRange,
          exchangeFilter,
          sortBy: effectiveSortBy,
          order,
          cursor: cursor ? parseInt(cursor, 10) : null,
          limit,
          useLegacyPaging,
          page: useLegacyPaging ? Math.max(0, page) : 0,
        })
      },
      { ttl: 120, lockTtl: 10 }
    )

    const response = NextResponse.json(cachedData)
    response.headers.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300')
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

  // Build query
  let query = supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact' })
    .eq('season_id', timeRange)

  if (exchangeFilter) {
    query = query.eq('source', exchangeFilter)
  }

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
    return { traders: [], totalCount: 0, error: error.message }
  }

  const totalCount = count ?? 0

  // Map to trader response format (compatible with existing frontend)
  const traders = (data || []).map((row: Record<string, unknown>) => ({
    id: row.source_trader_id as string,
    handle: (row.handle as string) || (row.source_trader_id as string),
    roi: Number(row.roi) || 0,
    pnl: Number(row.pnl) || 0,
    win_rate: row.win_rate != null ? Number(row.win_rate) : null,
    max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
    trades_count: row.trades_count != null ? Number(row.trades_count) : null,
    followers: row.followers != null ? Number(row.followers) : null,
    source: row.source as string,
    source_type: row.source_type as string,
    avatar_url: row.avatar_url as string | null,
    arena_score: Number(row.arena_score) || 0,
    rank: Number(row.rank),
  }))

  // Next cursor
  const lastTrader = traders[traders.length - 1]
  const nextCursor = lastTrader ? lastTrader.rank : null
  const hasMore = useLegacyPaging
    ? (page + 1) * limit < totalCount
    : traders.length === limit

  // Available sources (for UI filter)
  // Only fetch distinct sources once per timeRange (cached via outer cache)
  // Fetch sources across all seasons so newly-computed platforms always appear
  const { data: sourceRows } = await supabase
    .from('leaderboard_ranks')
    .select('source')

  const availableSources = [...new Set((sourceRows || []).map((r: { source: string }) => r.source))].sort()

  // Latest computed_at
  const computedAt = data?.[0]?.computed_at || new Date().toISOString()

  return {
    traders,
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
