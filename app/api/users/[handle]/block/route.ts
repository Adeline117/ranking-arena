/**
 * User block API. The dynamic segment is the target user UUID (the historical
 * route directory is named [handle]). Block-time follow cleanup is owned by a
 * single database transaction.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { extractUserFromRequest } from '@/lib/auth/extract-user'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { fireAndForget } from '@/lib/utils/logger'
import { invalidateFollowingCache } from '@/app/api/following/route'
import { socialFeatureGuard } from '@/lib/features'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ handle: string }>
}

const uuidSchema = z.string().trim().uuid()
const paramsSchema = z.object({ handle: uuidSchema }).strict()
const countSchema = z.number().int().nonnegative()
const successfulBlockResultSchema = z
  .object({
    status: z.enum(['blocked', 'already_blocked', 'unblocked', 'already_unblocked']),
    actor_id: uuidSchema,
    target_id: uuidSchema,
    action: z.enum(['block', 'unblock']),
    changed: z.boolean(),
    blocked: z.boolean(),
    removed_outgoing_follow: z.boolean(),
    removed_incoming_follow: z.boolean(),
    actor_follower_count: countSchema,
    actor_following_count: countSchema,
    target_follower_count: countSchema,
    target_following_count: countSchema,
  })
  .strict()
const failedBlockResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('invalid') }).strict(),
  z.object({ status: z.literal('self') }).strict(),
  z.object({ status: z.literal('actor_unavailable') }).strict(),
  z.object({ status: z.literal('target_unavailable') }).strict(),
])
const blockResultSchema = z.union([successfulBlockResultSchema, failedBlockResultSchema])

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function csrfRejected(request: NextRequest): NextResponse | null {
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
  const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
  if (!validateCsrfToken(cookieToken, headerToken)) {
    return json({ error: 'CSRF validation failed' }, 403)
  }
  return null
}

async function mutateBlock(
  request: NextRequest,
  context: RouteContext,
  action: 'block' | 'unblock'
): Promise<NextResponse> {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { user, error: authError } = await extractUserFromRequest(request)
    if (authError || !user) return json({ error: 'Unauthorized' }, 401)

    const actorId = uuidSchema.safeParse(user.id)
    if (!actorId.success) return json({ error: 'Unauthorized' }, 401)

    const csrfError = csrfRejected(request)
    if (csrfError) return csrfError

    const params = paramsSchema.safeParse(await context.params)
    if (!params.success) return json({ error: 'Invalid target user ID' }, 400)

    const targetUserId = params.data.handle
    if (actorId.data === targetUserId) {
      return json(
        { error: action === 'block' ? 'Cannot block yourself' : 'Cannot unblock yourself' },
        400
      )
    }

    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase.rpc('mutate_user_block_atomic', {
      p_actor_id: actorId.data,
      p_target_id: targetUserId,
      p_action: action,
    })

    if (error) {
      logger.error('[User Block API] atomic mutation failed', {
        actorId: actorId.data,
        targetUserId,
        action,
        error: error.message,
      })
      return json({ error: `Failed to ${action} user` }, 500)
    }

    const parsedResult = blockResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('[User Block API] malformed atomic mutation result', {
        actorId: actorId.data,
        targetUserId,
        action,
      })
      return json({ error: `Failed to ${action} user` }, 500)
    }

    const result = parsedResult.data
    if ('actor_id' in result) {
      const expectedChanged = result.status === 'blocked' || result.status === 'unblocked'
      if (
        result.actor_id !== actorId.data ||
        result.target_id !== targetUserId ||
        result.action !== action ||
        result.blocked !== (action === 'block') ||
        result.changed !== expectedChanged ||
        (action === 'block' && !['blocked', 'already_blocked'].includes(result.status)) ||
        (action === 'unblock' && !['unblocked', 'already_unblocked'].includes(result.status)) ||
        (action === 'unblock' && (result.removed_outgoing_follow || result.removed_incoming_follow))
      ) {
        logger.error('[User Block API] inconsistent atomic mutation result', {
          actorId: actorId.data,
          targetUserId,
          action,
          status: result.status,
        })
        return json({ error: `Failed to ${action} user` }, 500)
      }

      // A block removes either directional edge; invalidating both owners also
      // repairs stale candidates left by a retried legacy block. Unblock keeps
      // no follow edge, but the same invalidation is cheap and deterministic.
      fireAndForget(
        Promise.all([
          invalidateFollowingCache(actorId.data),
          invalidateFollowingCache(targetUserId),
        ]),
        'Invalidate following caches after block mutation'
      )

      if (action === 'block' && result.status === 'already_blocked') {
        return json({ success: true, alreadyBlocked: true })
      }
      return json({ success: true })
    }

    switch (result.status) {
      case 'invalid':
        return json({ error: 'Invalid block request' }, 400)
      case 'self':
        return json(
          { error: action === 'block' ? 'Cannot block yourself' : 'Cannot unblock yourself' },
          400
        )
      case 'actor_unavailable':
        return json({ error: 'Account is not active' }, 403)
      case 'target_unavailable':
        return json({ error: 'User not found' }, 404)
    }
  } catch (error: unknown) {
    logger.error('[User Block API] mutation threw', error)
    return json({ error: 'Internal server error' }, 500)
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  return mutateBlock(request, context, 'block')
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return mutateBlock(request, context, 'unblock')
}
