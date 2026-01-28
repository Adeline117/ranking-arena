/**
 * Search Recommendations API
 *
 * GET /api/search/recommend - Get personalized search recommendations
 *
 * Query Parameters:
 * - userId: User ID for personalized recommendations (optional)
 * - type: Recommendation type (similar|trending|following|all) default: all
 * - based On: Base recommendations on query/trader/post (optional)
 * - limit: Number of recommendations (default: 10, max: 50)
 *
 * Returns:
 * - Personalized recommendations based on:
 *   - User search history
 *   - Trending searches
 *   - Similar traders to ones viewed
 *   - Content from followed users
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('search-recommend')

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
 * Get trending traders (based on recent activity and growth)
 */
async function getTrendingTraders(
  supabase: ReturnType<typeof getSupabaseClient>,
  limit: number
) {
  try {
    // Get traders with high ROI and recent updates
    const { data, error } = await supabase
      .from('trader_sources')
      .select(`
        trader_id,
        platform,
        nickname,
        roi,
        pnl,
        follower_count,
        aum,
        is_verified,
        updated_at
      `)
      .eq('is_active', true)
      .gte('roi', 10) // Min 10% ROI
      .gte('follower_count', 100) // Min 100 followers
      .order('updated_at', { ascending: false })
      .order('roi', { ascending: false })
      .limit(limit)

    if (error) {
      logger.error('Trending traders error', { error })
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
      followers: trader.follower_count,
      isVerified: trader.is_verified,
      reason: 'trending',
      url: `/trader/${trader.trader_id}`,
    }))
  } catch (error) {
    logger.error('getTrendingTraders exception', { error })
    return []
  }
}

/**
 * Get similar traders based on performance metrics
 */
async function getSimilarTraders(
  supabase: ReturnType<typeof getSupabaseClient>,
  baseTrader: { roi: number; platform: string },
  limit: number
) {
  try {
    const roiMin = baseTrader.roi * 0.8 // ±20% ROI range
    const roiMax = baseTrader.roi * 1.2

    const { data, error } = await supabase
      .from('trader_sources')
      .select(`
        trader_id,
        platform,
        nickname,
        roi,
        pnl,
        follower_count,
        is_verified
      `)
      .eq('is_active', true)
      .eq('platform', baseTrader.platform)
      .gte('roi', roiMin)
      .lte('roi', roiMax)
      .order('follower_count', { ascending: false })
      .limit(limit)

    if (error) {
      logger.error('Similar traders error', { error })
      return []
    }

    return (data || []).map(trader => ({
      type: 'trader',
      id: trader.trader_id,
      platform: trader.platform,
      title: trader.nickname || trader.trader_id,
      subtitle: `Similar performance • ROI: ${trader.roi?.toFixed(2)}%`,
      roi: trader.roi,
      pnl: trader.pnl,
      followers: trader.follower_count,
      isVerified: trader.is_verified,
      reason: 'similar',
      url: `/trader/${trader.trader_id}`,
    }))
  } catch (error) {
    logger.error('getSimilarTraders exception', { error })
    return []
  }
}

/**
 * Get trending posts (based on recent engagement)
 */
async function getTrendingPosts(
  supabase: ReturnType<typeof getSupabaseClient>,
  limit: number
) {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('posts')
      .select(`
        id,
        title,
        content,
        created_at,
        likes_count,
        comments_count,
        profiles:user_id (username, handle)
      `)
      .eq('is_deleted', false)
      .gte('created_at', oneDayAgo)
      .order('likes_count', { ascending: false })
      .limit(limit)

    if (error) {
      logger.error('Trending posts error', { error })
      return []
    }

    return (data || []).map(post => ({
      type: 'post',
      id: post.id,
      title: post.title || 'Untitled',
      subtitle: `${(post.profiles as any)?.username || 'Unknown'} • ${post.likes_count || 0} likes`,
      content: post.content?.substring(0, 100),
      likesCount: post.likes_count,
      commentsCount: post.comments_count,
      author: (post.profiles as any)?.username,
      reason: 'trending',
      url: `/posts/${post.id}`,
    }))
  } catch (error) {
    logger.error('getTrendingPosts exception', { error })
    return []
  }
}

/**
 * Get posts from followed users
 */
async function getFollowingPosts(
  supabase: ReturnType<typeof getSupabaseClient>,
  userId: string,
  limit: number
) {
  try {
    // Get followed users
    const { data: follows, error: followsError } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', userId)
      .limit(50)

    if (followsError || !follows || follows.length === 0) {
      return []
    }

    const followingIds = follows.map(f => f.following_id)

    // Get recent posts from followed users
    const { data: posts, error: postsError } = await supabase
      .from('posts')
      .select(`
        id,
        title,
        content,
        created_at,
        likes_count,
        comments_count,
        user_id,
        profiles:user_id (username, handle)
      `)
      .in('user_id', followingIds)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (postsError) {
      logger.error('Following posts error', { error: postsError })
      return []
    }

    return (posts || []).map(post => ({
      type: 'post',
      id: post.id,
      title: post.title || 'Untitled',
      subtitle: `${(post.profiles as any)?.username || 'Unknown'} (following)`,
      content: post.content?.substring(0, 100),
      likesCount: post.likes_count,
      commentsCount: post.comments_count,
      author: (post.profiles as any)?.username,
      reason: 'following',
      url: `/posts/${post.id}`,
    }))
  } catch (error) {
    logger.error('getFollowingPosts exception', { error })
    return []
  }
}

/**
 * GET - Get recommendations
 */
export async function GET(req: NextRequest) {
  try {
    // Rate limiting
    const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.search)
    if (rateLimitResponse) {
      return rateLimitResponse
    }

    const { searchParams } = new URL(req.url)
    const userId = searchParams.get('userId') || undefined
    const type = searchParams.get('type') || 'all'
    const basedOn = searchParams.get('basedOn') || undefined
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '10')))

    const supabase = getSupabaseClient()

    let recommendations: any[] = []

    // Get different types of recommendations
    if (type === 'all' || type === 'trending') {
      const trendingTraders = await getTrendingTraders(supabase, limit)
      const trendingPosts = await getTrendingPosts(supabase, limit)
      recommendations.push(...trendingTraders, ...trendingPosts)
    }

    if (type === 'similar' && basedOn) {
      // Parse basedOn (format: trader:binance:123 or post:456)
      const [entityType, ...rest] = basedOn.split(':')

      if (entityType === 'trader' && rest.length >= 2) {
        const [platform, traderId] = rest

        // Get base trader data
        const { data: baseTrader } = await supabase
          .from('trader_sources')
          .select('roi, platform')
          .eq('trader_id', traderId)
          .eq('platform', platform)
          .single()

        if (baseTrader) {
          const similar = await getSimilarTraders(supabase, baseTrader, limit)
          recommendations.push(...similar)
        }
      }
    }

    if (type === 'all' || type === 'following') {
      if (userId) {
        const followingPosts = await getFollowingPosts(supabase, userId, limit)
        recommendations.push(...followingPosts)
      }
    }

    // Remove duplicates and shuffle if 'all'
    if (type === 'all') {
      const seen = new Set()
      recommendations = recommendations.filter(rec => {
        const key = `${rec.type}:${rec.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      // Shuffle for variety
      recommendations.sort(() => Math.random() - 0.5)
    }

    // Limit final results
    recommendations = recommendations.slice(0, limit)

    return NextResponse.json({
      success: true,
      data: {
        recommendations,
        meta: {
          type,
          userId,
          basedOn,
          count: recommendations.length,
        },
      },
    })
  } catch (error) {
    logger.error('Recommendations error', { error })
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
