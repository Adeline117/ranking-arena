/**
 * GET /api/hashtags/[tag]
 * Return posts for a specific hashtag, paginated.
 */

export const runtime = 'edge'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getOptionalAuthUser,
  successWithPagination,
  handleError,
  checkRateLimit,
  RateLimitPresets,
  validateNumber,
  validateEnum,
} from '@/lib/api'
import { getPostsByHashtag } from '@/lib/data/hashtags'
import { getUserPostReactions, getUserPostVotes } from '@/lib/data/posts'

const MAX_PAGE_OFFSET = 10_000

function privateNoStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  response.headers.set('CDN-Cache-Control', 'no-store')
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
  const vary = new Set(
    (response.headers.get('Vary') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )
  vary.add('Authorization')
  response.headers.set('Vary', [...vary].join(', '))
  return response
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
    if (rateLimitResponse) return privateNoStore(rateLimitResponse)

    const user = await getOptionalAuthUser(request)
    const { tag } = await params
    const { searchParams } = new URL(request.url)

    const limit =
      validateNumber(searchParams.get('limit'), { min: 1, max: 100, integer: true }) ?? 20
    const offset =
      validateNumber(searchParams.get('offset'), {
        min: 0,
        max: MAX_PAGE_OFFSET,
        integer: true,
      }) ?? 0
    const sort_by =
      validateEnum(searchParams.get('sort_by'), ['hot_score', 'created_at'] as const) ??
      'created_at'

    const supabase = getSupabaseAdmin()
    const { posts, total, has_more } = await getPostsByHashtag(supabase, tag, {
      limit,
      offset,
      sort_by,
      viewer_id: user?.id ?? null,
    })

    let userReactions: Map<string, 'up' | 'down'> = new Map()
    let userVotes: Map<string, 'bull' | 'bear' | 'wait'> = new Map()
    if (user && posts.length > 0) {
      const postIds = posts.map((post) => post.id)
      const [reactions, votes] = await Promise.all([
        getUserPostReactions(supabase, postIds, user.id),
        getUserPostVotes(supabase, postIds, user.id),
      ])
      userReactions = reactions
      userVotes = votes
    }

    const postsWithUserState = posts.map((post) => ({
      ...post,
      user_reaction: userReactions.get(post.id) ?? null,
      user_vote: userVotes.get(post.id) ?? null,
    }))

    // Post audience can change independently of the hashtag mapping. The data
    // layer re-authorizes every service-role row, and the final payload must
    // not outlive that decision in a browser or CDN cache.
    return privateNoStore(
      successWithPagination(
        { posts: postsWithUserState, tag: tag.toLowerCase(), total },
        { limit, offset, has_more, ...(total === null ? {} : { total }) }
      )
    )
  } catch (error: unknown) {
    return privateNoStore(handleError(error, 'hashtags [tag] GET'))
  }
}
