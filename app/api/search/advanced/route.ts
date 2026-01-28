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

const logger = createLogger('search-advanced')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Initialize Supabase client
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY

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
    let queryBuilder = supabase
      .from('trader_sources')
      .select(`
        trader_id,
        platform,
        nickname,
        roi,
        pnl,
        win_rate,
        follower_count,
        aum,
        max_drawdown,
        updated_at,
        is_verified
      `)
      .eq('is_active', true)

    // Full-text search on nickname and trader_id
    if (query) {
      queryBuilder = queryBuilder.or(`nickname.ilike.%${query}%,trader_id.ilike.%${query}%`)
    }

    // Apply filters
    if (filters.exchange) {
      queryBuilder = queryBuilder.eq('platform', filters.exchange)
    }

    if (filters.minRoi !== undefined) {
      queryBuilder = queryBuilder.gte('roi', filters.minRoi)
    }

    if (filters.maxRoi !== undefined) {
      queryBuilder = queryBuilder.lte('roi', filters.maxRoi)
    }

    if (filters.minFollowers !== undefined) {
      queryBuilder = queryBuilder.gte('follower_count', filters.minFollowers)
    }

    // Sorting
    switch (filters.sortBy) {
      case 'roi':
        queryBuilder = queryBuilder.order('roi', { ascending: false, nullsFirst: false })
        break
      case 'pnl':
        queryBuilder = queryBuilder.order('pnl', { ascending: false, nullsFirst: false })
        break
      case 'followers':
        queryBuilder = queryBuilder.order('follower_count', { ascending: false, nullsFirst: false })
        break
      case 'date':
        queryBuilder = queryBuilder.order('updated_at', { ascending: false })
        break
      default:
        // Default: relevance (verified first, then by ROI)
        queryBuilder = queryBuilder.order('is_verified', { ascending: false })
        queryBuilder = queryBuilder.order('roi', { ascending: false, nullsFirst: false })
    }

    queryBuilder = queryBuilder.limit(limit)

    const { data, error } = await queryBuilder

    if (error) {
      logger.error('Trader search error', { error })
      return []
    }

    return (data || []).map(trader => ({
      type: 'trader',
      id: trader.trader_id,
      platform: trader.platform,
      title: trader.nickname || trader.trader_id,
      subtitle: `${trader.platform} • ROI: ${trader.roi?.toFixed(2)}%`,
      roi: trader.roi,
      pnl: trader.pnl,
      winRate: trader.win_rate,
      followers: trader.follower_count,
      aum: trader.aum,
      maxDrawdown: trader.max_drawdown,
      isVerified: trader.is_verified,
      updatedAt: trader.updated_at,
      url: `/trader/${trader.trader_id}`,
    }))
  } catch (error) {
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
      queryBuilder = queryBuilder.or(`title.ilike.%${query}%,content.ilike.%${query}%`)
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
      subtitle: `${(post.profiles as any)?.username || 'Unknown'} • ${post.likes_count || 0} likes`,
      content: post.content?.substring(0, 150),
      likesCount: post.likes_count,
      commentsCount: post.comments_count,
      author: (post.profiles as any)?.username,
      authorHandle: (post.profiles as any)?.handle,
      group: (post.groups as any)?.name || (post.groups as any)?.name_en,
      createdAt: post.created_at,
      url: `/posts/${post.id}`,
    }))
  } catch (error) {
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
      .or(`username.ilike.%${query}%,handle.ilike.%${query}%,bio.ilike.%${query}%`)
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
  } catch (error) {
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

    let results: any = {
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

    return NextResponse.json({
      success: true,
      data: results,
    })
  } catch (error) {
    logger.error('Advanced search error', { error })
    const errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    )
  }
}
