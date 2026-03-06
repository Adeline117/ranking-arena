/**
 * Advanced Search API
 *
 * GET /api/search/advanced - Perform advanced full-text search with filters
 *
 * Query Parameters:
 * - q: Search query (required)
 * - type: Search type (traders|posts|users|all) default: all
 * - exchange: Filter by exchange (optional)
 * - minRoi: Minimum ROI percentage (optional)
 * - maxRoi: Maximum ROI percentage (optional)
 * - minFollowers: Minimum followers (optional)
 * - timeRange: Time range (1d|7d|30d|90d|all) default: all
 * - sortBy: Sort field (relevance|roi|pnl|followers|date) default: relevance
 * - page: Page number (default: 1)
 * - limit: Results per page (default: 20, max: 100)
 *
 * Returns:
 * - Categorized search results with pagination
 * - Relevance scoring
 * - Highlighted matches
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { escapeLikePattern } from '@/lib/sanitize'

const logger = createLogger('search-advanced')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

// Initialize Supabase client
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase configuration')
  }

  return createClient(supabaseUrl, supabaseKey)
}

/**
 * Search traders with filters
 */
async function searchTraders(
  supabase: ReturnType<typeof getSupabaseClient>,
  query: string,
  filters: {
    exchange?: string
    minRoi?: number
    maxRoi?: number
    minFollowers?: number
    sortBy?: string
  },
  limit: number
) {
  try {
    // Step 1: Search trader_sources for matching traders (this table has handle, source, avatar_url etc.)
    const q = query ? escapeLikePattern(query) : ''

    let sourceQuery = supabase
      .from('trader_sources')
      .select('source_trader_id, handle, source, avatar_url')

    if (q) {
      sourceQuery = sourceQuery.or(`handle.ilike.%${q}%,source_trader_id.ilike.%${q}%`)
    }

    if (filters.exchange) {
      sourceQuery = sourceQuery.eq('source', filters.exchange)
    }

    sourceQuery = sourceQuery.limit(limit * 2) // fetch extra to allow filtering

    const { data: sourceData, error: sourceError } = await sourceQuery

    if (sourceError) {
      logger.error('Trader search error', { error: sourceError })
      return []
    }

    if (!sourceData || sourceData.length === 0) return []

    // Step 2: Get performance metrics from trader_snapshots for these traders
    const traderIds = [...new Set(sourceData.map(s => s.source_trader_id))]
    const sources = [...new Set(sourceData.map(s => s.source))]

    let snapshotQuery = supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, roi, pnl, win_rate, followers, max_drawdown, captured_at, arena_score')
      .in('source', sources)
      .in('source_trader_id', traderIds)
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)

    if (filters.minRoi !== undefined) {
      snapshotQuery = snapshotQuery.gte('roi', filters.minRoi / 100) // DB stores as decimal
    }
    if (filters.maxRoi !== undefined) {
      snapshotQuery = snapshotQuery.lte('roi', filters.maxRoi / 100)
    }

    const { data: snapshotData } = await snapshotQuery

    // Build snapshot lookup map
    const snapshotMap = new Map<string, (typeof snapshotData extends (infer T)[] | null ? T : never)>()
    if (snapshotData) {
      for (const snap of snapshotData) {
        const key = `${snap.source}:${snap.source_trader_id}`
        if (!snapshotMap.has(key)) snapshotMap.set(key, snap)
      }
    }

    // Step 3: Merge and return
    const results = sourceData
      .map(trader => {
        const key = `${trader.source}:${trader.source_trader_id}`
        const snap = snapshotMap.get(key)
        const roi = snap?.roi != null ? parseFloat(String(snap.roi)) * 100 : null
        const pnl = snap?.pnl != null ? parseFloat(String(snap.pnl)) : null

        return {
          type: 'trader' as const,
          id: trader.source_trader_id,
          platform: trader.source,
          title: trader.handle || trader.source_trader_id,
          subtitle: `${trader.source} • ROI: ${roi != null ? roi.toFixed(2) : 'N/A'}%`,
          roi,
          pnl,
          winRate: snap?.win_rate != null ? parseFloat(String(snap.win_rate)) : null,
          followers: snap?.followers ?? null,
          aum: null,
          maxDrawdown: snap?.max_drawdown != null ? parseFloat(String(snap.max_drawdown)) : null,
          isVerified: false,
          updatedAt: snap?.captured_at ?? null,
          url: `/trader/${trader.handle || trader.source_trader_id}`,
          avatarUrl: trader.avatar_url,
          arenaScore: snap?.arena_score != null ? parseFloat(String(snap.arena_score)) : null,
        }
      })

    // Sort results
    switch (filters.sortBy) {
      case 'roi':
        results.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity))
        break
      case 'pnl':
        results.sort((a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity))
        break
      case 'followers':
        results.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0))
        break
      default:
        // Relevance: sort by arena score
        results.sort((a, b) => (b.arenaScore ?? -Infinity) - (a.arenaScore ?? -Infinity))
    }

    return results.slice(0, limit)
  } catch (error: unknown) {
    logger.error('searchTraders exception', { error })
    return []
  }
}

/**
 * Search posts with filters
 */
async function searchPosts(
  supabase: ReturnType<typeof getSupabaseClient>,
  query: string,
  filters: {
    timeRange?: string
    sortBy?: string
  },
  limit: number
) {
  try {
    let queryBuilder = supabase
      .from('posts')
      .select(`
        id,
        title,
        content,
        created_at,
        likes_count,
        comments_count,
        user_id,
        group_id,
        profiles:user_id (username, avatar_url, handle),
        groups:group_id (name, name_en)
      `)
      .eq('is_deleted', false)

    // Full-text search on title and content
    if (query) {
      const q = escapeLikePattern(query)
      queryBuilder = queryBuilder.or(`title.ilike.%${q}%,content.ilike.%${q}%`)
    }

    // Time range filter
    if (filters.timeRange && filters.timeRange !== 'all') {
      const now = new Date()
      let startDate: Date

      switch (filters.timeRange) {
        case '1d':
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          break
        case '7d':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
          break
        case '30d':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
          break
        case '90d':
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
          break
        default:
          startDate = new Date(0)
      }

      queryBuilder = queryBuilder.gte('created_at', startDate.toISOString())
    }

    // Sorting
    switch (filters.sortBy) {
      case 'date':
        queryBuilder = queryBuilder.order('created_at', { ascending: false })
        break
      default:
        // Relevance: sort by engagement (likes + comments)
        queryBuilder = queryBuilder.order('likes_count', { ascending: false })
    }

    queryBuilder = queryBuilder.limit(limit)

    const { data, error } = await queryBuilder

    if (error) {
      logger.error('Post search error', { error })
      return []
    }

    return (data || []).map(post => ({
      type: 'post',
      id: post.id,
      title: post.title || '',
      subtitle: `${((post.profiles as unknown) as Record<string, unknown> | null)?.username || 'Unknown'} • ${post.likes_count || 0} likes`,
      content: post.content?.substring(0, 150),
      likesCount: post.likes_count,
      commentsCount: post.comments_count,
      author: ((post.profiles as unknown) as Record<string, unknown> | null)?.username as string | undefined,
      authorHandle: ((post.profiles as unknown) as Record<string, unknown> | null)?.handle as string | undefined,
      group: ((post.groups as unknown) as Record<string, unknown> | null)?.name as string || ((post.groups as unknown) as Record<string, unknown> | null)?.name_en as string,
      createdAt: post.created_at,
      url: `/posts/${post.id}`,
    }))
  } catch (error: unknown) {
    logger.error('searchPosts exception', { error })
    return []
  }
}

/**
 * Search users
 */
async function searchUsers(
  supabase: ReturnType<typeof getSupabaseClient>,
  query: string,
  limit: number
) {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('id, username, handle, avatar_url, bio, is_pro, follower_count')
      .or(`username.ilike.%${escapeLikePattern(query)}%,handle.ilike.%${escapeLikePattern(query)}%,bio.ilike.%${escapeLikePattern(query)}%`)
      .limit(limit)

    if (error) {
      logger.error('User search error', { error })
      return []
    }

    return (data || []).map(user => ({
      type: 'user',
      id: user.id,
      title: user.username,
      subtitle: `@${user.handle}${user.is_pro ? ' • PRO' : ''}`,
      bio: user.bio?.substring(0, 100),
      avatarUrl: user.avatar_url,
      isPro: user.is_pro,
      followers: user.follower_count,
      url: `/u/${user.handle}`,
    }))
  } catch (error: unknown) {
    logger.error('searchUsers exception', { error })
    return []
  }
}

/**
 * GET - Advanced search
 */
export async function GET(req: NextRequest) {
  try {
    // Rate limiting
    const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.search)
    if (rateLimitResponse) {
      return rateLimitResponse
    }

    const { searchParams } = new URL(req.url)
    const query = searchParams.get('q')?.trim() || ''
    const type = searchParams.get('type') || 'all'
    const exchange = searchParams.get('exchange') || undefined
    const minRoi = searchParams.get('minRoi') ? parseFloat(searchParams.get('minRoi')!) : undefined
    const maxRoi = searchParams.get('maxRoi') ? parseFloat(searchParams.get('maxRoi')!) : undefined
    const minFollowers = searchParams.get('minFollowers')
      ? parseInt(searchParams.get('minFollowers')!)
      : undefined
    const timeRange = searchParams.get('timeRange') || 'all'
    const sortBy = searchParams.get('sortBy') || 'relevance'
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')))

    if (!query) {
      return NextResponse.json({
        success: false,
        error: 'Search query is required',
      }, { status: 400 })
    }

    const supabase = getSupabaseClient()
    const filters = { exchange, minRoi, maxRoi, minFollowers, timeRange, sortBy }

    const results: {
      query: string
      filters: Record<string, unknown>
      results: { traders: unknown[]; posts: unknown[]; users: unknown[] }
      pagination: { page: number; limit: number; total: number }
    } = {
      query,
      filters: {
        type,
        ...filters,
      },
      results: {
        traders: [],
        posts: [],
        users: [],
      },
      pagination: {
        page,
        limit,
        total: 0,
      },
    }

    // Search based on type
    if (type === 'all' || type === 'traders') {
      results.results.traders = await searchTraders(supabase, query, filters, limit)
    }

    if (type === 'all' || type === 'posts') {
      results.results.posts = await searchPosts(supabase, query, { timeRange, sortBy }, limit)
    }

    if (type === 'all' || type === 'users') {
      results.results.users = await searchUsers(supabase, query, limit)
    }

    // Calculate total results
    results.pagination.total =
      results.results.traders.length +
      results.results.posts.length +
      results.results.users.length

    const response = NextResponse.json({
      success: true,
      data: results,
    })
    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120')
    return response
  } catch (error: unknown) {
    logger.error('Advanced search error', { error })
    // Never expose internal error details to the client
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
