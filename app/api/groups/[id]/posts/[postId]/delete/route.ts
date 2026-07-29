import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { sendNotification } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ id: string; postId: string }> }

const ParamsSchema = z
  .object({
    groupId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    postId: z
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
  'POST_NOT_FOUND',
  'POST_NOT_IN_GROUP',
  'POST_ALREADY_DELETED',
])

type AtomicGroupPostAcknowledgement =
  | { success: false; reason: string }
  | {
      success: true
      actorId: string
      auditId: string
      authorId: string | null
      deletedAt: string
      groupId: string
      postId: string
      title: string | null
    }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function readAtomicAcknowledgement(value: unknown): AtomicGroupPostAcknowledgement | null {
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
      'audit_id',
      'author_id',
      'deleted_at',
      'group_id',
      'post_id',
      'success',
      'title',
    ]) ||
    !isUuid(result.actor_id) ||
    !isUuid(result.audit_id) ||
    (result.author_id !== null && !isUuid(result.author_id)) ||
    !isTimestamp(result.deleted_at) ||
    !isUuid(result.group_id) ||
    !isUuid(result.post_id) ||
    (result.title !== null && typeof result.title !== 'string')
  ) {
    return null
  }

  return {
    success: true,
    actorId: result.actor_id.toLowerCase(),
    auditId: result.audit_id.toLowerCase(),
    authorId: result.author_id === null ? null : result.author_id.toLowerCase(),
    deletedAt: result.deleted_at,
    groupId: result.group_id.toLowerCase(),
    postId: result.post_id.toLowerCase(),
    title: result.title,
  }
}

function databaseErrorResponse(error: { code?: string } | null) {
  switch (error?.code) {
    case '22023':
      return NextResponse.json({ error: 'Invalid post moderation request' }, { status: 400 })
    case '42501':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    case 'P0002':
    case '23503':
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    case '40001':
    case '40P01':
    case '55P03':
      return NextResponse.json({ error: 'Post moderation changed; retry' }, { status: 409 })
    default:
      return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }
}

function denialResponse(reason: string) {
  switch (reason) {
    case 'INVALID':
      return NextResponse.json({ error: 'Invalid post moderation request' }, { status: 400 })
    case 'ACTOR_UNAVAILABLE':
    case 'PERMISSION_DENIED':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    case 'GROUP_NOT_FOUND':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'POST_NOT_FOUND':
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    case 'GROUP_DISSOLVED':
      return NextResponse.json({ error: 'Group has been dissolved' }, { status: 409 })
    case 'POST_NOT_IN_GROUP':
      return NextResponse.json({ error: 'Post does not belong to this group' }, { status: 400 })
    case 'POST_ALREADY_DELETED':
      return NextResponse.json({ error: 'Post has been deleted' }, { status: 400 })
    default:
      return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }
}

// Current manager authority, group/post binding, soft deletion and audit
// evidence are committed by one service-only transaction.
export async function POST(request: NextRequest, context: RouteContext) {
  const resolvedParams = await context.params
  const params = ParamsSchema.safeParse({
    groupId: resolvedParams.id,
    postId: resolvedParams.postId,
  })

  const handler = withAuth(
    async ({ user }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      if (!params.success) {
        return NextResponse.json({ error: 'Invalid group or post ID' }, { status: 400 })
      }

      const actorId = user.id.toLowerCase()
      const { groupId, postId } = params.data
      const admin = getSupabaseAdmin()
      const { data, error } = await admin.rpc('moderate_group_post_atomic', {
        p_actor_id: actorId,
        p_group_id: groupId,
        p_post_id: postId,
        p_reason: 'Deleted by admin',
      })

      if (error) {
        logger.error('[group-post-delete] Atomic moderation failed', {
          actorId,
          groupId,
          postId,
          code: error.code,
        })
        return databaseErrorResponse(error)
      }

      const acknowledgement = readAtomicAcknowledgement(data)
      if (!acknowledgement) {
        logger.error('[group-post-delete] Atomic moderation returned an invalid acknowledgement', {
          actorId,
          groupId,
          postId,
        })
        return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
      }

      if (!acknowledgement.success) return denialResponse(acknowledgement.reason)

      if (
        acknowledgement.actorId !== actorId ||
        acknowledgement.groupId !== groupId ||
        acknowledgement.postId !== postId
      ) {
        logger.error('[group-post-delete] Atomic acknowledgement contradicted its request', {
          actorId,
          groupId,
          postId,
        })
        return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
      }

      if (acknowledgement.authorId && acknowledgement.authorId !== actorId) {
        sendNotification(
          admin,
          {
            user_id: acknowledgement.authorId,
            type: 'system',
            title: 'Post deleted',
            message: `Your post "${acknowledgement.title || ''}" was deleted by group admin`,
            link: `/groups/${groupId}`,
            actor_id: actorId,
            reference_id: postId,
          },
          'group-post-delete'
        )
      }

      return NextResponse.json({ success: true })
    },
    { name: 'group-post-delete', rateLimit: 'sensitive' }
  )

  return handler(request)
}
