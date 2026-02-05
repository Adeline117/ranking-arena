import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import {
  getPostRecommendations,
  getTrendingPosts,
} from '@/lib/algorithms/content-recommendation'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'

/**
 * GET /api/recommendations
 *
 * Returns personalized content recommendations for the authenticated user.
 * Falls back to trending content for unauthenticated users.
 *
 * Query params:
 * - type: 'posts' | 'trending' (default: 'posts')
 * - limit: number (default: 20, max: 50)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') || 'posts'
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50)

  const supabase = getSupabaseAdmin()
  const user = await getAuthUser(request)

  try {
    // Trending posts - public, cacheable
    if (type === 'trending') {
      const cacheKey = `recommendations:trending:${limit}`
      const { data: cached } = await tieredGet<{ recommendations: unknown[]; type: string }>(cacheKey, 'warm')
      if (cached) {
        return NextResponse.json(cached)
      }

      const trending = await getTrendingPosts(supabase, { limit })

      // Get full post data
      const postIds = trending.map((t) => t.id)
      const { data: posts } = await supabase
        .from('posts')
        .select(`
          id,
          content,
          author_id,
          author_handle,
          created_at,
          like_count,
          comment_count,
          hot_score,
          image_urls
        `)
        .in('id', postIds)

      const response = {
        recommendations: trending.map((r) => ({
          ...r,
          post: posts?.find((p) => p.id === r.id) || null,
        })),
        type: 'trending',
      }

      // Cache for 5 minutes
      await tieredSet(cacheKey, response, 'warm')

      return NextResponse.json(response)
    }

    // Personalized posts - requires auth
    if (type === 'posts') {
      if (!user) {
        // Fall back to trending for unauthenticated users
        return NextResponse.redirect(new URL('/api/recommendations?type=trending', request.url))
      }

      // Check user-specific cache (shorter TTL)
      const cacheKey = `recommendations:posts:${user.id}:${limit}`
      const { data: cached } = await tieredGet<{ recommendations: unknown[]; type: string }>(cacheKey, 'hot')
      if (cached) {
        return NextResponse.json(cached)
      }

      const recommendations = await getPostRecommendations(supabase, user.id, { limit })

      // Get full post data
      const postIds = recommendations.map((r) => r.id)
      const { data: posts } = await supabase
        .from('posts')
        .select(`
          id,
          content,
          author_id,
          author_handle,
          created_at,
          like_count,
          comment_count,
          hot_score,
          image_urls
        `)
        .in('id', postIds)

      const response = {
        recommendations: recommendations.map((r) => ({
          ...r,
          post: posts?.find((p) => p.id === r.id) || null,
        })),
        type: 'personalized',
      }

      // Cache for 2 minutes (hot tier)
      await tieredSet(cacheKey, response, 'hot')

      return NextResponse.json(response)
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  } catch (err) {
    console.error('[Recommendations] Error:', err)
    return NextResponse.json({ error: 'Failed to get recommendations' }, { status: 500 })
  }
}
