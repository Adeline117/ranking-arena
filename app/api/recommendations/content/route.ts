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
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

const DISCOVERABLE_GROUP_VISIBILITIES = ['open', 'apply'] as const
const GROUP_DISCOVERY_SELECT =
  'id, name, name_en, description, description_en, avatar_url, member_count'

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

async function getCurrentGroupRecommendations(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  actorId: string | null,
  limit: number
): Promise<{ recommendations: Record<string, unknown>[]; personalized: boolean }> {
  const recommendations: Record<string, unknown>[] = []
  let personalized = false

  if (actorId) {
    const { data: rpcData, error: rpcError } = await supabase.rpc('recommend_groups_for_user', {
      p_user_id: actorId,
      p_limit: limit,
    })

    if (!rpcError && Array.isArray(rpcData)) {
      const rankedCandidates = rpcData
        .filter(
          (row): row is (typeof rpcData)[number] & { group_id: string } =>
            typeof row?.group_id === 'string' && !!row.group_id
        )
        .slice(0, limit)
      const groupIds = [...new Set(rankedCandidates.map((row) => row.group_id))]

      if (groupIds.length > 0) {
        const { data: currentGroups, error: currentGroupsError } = await supabase
          .from('groups')
          .select(GROUP_DISCOVERY_SELECT)
          .in('id', groupIds)
          .is('dissolved_at', null)
          .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
        if (currentGroupsError) throw currentGroupsError

        const currentById = new Map(
          ((currentGroups as Record<string, unknown>[] | null) ?? []).map((group) => [
            group.id as string,
            group,
          ])
        )
        for (const candidate of rankedCandidates) {
          const current = currentById.get(candidate.group_id)
          if (!current || recommendations.length >= limit) continue
          recommendations.push({
            ...current,
            recommendation_reason: candidate.reason ?? null,
            recommendation_score: candidate.score ?? null,
          })
        }
        personalized = recommendations.length > 0
      }
    }
  }

  if (recommendations.length < limit) {
    const existingIds = new Set(
      recommendations
        .map((group) => group.id)
        .filter((groupId): groupId is string => typeof groupId === 'string')
    )
    const { data: popularGroups, error: popularGroupsError } = await supabase
      .from('groups')
      .select(GROUP_DISCOVERY_SELECT)
      .is('dissolved_at', null)
      .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
      .order('member_count', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .limit(Math.min(50, limit + existingIds.size))
    if (popularGroupsError) throw popularGroupsError

    for (const group of (popularGroups as Record<string, unknown>[] | null) ?? []) {
      if (recommendations.length >= limit) break
      if (typeof group.id !== 'string' || existingIds.has(group.id)) continue
      recommendations.push({ ...group, recommendation_reason: 'popular' })
      existingIds.add(group.id)
    }
  }

  return { recommendations, personalized }
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

    if (contentType === 'group') {
      const groupResult = await getCurrentGroupRecommendations(supabase, user?.id ?? null, limit)
      return success(
        {
          recommendations: groupResult.recommendations,
          type: contentType,
          personalized: groupResult.personalized,
        },
        200,
        NO_STORE_HEADERS
      )
    }

    if (!user) {
      // Cache only service-side candidates. The canonical audience RPC runs
      // after every cache hit so an audience/entitlement change takes effect
      // immediately instead of waiting for a payload cache to expire.
      const candidates = await tieredGetOrSet(
        `rec:content:v2:candidates:anon:${contentType}:${limit}`,
        async () => {
          const { data: fallbackData, error: fallbackError } = await supabase
            .from('posts')
            .select(
              'id, title, content, created_at, hot_score, like_count, comment_count, author_id'
            )
            .order('hot_score', { ascending: false })
            .limit(limit)
          if (fallbackError) throw fallbackError
          return (fallbackData as Record<string, unknown>[]) || []
        },
        'hot'
      )
      const recommendations = await authorizePostsAndAttachAuthors(supabase, candidates, null)
      return success(
        { recommendations, type: contentType, personalized: false },
        200,
        NO_STORE_HEADERS
      )
    }

    const { data: rpcData, error: rpcError } = await supabase.rpc(
      'recommend_by_collaborative_filtering',
      { p_user_id: user.id, p_target_type: contentType, p_limit: limit }
    )

    if (rpcError || !rpcData || !Array.isArray(rpcData) || rpcData.length === 0) {
      // Fallback
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('posts')
        .select('id, title, content, created_at, hot_score, like_count, comment_count, author_id')
        .order('hot_score', { ascending: false })
        .limit(limit)
      if (fallbackError) throw fallbackError

      return success(
        {
          recommendations: await authorizePostsAndAttachAuthors(
            supabase,
            (fallbackData as Record<string, unknown>[]) || [],
            user.id
          ),
          type: contentType,
          personalized: false,
        },
        200,
        NO_STORE_HEADERS
      )
    }

    // Fetch full data based on content type
    const itemIds = [
      ...new Set(
        rpcData
          .map((row: Record<string, unknown>) => row.target_id)
          .filter((targetId): targetId is string => typeof targetId === 'string' && !!targetId)
      ),
    ].slice(0, limit)

    if (contentType === 'post') {
      const { data: posts, error: postsError } = await supabase
        .from('posts')
        .select('id, title, content, created_at, hot_score, like_count, comment_count, author_id')
        .in('id', itemIds)
      if (postsError) throw postsError

      const postMap = new Map((posts || []).map((p: Record<string, unknown>) => [p.id, p]))
      const ordered = itemIds.map((id: string) => postMap.get(id)).filter(Boolean)

      return success(
        {
          recommendations: await authorizePostsAndAttachAuthors(
            supabase,
            ordered as Record<string, unknown>[],
            user.id
          ),
          type: contentType,
          personalized: true,
        },
        200,
        NO_STORE_HEADERS
      )
    }

    // For other types, return raw RPC data
    return success(
      {
        recommendations: rpcData,
        type: contentType,
        personalized: true,
      },
      200,
      NO_STORE_HEADERS
    )
  } catch (error: unknown) {
    const response = handleError(error, 'recommendations content GET')
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      response.headers.set(name, value)
    }
    return response
  }
}
