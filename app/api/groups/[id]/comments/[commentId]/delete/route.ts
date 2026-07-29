import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ id: string; commentId: string }> }

const ParamsSchema = z
  .object({
    groupId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    commentId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict()

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const denialReasons = new Set([
  'INVALID',
  'ACTOR_UNAVAILABLE',
  'GROUP_NOT_FOUND',
  'GROUP_DISSOLVED',
  'PERMISSION_DENIED',
  'COMMENT_NOT_FOUND',
  'POST_NOT_FOUND',
  'COMMENT_NOT_IN_GROUP',
])

type AtomicGroupCommentAcknowledgement =
  | { success: false; reason: string }
  | {
      success: true
      actorId: string
      affectedCount: number
      auditId: string
      commentCount: number
      commentId: string
      groupId: string
      postId: string
    }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function readAtomicAcknowledgement(value: unknown): AtomicGroupCommentAcknowledgement | null {
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
      'affected_count',
      'audit_id',
      'comment_count',
      'comment_id',
      'group_id',
      'post_id',
      'success',
    ]) ||
    !isUuid(result.actor_id) ||
    !isUuid(result.audit_id) ||
    !isUuid(result.comment_id) ||
    !isUuid(result.group_id) ||
    !isUuid(result.post_id) ||
    !isNonNegativeInteger(result.affected_count) ||
    !isNonNegativeInteger(result.comment_count)
  ) {
    return null
  }

  return {
    success: true,
    actorId: result.actor_id.toLowerCase(),
    affectedCount: result.affected_count,
    auditId: result.audit_id.toLowerCase(),
    commentCount: result.comment_count,
    commentId: result.comment_id.toLowerCase(),
    groupId: result.group_id.toLowerCase(),
    postId: result.post_id.toLowerCase(),
  }
}

function databaseErrorResponse(error: { code?: string } | null) {
  switch (error?.code) {
    case '22023':
      return NextResponse.json({ error: 'Invalid comment moderation request' }, { status: 400 })
    case '42501':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    case 'P0002':
    case '23503':
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    case '40001':
    case '40P01':
    case '55P03':
      return NextResponse.json({ error: 'Comment moderation changed; retry' }, { status: 409 })
    default:
      return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }
}

function denialResponse(reason: string) {
  switch (reason) {
    case 'INVALID':
      return NextResponse.json({ error: 'Invalid comment moderation request' }, { status: 400 })
    case 'ACTOR_UNAVAILABLE':
    case 'PERMISSION_DENIED':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    case 'GROUP_NOT_FOUND':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'COMMENT_NOT_FOUND':
    case 'POST_NOT_FOUND':
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    case 'GROUP_DISSOLVED':
      return NextResponse.json({ error: 'Group has been dissolved' }, { status: 409 })
    case 'COMMENT_NOT_IN_GROUP':
      return NextResponse.json({ error: 'Comment does not belong to this group' }, { status: 400 })
    default:
      return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }
}

// Current manager authority, group/comment binding, hard deletion and audit
// evidence are committed by one service-only transaction.
export async function POST(request: NextRequest, context: RouteContext) {
  const resolvedParams = await context.params
  const params = ParamsSchema.safeParse({
    groupId: resolvedParams.id,
    commentId: resolvedParams.commentId,
  })

  const handler = withAuth(
    async ({ user }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      if (!params.success) {
        return NextResponse.json({ error: 'Invalid group or comment ID' }, { status: 400 })
      }

      const actorId = user.id.toLowerCase()
      const { groupId, commentId } = params.data
      const { data, error } = await getSupabaseAdmin().rpc('moderate_group_comment_atomic', {
        p_actor_id: actorId,
        p_group_id: groupId,
        p_comment_id: commentId,
        p_reason: 'Deleted by group administrator',
      })

      if (error) {
        logger.error('[group-comment-delete] Atomic moderation failed', {
          actorId,
          groupId,
          commentId,
          code: error.code,
        })
        return databaseErrorResponse(error)
      }

      const acknowledgement = readAtomicAcknowledgement(data)
      if (!acknowledgement) {
        logger.error(
          '[group-comment-delete] Atomic moderation returned an invalid acknowledgement',
          {
            actorId,
            groupId,
            commentId,
          }
        )
        return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
      }

      if (!acknowledgement.success) return denialResponse(acknowledgement.reason)

      if (
        acknowledgement.actorId !== actorId ||
        acknowledgement.groupId !== groupId ||
        acknowledgement.commentId !== commentId
      ) {
        logger.error('[group-comment-delete] Atomic acknowledgement contradicted its request', {
          actorId,
          groupId,
          commentId,
        })
        return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
      }

      return NextResponse.json({
        success: true,
        affected_count: acknowledgement.affectedCount,
        comment_count: acknowledgement.commentCount,
      })
    },
    { name: 'group-comment-delete', rateLimit: 'sensitive' }
  )

  return handler(request)
}
