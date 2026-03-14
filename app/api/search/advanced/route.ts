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
import { features } from '@/lib/features'
import { searchTraders as unifiedSearchTraders } from '@/lib/data/unified'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'

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
 * Search traders using unified data layer, then apply advanced filters
 */
async function searchTradersAdvanced(
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
    // Fetch more results to allow post-filtering
    const fetchLimit = limit * 3
    const traders = await unifiedSearchTraders(supabase, {
      query,
      limit: fetchLimit,
      platform: filters.exchange,
    })

    // Apply additional filters that unified searchTraders doesn't handle
    let filtered = traders

    if (filters.minRoi !== undefined) {
      filtered = filtered.filter(t => t.roi != null && t.roi >= filters.minRoi!)
    }
    if (filters.maxRoi !== undefined) {
      filtered = filtered.filter(t => t.roi != null && t.roi <= filters.maxRoi!)
    }
    if (filters.minFollowers !== undefined) {
      filtered = filtered.filter(t => t.followers != null && t.followers >= filters.minFollowers!)
    }

    // Sort results
    switch (filters.sortBy) {
      case 'roi':
        filtered.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity))
        break
      case 'pnl':
        filtered.sort((a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity))
        break
      case 'followers':
        filtered.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0))
        break
      default:
        // Relevance: already sorted by unified searchTraders (exact > prefix > arena_score)
        break
    }

    // Map to response format
    return filtered.slice(0, limit).map(t => {
      const exchangeName = EXCHANGE_CONFIG[t.platform as keyof typeof EXCHANGE_CONFIG]?.name || t.platform
      return {
        type: 'trader' as const,
        id: t.traderKey,
        platform: t.platform,
        title: t.handle || t.traderKey,
        subtitle: `${exchangeName} • ROI: ${t.roi != null ? t.roi.toFixed(2) : 'N/A'}%`,
        roi: t.roi,
        pnl: t.pnl,
        winRate: t.winRate,
        followers: t.followers,
        aum: null,
        maxDrawdown: t.maxDrawdown,
        isVerified: false,
        updatedAt: t.lastUpdated,
        url: `/trader/${t.handle || t.traderKey}`,
        avatarUrl: t.avatarUrl,
        arenaScore: t.arenaScore,
      }
    })
  } catch (error: unknown) {
    logger.error('searchTradersAdvanced exception', { error })
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
      results.results.traders = await searchTradersAdvanced(supabase, query, filters, limit)
    }

    // Skip social content (posts, users) when social feature is disabled
    if ((type === 'all' || type === 'posts') && features.social) {
      results.results.posts = await searchPosts(supabase, query, { timeRange, sortBy }, limit)
    }

    if ((type === 'all' || type === 'users') && features.social) {
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
