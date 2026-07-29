import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ id: string; userId: string }> }
type MemberRole = 'admin' | 'member'

const ParamsSchema = z
  .object({
    groupId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    targetUserId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict()

const BodySchema = z.object({ role: z.enum(['admin', 'member']) }).strict()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const denialReasons = new Set([
  'INVALID',
  'ACTOR_UNAVAILABLE',
  'TARGET_UNAVAILABLE',
  'GROUP_NOT_FOUND',
  'GROUP_DISSOLVED',
  'PERMISSION_DENIED',
  'TARGET_NOT_MEMBER',
  'OWNER_FORBIDDEN',
])

type AtomicRoleAcknowledgement =
  | { success: false; reason: string }
  | {
      success: true
      actorId: string
      auditId: string | null
      changed: boolean
      groupId: string
      previousRole: MemberRole
      role: MemberRole
      targetId: string
    }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isMemberRole(value: unknown): value is MemberRole {
  return value === 'admin' || value === 'member'
}

function readAtomicRoleAcknowledgement(value: unknown): AtomicRoleAcknowledgement | null {
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
      'changed',
      'group_id',
      'previous_role',
      'role',
      'success',
      'target_id',
    ]) ||
    !isUuid(result.actor_id) ||
    !isUuid(result.group_id) ||
    !isUuid(result.target_id) ||
    !isMemberRole(result.previous_role) ||
    !isMemberRole(result.role) ||
    typeof result.changed !== 'boolean' ||
    (result.audit_id !== null && !isUuid(result.audit_id)) ||
    (result.changed && (result.audit_id === null || result.previous_role === result.role)) ||
    (!result.changed && (result.audit_id !== null || result.previous_role !== result.role))
  ) {
    return null
  }

  return {
    success: true,
    actorId: result.actor_id.toLowerCase(),
    auditId: result.audit_id === null ? null : result.audit_id.toLowerCase(),
    changed: result.changed,
    groupId: result.group_id.toLowerCase(),
    previousRole: result.previous_role,
    role: result.role,
    targetId: result.target_id.toLowerCase(),
  }
}

function databaseErrorResponse(error: { code?: string } | null) {
  switch (error?.code) {
    case '22023':
      return NextResponse.json({ error: 'Invalid role request' }, { status: 400 })
    case '42501':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    case '40001':
    case '40P01':
    case '55P03':
      return NextResponse.json({ error: 'Group membership changed; retry' }, { status: 409 })
    default:
      return NextResponse.json({ error: 'Failed to set role' }, { status: 500 })
  }
}

function denialResponse(reason: string) {
  switch (reason) {
    case 'INVALID':
      return NextResponse.json({ error: 'Invalid role request' }, { status: 400 })
    case 'GROUP_NOT_FOUND':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'TARGET_UNAVAILABLE':
    case 'TARGET_NOT_MEMBER':
      return NextResponse.json({ error: 'Target user is not a group member' }, { status: 404 })
    case 'GROUP_DISSOLVED':
      return NextResponse.json({ error: 'Group has been dissolved' }, { status: 409 })
    case 'OWNER_FORBIDDEN':
      return NextResponse.json({ error: 'Cannot change the owner role' }, { status: 400 })
    case 'ACTOR_UNAVAILABLE':
    case 'PERMISSION_DENIED':
      return NextResponse.json(
        { error: 'Only the group owner can set member roles' },
        { status: 403 }
      )
    default:
      return NextResponse.json({ error: 'Failed to set role' }, { status: 500 })
  }
}

// Authorization, target binding, role mutation and audit evidence are committed
// by one service-only transaction. This route never writes group_members itself.
export async function POST(request: NextRequest, context: RouteContext) {
  const resolvedParams = await context.params
  const params = ParamsSchema.safeParse({
    groupId: resolvedParams.id,
    targetUserId: resolvedParams.userId,
  })

  const handler = withAuth(
    async ({ user, request: req }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      if (!params.success) {
        return NextResponse.json({ error: 'Invalid group or user ID' }, { status: 400 })
      }

      let rawBody: unknown
      try {
        rawBody = await req.json()
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }

      const body = BodySchema.safeParse(rawBody)
      if (!body.success) {
        return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
      }

      const actorId = user.id.toLowerCase()
      const { groupId, targetUserId } = params.data
      if (targetUserId === actorId) {
        return NextResponse.json({ error: 'Cannot change your own role' }, { status: 400 })
      }

      const { data, error } = await getSupabaseAdmin().rpc('set_group_member_role_atomic', {
        p_actor_id: actorId,
        p_group_id: groupId,
        p_target_id: targetUserId,
        p_role: body.data.role,
      })

      if (error) {
        logger.error('[group-member-role] Atomic role change failed', {
          actorId,
          groupId,
          targetUserId,
          code: error.code,
        })
        return databaseErrorResponse(error)
      }

      const acknowledgement = readAtomicRoleAcknowledgement(data)
      if (!acknowledgement) {
        logger.error('[group-member-role] Atomic role change returned an invalid acknowledgement', {
          actorId,
          groupId,
          targetUserId,
        })
        return NextResponse.json({ error: 'Failed to set role' }, { status: 500 })
      }

      if (!acknowledgement.success) return denialResponse(acknowledgement.reason)

      if (
        acknowledgement.actorId !== actorId ||
        acknowledgement.groupId !== groupId ||
        acknowledgement.targetId !== targetUserId ||
        acknowledgement.role !== body.data.role
      ) {
        logger.error('[group-member-role] Atomic role acknowledgement contradicted its request', {
          actorId,
          groupId,
          targetUserId,
        })
        return NextResponse.json({ error: 'Failed to set role' }, { status: 500 })
      }

      return NextResponse.json({ success: true, role: acknowledgement.role })
    },
    { name: 'group-member-role', rateLimit: 'write' }
  )

  return handler(request)
}
