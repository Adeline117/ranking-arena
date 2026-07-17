/**
 * User follow API.
 * GET checks the authenticated viewer's relationship with one active user.
 * POST delegates follow/unfollow to the canonical database transaction.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import { isPublicProfileActive } from '@/lib/profile/public-audience'
import { invalidateFollowingCache } from '@/app/api/following/route'

export const dynamic = 'force-dynamic'

const uuidSchema = z.string().trim().uuid()
const followQuerySchema = z.object({ followingId: uuidSchema }).strict()
const followMutationSchema = z
  .object({
    followingId: uuidSchema,
    action: z.enum(['follow', 'unfollow']),
  })
  .strict()

const countSchema = z.number().int().nonnegative()
const successfulFollowResultSchema = z
  .object({
    status: z.enum(['followed', 'already_following', 'unfollowed', 'already_not_following']),
    actor_id: uuidSchema,
    target_id: uuidSchema,
    action: z.enum(['follow', 'unfollow']),
    changed: z.boolean(),
    following: z.boolean(),
    followed_by: z.boolean(),
    mutual: z.boolean(),
    actor_follower_count: countSchema,
    actor_following_count: countSchema,
    target_follower_count: countSchema,
    target_following_count: countSchema,
  })
  .strict()
const failedFollowResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('invalid') }).strict(),
  z.object({ status: z.literal('self') }).strict(),
  z.object({ status: z.literal('actor_unavailable') }).strict(),
  z.object({ status: z.literal('target_unavailable') }).strict(),
  z.object({ status: z.literal('blocked') }).strict(),
])
const followResultSchema = z.union([successfulFollowResultSchema, failedFollowResultSchema])

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

async function authenticateUser(
  request: NextRequest
): Promise<{ userId: string } | { error: string; status: number }> {
  const { extractUserFromRequest } = await import('@/lib/auth/extract-user')
  const { user, error: authError } = await extractUserFromRequest(request)

  if (authError || !user) {
    return { error: 'Authentication failed', status: 401 }
  }

  const userId = uuidSchema.safeParse(user.id)
  if (!userId.success) {
    return { error: 'Authentication failed', status: 401 }
  }
  return { userId: userId.data }
}

function csrfRejected(request: NextRequest): NextResponse | null {
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
  const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
  if (!validateCsrfToken(cookieToken, headerToken)) {
    return json({ error: 'CSRF validation failed' }, 403)
  }
  return null
}

export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
    if (rateLimitResponse) return rateLimitResponse

    const authResult = await authenticateUser(request)
    if ('error' in authResult) return json({ error: authResult.error }, authResult.status)

    const parsedQuery = followQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    )
    if (!parsedQuery.success) return json({ error: 'Invalid followingId' }, 400)

    const followerId = authResult.userId
    const followingId = parsedQuery.data.followingId
    if (followerId === followingId) return json({ error: 'Cannot follow yourself' }, 400)

    const supabase = getSupabaseAdmin()
    const [targetResult, followResult, reverseResult] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('id, handle, deleted_at, banned_at, is_banned, ban_expires_at')
        .eq('id', followingId)
        .maybeSingle(),
      supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', followerId)
        .eq('following_id', followingId)
        .maybeSingle(),
      supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', followingId)
        .eq('following_id', followerId)
        .maybeSingle(),
    ])

    if (targetResult.error || followResult.error || reverseResult.error) {
      logger.error('[User Follow API] relationship query failed', {
        targetError: targetResult.error?.message,
        followError: followResult.error?.message,
        reverseError: reverseResult.error?.message,
      })
      return json({ error: 'Failed to check follow status' }, 500)
    }
    if (!targetResult.data || !isPublicProfileActive(targetResult.data)) {
      return json({ error: 'User not found' }, 404)
    }

    const following = followResult.data !== null
    const followedBy = reverseResult.data !== null
    return json({ following, followedBy, mutual: following && followedBy })
  } catch (error: unknown) {
    logger.error('[User Follow API] relationship query threw', error)
    return json({ error: 'Internal server error' }, 500)
  }
}

export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const authResult = await authenticateUser(request)
    if ('error' in authResult) return json({ error: authResult.error }, authResult.status)

    const csrfError = csrfRejected(request)
    if (csrfError) return csrfError

    const parsedBody = followMutationSchema.safeParse(await request.json().catch(() => null))
    if (!parsedBody.success) return json({ error: 'Invalid follow request' }, 400)

    const followerId = authResult.userId
    const { followingId, action } = parsedBody.data
    if (followerId === followingId) return json({ error: 'Cannot follow yourself' }, 400)

    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase.rpc('mutate_user_follow_atomic', {
      p_actor_id: followerId,
      p_target_id: followingId,
      p_action: action,
    })

    if (error) {
      logger.error('[User Follow API] atomic mutation failed', {
        actorId: followerId,
        targetId: followingId,
        action,
        error: error.message,
      })
      return json({ error: 'Follow operation failed' }, 500)
    }

    const parsedResult = followResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('[User Follow API] malformed atomic mutation result', {
        actorId: followerId,
        targetId: followingId,
        action,
      })
      return json({ error: 'Follow operation failed' }, 500)
    }

    const result = parsedResult.data
    if ('actor_id' in result) {
      const expectedFollowing = action === 'follow'
      const expectedChanged = result.status === 'followed' || result.status === 'unfollowed'
      if (
        result.actor_id !== followerId ||
        result.target_id !== followingId ||
        result.action !== action ||
        result.following !== expectedFollowing ||
        result.changed !== expectedChanged ||
        result.mutual !== (result.following && result.followed_by) ||
        (action === 'follow' && !['followed', 'already_following'].includes(result.status)) ||
        (action === 'unfollow' && !['unfollowed', 'already_not_following'].includes(result.status))
      ) {
        logger.error('[User Follow API] inconsistent atomic mutation result', {
          actorId: followerId,
          targetId: followingId,
          action,
          status: result.status,
        })
        return json({ error: 'Follow operation failed' }, 500)
      }

      if (result.status === 'followed') {
        fireAndForget(
          (async () => {
            const { data: followerProfile } = await supabase
              .from('user_profiles')
              .select('handle')
              .eq('id', followerId)
              .maybeSingle()
            const followerHandle = followerProfile?.handle || 'Someone'
            sendNotification(
              supabase,
              {
                user_id: followingId,
                type: 'new_follower',
                title: 'New Follower',
                message: `${followerHandle} started following you`,
                actor_id: followerId,
                link: `/u/${followerHandle}`,
                reference_id: followerId,
              },
              'User follow notification'
            )
          })(),
          'Resolve user follow notification actor'
        )
      }

      if (result.changed) {
        fireAndForget(
          invalidateFollowingCache(followerId),
          'Invalidate user following cache after follow mutation'
        )
      }

      return json({
        success: true,
        following: result.following,
        followedBy: result.followed_by,
        mutual: result.mutual,
        followerCount: result.target_follower_count,
        followingCount: result.actor_following_count,
      })
    }

    switch (result.status) {
      case 'invalid':
        return json({ error: 'Invalid follow request' }, 400)
      case 'self':
        return json({ error: 'Cannot follow yourself' }, 400)
      case 'actor_unavailable':
        return json({ error: 'Account is not active' }, 403)
      case 'target_unavailable':
        return json({ error: 'User not found' }, 404)
      case 'blocked':
        return json({ error: 'A block relationship prevents following' }, 403)
    }
  } catch (error: unknown) {
    logger.error('[User Follow API] mutation threw', error)
    return json({ error: 'Internal server error' }, 500)
  }
}
