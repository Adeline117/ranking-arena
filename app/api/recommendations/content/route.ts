/**
 * GET /api/recommendations/content
 *
 * Collaborative filtering recommendations via recommend_by_collaborative_filtering RPC.
 * Returns recommended posts/content for authenticated users.
 */

export const runtime = 'nodejs'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  success,
  handleError,
  validateNumber,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'

// Candidate rows may be cached server-side, but the final audience decision is
// evaluated on every request. A CDN-cached payload could outlive a group being
// made private/premium, so recommendation responses themselves are never shared.
const ANON_CACHE_HEADER = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

/**
 * Merge author profiles into post rows. posts.author_id has no FK in prod, so
 * the users!posts_author_id_fkey embed fails with PGRST200 (and the users table
 * has no handle/display_name/avatar_url columns anyway) — two-step lookup via
 * user_profiles instead, keeping the `author` response key shape.
 */
async function authorizePostsAndAttachAuthors(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  posts: Record<string, unknown>[],
  actorId: string | null
): Promise<Record<string, unknown>[]> {
  if (posts.length === 0) return posts
  // The admin client bypasses posts RLS. Never release a raw recommendation
  // row: the canonical RPC also checks wrapper/root audience, account health,
  // block edges, and (when configured) paid-group entitlement. Any missing or
  // malformed acknowledgement fails closed inside this filter.
  const postCandidates = posts.filter(
    (post): post is Record<string, unknown> & { id: string } => typeof post.id === 'string'
  )
  const readablePosts = await filterServiceReadablePostRows(supabase, postCandidates, actorId)
  if (readablePosts.length === 0) return []

  const authorIds = [
    ...new Set(readablePosts.map((post) => post.author_id as string).filter(Boolean)),
  ]
  const { data: profiles } = authorIds.length
    ? await supabase.from('user_profiles').select('id, handle, avatar_url').in('id', authorIds)
    : { data: null }
  const profileById = new Map(
    (profiles || []).map((p: Record<string, unknown>) => [p.id as string, p])
  )
  return readablePosts.map((post) => ({
    ...post,
    author: profileById.get(post.author_id as string) ?? null,
  }))
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    const contentType =
      validateEnum(searchParams.get('type'), ['post', 'group', 'trader'] as const) ?? 'post'
    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20

    const user = await getAuthUser(request)

    if (!user) {
      // Cache only service-side candidates. The canonical audience RPC runs
      // after every cache hit so an audience/entitlement change takes effect
      // immediately instead of waiting for a payload cache to expire.
      const candidates = await tieredGetOrSet(
        `rec:content:v2:candidates:anon:${contentType}:${limit}`,
        async () => {
          const { data: fallbackData } = await supabase
            .from('posts')
            .select(
              'id, title, content, created_at, hot_score, like_count, comment_count, author_id'
            )
            .order('hot_score', { ascending: false })
            .limit(limit)
          return (fallbackData as Record<string, unknown>[]) || []
        },
        'hot'
      )
      const recommendations = await authorizePostsAndAttachAuthors(supabase, candidates, null)
      return success(
        { recommendations, type: contentType, personalized: false },
        200,
        ANON_CACHE_HEADER
      )
    }

    const { data: rpcData, error: rpcError } = await supabase.rpc(
      'recommend_by_collaborative_filtering',
      { p_user_id: user.id, p_type: contentType, p_limit: limit }
    )

    if (rpcError || !rpcData || !Array.isArray(rpcData) || rpcData.length === 0) {
      // Fallback
      const { data: fallbackData } = await supabase
        .from('posts')
        .select('id, title, content, created_at, hot_score, like_count, comment_count, author_id')
        .order('hot_score', { ascending: false })
        .limit(limit)

      return success({
        recommendations: await authorizePostsAndAttachAuthors(
          supabase,
          (fallbackData as Record<string, unknown>[]) || [],
          user.id
        ),
        type: contentType,
        personalized: false,
      })
    }

    // Fetch full data based on content type
    const itemIds = rpcData.map((r: Record<string, unknown>) => r.item_id as string)

    if (contentType === 'post') {
      const { data: posts } = await supabase
        .from('posts')
        .select('id, title, content, created_at, hot_score, like_count, comment_count, author_id')
        .in('id', itemIds)

      const postMap = new Map((posts || []).map((p: Record<string, unknown>) => [p.id, p]))
      const ordered = itemIds.map((id: string) => postMap.get(id)).filter(Boolean)

      return success({
        recommendations: await authorizePostsAndAttachAuthors(
          supabase,
          ordered as Record<string, unknown>[],
          user.id
        ),
        type: contentType,
        personalized: true,
      })
    }

    // For other types, return raw RPC data
    return success({
      recommendations: rpcData,
      type: contentType,
      personalized: true,
    })
  } catch (error: unknown) {
    return handleError(error, 'recommendations content GET')
  }
}
