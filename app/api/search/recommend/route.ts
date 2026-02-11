/**
 * Search Recommendations API
 *
 * GET /api/search/recommend - Get personalized search recommendations
 *
 * Returns trending traders (from leaderboard_ranks), trending posts,
 * and posts from followed users.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('search-recommend')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase configuration')
  }

  return createClient(supabaseUrl, supabaseKey)
}

/**
 * Get trending traders from leaderboard_ranks (highest arena_score)
 */
async function getTrendingTraders(
  supabase: ReturnType<typeof getSupabaseClient>,
  limit: number
) {
  try {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select(`
        source,
        source_trader_id,
        handle,
        avatar_url,
        arena_score,
        roi,
        pnl,
        win_rate
      `)
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .order('arena_score', { ascending: false })
      .limit(limit)

    if (error) {
      logger.error('Trending traders error', { error })
      return []
    }

    return (data || []).map(trader => ({
      type: 'trader',
      id: trader.source_trader_id,
      platform: trader.source,
      title: trader.handle || trader.source_trader_id,
      subtitle: `${trader.source} • Score: ${trader.arena_score}`,
      arenaScore: trader.arena_score,
      roi: trader.roi,
      pnl: trader.pnl,
      winRate: trader.win_rate,
      reason: 'trending',
      url: `/trader/${trader.source_trader_id}?platform=${trader.source}`,
      avatarUrl: trader.avatar_url,
    }))
  } catch (error: unknown) {
    logger.error('getTrendingTraders exception', { error })
    return []
  }
}

/**
 * Get similar traders based on arena_score range
 */
async function getSimilarTraders(
  supabase: ReturnType<typeof getSupabaseClient>,
  baseTrader: { arenaScore: number; platform: string },
  limit: number
) {
  try {
    const scoreMin = baseTrader.arenaScore * 0.8
    const scoreMax = baseTrader.arenaScore * 1.2

    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select(`
        source,
        source_trader_id,
        handle,
        avatar_url,
        arena_score,
        roi,
        pnl,
        win_rate
      `)
      .eq('season_id', '90D')
      .eq('source', baseTrader.platform)
      .gte('arena_score', scoreMin)
      .lte('arena_score', scoreMax)
      .order('arena_score', { ascending: false })
      .limit(limit)

    if (error) {
      logger.error('Similar traders error', { error })
      return []
    }

    return (data || []).map(trader => ({
      type: 'trader',
      id: trader.source_trader_id,
      platform: trader.source,
      title: trader.handle || trader.source_trader_id,
      subtitle: `Similar performance • Score: ${trader.arena_score}`,
      arenaScore: trader.arena_score,
      roi: trader.roi,
      pnl: trader.pnl,
      winRate: trader.win_rate,
      reason: 'similar',
      url: `/trader/${trader.source_trader_id}?platform=${trader.source}`,
      avatarUrl: trader.avatar_url,
    }))
  } catch (error: unknown) {
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
      subtitle: `${((post.profiles as unknown) as Record<string, unknown>)?.username || 'Unknown'} • ${post.likes_count || 0} likes`,
      content: post.content?.substring(0, 100),
      likesCount: post.likes_count,
      commentsCount: post.comments_count,
      author: ((post.profiles as unknown) as Record<string, unknown>)?.username,
      reason: 'trending',
      url: `/posts/${post.id}`,
    }))
  } catch (error: unknown) {
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
    const { data: follows, error: followsError } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', userId)
      .limit(50)

    if (followsError || !follows || follows.length === 0) {
      return []
    }

    const followingIds = follows.map(f => f.following_id)

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
      subtitle: `${((post.profiles as unknown) as Record<string, unknown>)?.username || 'Unknown'} (following)`,
      content: post.content?.substring(0, 100),
      likesCount: post.likes_count,
      commentsCount: post.comments_count,
      author: ((post.profiles as unknown) as Record<string, unknown>)?.username,
      reason: 'following',
      url: `/posts/${post.id}`,
    }))
  } catch (error: unknown) {
    logger.error('getFollowingPosts exception', { error })
    return []
  }
}

/**
 * GET - Get recommendations
 */
export async function GET(req: NextRequest) {
  try {
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

    let recommendations: Array<{ type: string; [key: string]: unknown }> = []

    if (type === 'all' || type === 'trending') {
      const trendingTraders = await getTrendingTraders(supabase, limit)
      const trendingPosts = await getTrendingPosts(supabase, limit)
      recommendations.push(...trendingTraders, ...trendingPosts)
    }

    if (type === 'similar' && basedOn) {
      const [entityType, ...rest] = basedOn.split(':')

      if (entityType === 'trader' && rest.length >= 2) {
        const [platform, traderId] = rest

        // Get base trader data from leaderboard_ranks
        const { data: baseTrader } = await supabase
          .from('leaderboard_ranks')
          .select('arena_score, source')
          .eq('source_trader_id', traderId)
          .eq('source', platform)
          .eq('season_id', '90D')
          .single()

        if (baseTrader) {
          const similar = await getSimilarTraders(supabase, {
            arenaScore: baseTrader.arena_score,
            platform: baseTrader.source,
          }, limit)
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
      recommendations.sort(() => Math.random() - 0.5)
    }

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
  } catch (error: unknown) {
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
