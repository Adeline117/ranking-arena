/**
 * GET /api/feed/personalized
 *
 * Personalized feed using get_personalized_feed RPC.
 * Falls back to hot_score for unauthenticated users.
 */

export const runtime = 'nodejs'

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
import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'

type PersonalizedFeedCacheEntry = {
  posts: Record<string, unknown>[]
  hasMore: boolean
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

    const user = await getAuthUser(request)
    const userId = user?.id ?? 'anon'
    const cacheKey = `feed:personalized:v2:candidates:${userId}:${limit}:${offset}`

    const { posts, hasMore } = await getOrSet<PersonalizedFeedCacheEntry>(
      cacheKey,
      async () => {
        const supabase = getSupabaseAdmin()
        let fetchedPosts: Record<string, unknown>[] = []

        if (user) {
          // Call personalized feed RPC
          const { data: feedData, error: rpcError } = await supabase.rpc('get_personalized_feed', {
            p_user_id: user.id,
            p_limit: limit,
            p_offset: offset,
          })

          if (rpcError) {
            // Fallback to hot_score on RPC error
            const { data: fallbackData } = await supabase
              .from('posts')
              .select(
                'id, title, created_at, updated_at, author_id, author_handle, group_id, images, like_count, comment_count, repost_count, view_count, bookmark_count, is_pinned, hot_score, poll_enabled, poll_bull, poll_bear, poll_wait, visibility, language, mentions, hashtags, group:groups!posts_group_id_fkey(id, name, name_en, avatar_url)'
              )
              .order('hot_score', { ascending: false })
              .range(offset, offset + limit - 1)

            fetchedPosts = (fallbackData as Record<string, unknown>[]) || []
          } else {
            // RPC returns post IDs with scores; fetch full post data
            if (feedData && Array.isArray(feedData) && feedData.length > 0) {
              const postIds = feedData.map((r: Record<string, unknown>) => r.post_id as string)
              const { data: fullPosts } = await supabase
                .from('posts')
                .select(
                  'id, title, created_at, updated_at, author_id, author_handle, group_id, images, like_count, comment_count, repost_count, view_count, bookmark_count, is_pinned, hot_score, poll_enabled, poll_bull, poll_bear, poll_wait, visibility, language, mentions, hashtags, group:groups!posts_group_id_fkey(id, name, name_en, avatar_url)'
                )
                .in('id', postIds)

              // Preserve RPC ordering
              const postMap = new Map(
                (fullPosts || []).map((p: Record<string, unknown>) => [p.id, p])
              )
              fetchedPosts = postIds.map((id: string) => postMap.get(id)).filter(Boolean) as Record<
                string,
                unknown
              >[]
            }
          }
        } else {
          // Unauthenticated: fallback to hot_score
          const { data: fallbackData } = await supabase
            .from('posts')
            .select(
              'id, title, created_at, updated_at, author_id, author_handle, group_id, images, like_count, comment_count, repost_count, view_count, bookmark_count, is_pinned, hot_score, poll_enabled, poll_bull, poll_bear, poll_wait, visibility, language, mentions, hashtags, group:groups!posts_group_id_fkey(id, name, name_en, avatar_url)'
            )
            .order('hot_score', { ascending: false })
            .range(offset, offset + limit - 1)

          fetchedPosts = (fallbackData as Record<string, unknown>[]) || []
        }

        // Merge author profiles. posts.author_id has no FK in prod, so the
        // users!posts_author_id_fkey embed fails with PGRST200 (and the users
        // table has no handle/display_name/avatar_url columns anyway) —
        // two-step lookup via user_profiles instead.
        if (fetchedPosts.length > 0) {
          const authorIds = [
            ...new Set(fetchedPosts.map((p) => p.author_id as string).filter(Boolean)),
          ]
          const { data: authorProfiles } = authorIds.length
            ? await supabase
                .from('user_profiles')
                .select('id, handle, avatar_url')
                .in('id', authorIds)
            : { data: null }
          const profileById = new Map(
            (authorProfiles || []).map((p: Record<string, unknown>) => [p.id as string, p])
          )
          fetchedPosts = fetchedPosts.map((post) => ({
            ...post,
            author: profileById.get(post.author_id as string) ?? null,
          }))
        }

        // Attach user reactions/votes
        let userReactions: Map<string, 'up' | 'down'> = new Map()
        let userVotes: Map<string, 'bull' | 'bear' | 'wait'> = new Map()

        if (user && fetchedPosts.length > 0) {
          const postIds = fetchedPosts.map((p) => p.id as string)
          const [reactions, votes] = await Promise.all([
            getUserPostReactions(supabase, postIds, user.id),
            getUserPostVotes(supabase, postIds, user.id),
          ])
          userReactions = reactions
          userVotes = votes
        }

        const postsWithState = fetchedPosts.map((post) => ({
          ...post,
          user_reaction: userReactions.get(post.id as string) || null,
          user_vote: userVotes.get(post.id as string) || null,
        }))

        return { posts: postsWithState, hasMore: fetchedPosts.length === limit }
      },
      { ttl: 60 }
    )

    // Cache entries are only candidates. Re-run the canonical service audience
    // decision after every hit so blocks, membership, account state, and paid
    // entitlements cannot remain readable for the cache TTL.
    const postCandidates = posts.filter(
      (post): post is Record<string, unknown> & { id: string } => typeof post.id === 'string'
    )
    const readablePosts = await filterServiceReadablePostRows(
      getSupabaseAdmin(),
      postCandidates,
      user?.id ?? null
    )

    const response = successWithPagination(
      { posts: readablePosts },
      { limit, offset, has_more: hasMore }
    )
    response.headers.set('Cache-Control', 'private, no-store, max-age=0')
    response.headers.set('CDN-Cache-Control', 'no-store')
    response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
    return response
  } catch (error: unknown) {
    return handleError(error, 'personalized feed GET')
  }
}
