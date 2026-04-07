/**
 * GET /api/feed/personalized
 * 
 * Personalized feed using get_personalized_feed RPC.
 * Falls back to hot_score for unauthenticated users.
 */

export const runtime = 'edge'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  successWithPagination,
  handleError,
  validateNumber,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { getUserPostReactions, getUserPostVotes } from '@/lib/data/posts'
import { getOrSet } from '@/lib/cache'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

    const user = await getAuthUser(request)
    const userId = user?.id ?? 'anon'
    const cacheKey = `feed:personalized:${userId}:${limit}:${offset}`

    const { posts, hasMore } = await getOrSet(
      cacheKey,
      async () => {
        const supabase = getSupabaseAdmin()
        let fetchedPosts: Record<string, unknown>[] = []

        if (user) {
          // Call personalized feed RPC
          const { data: feedData, error: rpcError } = await supabase.rpc(
            'get_personalized_feed',
            { p_user_id: user.id, p_limit: limit, p_offset: offset }
          )

          if (rpcError) {
            // Fallback to hot_score on RPC error
            const { data: fallbackData } = await supabase
              .from('posts')
              .select('*, author:users!posts_author_id_fkey(id, handle, display_name, avatar_url), group:groups!posts_group_id_fkey(id, name, name_en, avatar_url)')
              .order('hot_score', { ascending: false })
              .range(offset, offset + limit - 1)

            fetchedPosts = (fallbackData as Record<string, unknown>[]) || []
          } else {
            // RPC returns post IDs with scores; fetch full post data
            if (feedData && Array.isArray(feedData) && feedData.length > 0) {
              const postIds = feedData.map((r: Record<string, unknown>) => r.post_id as string)
              const { data: fullPosts } = await supabase
                .from('posts')
                .select('*, author:users!posts_author_id_fkey(id, handle, display_name, avatar_url), group:groups!posts_group_id_fkey(id, name, name_en, avatar_url)')
                .in('id', postIds)

              // Preserve RPC ordering
              const postMap = new Map((fullPosts || []).map((p: Record<string, unknown>) => [p.id, p]))
              fetchedPosts = postIds
                .map((id: string) => postMap.get(id))
                .filter(Boolean) as Record<string, unknown>[]
            }
          }
        } else {
          // Unauthenticated: fallback to hot_score
          const { data: fallbackData } = await supabase
            .from('posts')
            .select('*, author:users!posts_author_id_fkey(id, handle, display_name, avatar_url), group:groups!posts_group_id_fkey(id, name, name_en, avatar_url)')
            .order('hot_score', { ascending: false })
            .range(offset, offset + limit - 1)

          fetchedPosts = (fallbackData as Record<string, unknown>[]) || []
        }

        // Attach user reactions/votes
        let userReactions: Map<string, 'up' | 'down'> = new Map()
        let userVotes: Map<string, 'bull' | 'bear' | 'wait'> = new Map()

        if (user && fetchedPosts.length > 0) {
          const postIds = fetchedPosts.map(p => p.id as string)
          const [reactions, votes] = await Promise.all([
            getUserPostReactions(supabase, postIds, user.id),
            getUserPostVotes(supabase, postIds, user.id),
          ])
          userReactions = reactions
          userVotes = votes
        }

        const postsWithState = fetchedPosts.map(post => ({
          ...post,
          user_reaction: userReactions.get(post.id as string) || null,
          user_vote: userVotes.get(post.id as string) || null,
        }))

        return { posts: postsWithState, hasMore: fetchedPosts.length === limit }
      },
      { ttl: 60 }
    )

    return successWithPagination(
      { posts },
      { limit, offset, has_more: hasMore }
    )
  } catch (error: unknown) {
    return handleError(error, 'personalized feed GET')
  }
}
