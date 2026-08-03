/**
 * Post pin state API
 * POST /api/posts/[id]/pin - set an explicit desired pin state atomically
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

type RouteContext = { params: Promise<{ id: string }> }

const PostIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())

const BodySchema = z.object({ is_pinned: z.boolean() }).strict()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const denialReasons = new Set([
  'INVALID',
  'ACTOR_UNAVAILABLE',
  'POST_NOT_FOUND',
  'PERMISSION_DENIED',
])

type AtomicPostPinAcknowledgement =
  | { success: false; reason: string }
  | {
      success: true
      actorId: string
      postId: string
      authorId: string
      groupId: string | null
      scopeType: 'author' | 'group'
      scopeId: string
      isPinned: boolean
      alreadySet: boolean
      unpinnedCount: number
    }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null
}

function readAtomicAcknowledgement(value: unknown): AtomicPostPinAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>

  if (result.success === false) {
    if (!hasExactKeys(result, ['reason', 'success'])) return null
    if (typeof result.reason !== 'string' || !denialReasons.has(result.reason)) return null
    return { success: false, reason: result.reason }
  }

  if (
    result.success !== true ||
    !hasExactKeys(result, [
      'actor_id',
      'already_set',
      'author_id',
      'group_id',
      'is_pinned',
      'post_id',
      'scope_id',
      'scope_type',
      'success',
      'unpinned_count',
    ]) ||
    typeof result.is_pinned !== 'boolean' ||
    typeof result.already_set !== 'boolean' ||
    typeof result.unpinned_count !== 'number' ||
    !Number.isSafeInteger(result.unpinned_count) ||
    result.unpinned_count < 0 ||
    (result.already_set && result.unpinned_count !== 0) ||
    (result.scope_type !== 'author' && result.scope_type !== 'group')
  ) {
    return null
  }

  const actorId = canonicalUuid(result.actor_id)
  const postId = canonicalUuid(result.post_id)
  const authorId = canonicalUuid(result.author_id)
  const groupId = result.group_id === null ? null : canonicalUuid(result.group_id)
  const scopeId = canonicalUuid(result.scope_id)
  if (
    !actorId ||
    !postId ||
    !authorId ||
    !scopeId ||
    (result.group_id !== null && !groupId) ||
    (result.scope_type === 'group' && (groupId === null || scopeId !== groupId)) ||
    (result.scope_type === 'author' && (groupId !== null || scopeId !== authorId))
  ) {
    return null
  }

  return {
    success: true,
    actorId,
    postId,
    authorId,
    groupId,
    scopeType: result.scope_type,
    scopeId,
    isPinned: result.is_pinned,
    alreadySet: result.already_set,
    unpinnedCount: result.unpinned_count,
  }
}

function databaseErrorResponse(error: { code?: string } | null) {
  switch (error?.code) {
    case '22023':
      return NextResponse.json({ success: false, error: 'Invalid pin request' }, { status: 400 })
    case '42501':
      return NextResponse.json(
        { success: false, error: 'No permission to pin this post' },
        { status: 403 }
      )
    case '40001':
    case '40P01':
    case '55P03':
      return NextResponse.json(
        { success: false, error: 'Pin state changed; retry' },
        { status: 409 }
      )
    default:
      return NextResponse.json(
        { success: false, error: 'Failed to update pin state' },
        { status: 500 }
      )
  }
}

function denialResponse(reason: string) {
  switch (reason) {
    case 'INVALID':
      return NextResponse.json({ success: false, error: 'Invalid pin request' }, { status: 400 })
    case 'ACTOR_UNAVAILABLE':
    case 'PERMISSION_DENIED':
      return NextResponse.json(
        { success: false, error: 'No permission to pin this post' },
        { status: 403 }
      )
    case 'POST_NOT_FOUND':
      return NextResponse.json({ success: false, error: 'Post not found' }, { status: 404 })
    default:
      return NextResponse.json(
        { success: false, error: 'Failed to update pin state' },
        { status: 500 }
      )
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const parsedPostId = PostIdSchema.safeParse((await context.params).id)
  if (!parsedPostId.success) {
    return NextResponse.json({ success: false, error: 'Invalid post ID' }, { status: 400 })
  }

  const handler = withAuth(
    async ({ user, supabase }) => {
      let rawBody: unknown
      try {
        rawBody = await request.json()
      } catch {
        return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
      }

      const parsedBody = BodySchema.safeParse(rawBody)
      if (!parsedBody.success) {
        return NextResponse.json({ success: false, error: 'Invalid pin state' }, { status: 400 })
      }

      const actorId = user.id.toLowerCase()
      const postId = parsedPostId.data
      const desiredState = parsedBody.data.is_pinned
      const { data, error } = await supabase.rpc('set_post_pin_state_atomic', {
        p_actor_id: actorId,
        p_post_id: postId,
        p_is_pinned: desiredState,
      })

      if (error) {
        logger.error('[post-pin] Atomic pin state failed', {
          actorId,
          postId,
          desiredState,
          code: error.code,
        })
        return databaseErrorResponse(error)
      }

      const acknowledgement = readAtomicAcknowledgement(data)
      if (!acknowledgement) {
        logger.error('[post-pin] Atomic pin state returned an invalid acknowledgement', {
          actorId,
          postId,
          desiredState,
        })
        return NextResponse.json(
          { success: false, error: 'Failed to update pin state' },
          { status: 500 }
        )
      }

      if (!acknowledgement.success) return denialResponse(acknowledgement.reason)

      if (
        acknowledgement.actorId !== actorId ||
        acknowledgement.postId !== postId ||
        acknowledgement.isPinned !== desiredState
      ) {
        logger.error('[post-pin] Atomic acknowledgement contradicted its request', {
          actorId,
          postId,
          desiredState,
        })
        return NextResponse.json(
          { success: false, error: 'Failed to update pin state' },
          { status: 500 }
        )
      }

      return NextResponse.json({
        success: true,
        data: {
          post_id: acknowledgement.postId,
          author_id: acknowledgement.authorId,
          group_id: acknowledgement.groupId,
          scope_type: acknowledgement.scopeType,
          scope_id: acknowledgement.scopeId,
          is_pinned: acknowledgement.isPinned,
          already_set: acknowledgement.alreadySet,
          unpinned_count: acknowledgement.unpinnedCount,
          message: acknowledgement.isPinned ? 'Pinned' : 'Unpinned',
        },
      })
    },
    { name: 'posts-pin', rateLimit: 'sensitive' }
  )

  return handler(request)
}
