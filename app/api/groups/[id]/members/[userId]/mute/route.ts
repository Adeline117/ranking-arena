import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { sendNotification } from '@/lib/data/notifications'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

type RouteContext = { params: Promise<{ id: string; userId: string }> }
type MuteAction = 'mute' | 'unmute'

const ModerationIdsSchema = z
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

const MuteBodySchema = z
  .object({
    muted_until: z.string().datetime({ offset: true }),
    reason: z
      .string()
      .trim()
      .refine((value) => Array.from(value).length <= 500)
      .nullable()
      .optional(),
  })
  .strict()

const IdempotencyKeySchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const denialReasons = new Set([
  'ACTOR_UNAVAILABLE',
  'TARGET_UNAVAILABLE',
  'GROUP_NOT_FOUND',
  'GROUP_DISSOLVED',
  'ACTOR_NOT_MANAGER',
  'TARGET_NOT_MEMBER',
  'SELF_FORBIDDEN',
  'OWNER_FORBIDDEN',
  'HIERARCHY_FORBIDDEN',
])

type AtomicMuteAcknowledgement =
  | {
      success: true
      applied: boolean
      action: MuteAction
      operationId: string
      groupId: string
      targetId: string
      groupName: string
      mutedUntil: string | null
      muteReason: string | null
      mutedBy: string | null
      auditLogId: string | null
    }
  | { success: false; reason: string }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function readAtomicMuteAcknowledgement(value: unknown): AtomicMuteAcknowledgement | null {
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
      'action',
      'applied',
      'audit_log_id',
      'group_id',
      'group_name',
      'mute_reason',
      'muted_by',
      'muted_until',
      'operation_id',
      'success',
      'target_id',
    ]) ||
    typeof result.applied !== 'boolean' ||
    !['mute', 'unmute'].includes(result.action as string) ||
    typeof result.operation_id !== 'string' ||
    !UUID_PATTERN.test(result.operation_id) ||
    typeof result.group_id !== 'string' ||
    !UUID_PATTERN.test(result.group_id) ||
    typeof result.target_id !== 'string' ||
    !UUID_PATTERN.test(result.target_id) ||
    typeof result.group_name !== 'string' ||
    result.group_name.length === 0 ||
    (result.muted_until !== null && !isTimestamp(result.muted_until)) ||
    (result.mute_reason !== null && typeof result.mute_reason !== 'string') ||
    (result.muted_by !== null &&
      (typeof result.muted_by !== 'string' || !UUID_PATTERN.test(result.muted_by))) ||
    (result.audit_log_id !== null &&
      (typeof result.audit_log_id !== 'string' || !UUID_PATTERN.test(result.audit_log_id))) ||
    (result.applied ? result.audit_log_id === null : result.audit_log_id !== null)
  ) {
    return null
  }

  return {
    success: true,
    applied: result.applied,
    action: result.action as MuteAction,
    operationId: (result.operation_id as string).toLowerCase(),
    groupId: (result.group_id as string).toLowerCase(),
    targetId: (result.target_id as string).toLowerCase(),
    groupName: result.group_name,
    mutedUntil: result.muted_until as string | null,
    muteReason: result.mute_reason as string | null,
    mutedBy: result.muted_by === null ? null : (result.muted_by as string).toLowerCase(),
    auditLogId: result.audit_log_id === null ? null : (result.audit_log_id as string).toLowerCase(),
  }
}

function databaseErrorResponse(error: { code?: string } | null) {
  switch (error?.code) {
    case '22023':
      return NextResponse.json({ error: 'Invalid mute request' }, { status: 400 })
    case '42501':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    case 'P0002':
      return NextResponse.json({ error: 'Group member not found' }, { status: 404 })
    case '40001':
    case '40P01':
    case '55P03':
      return NextResponse.json({ error: 'Group membership changed; retry' }, { status: 409 })
    default:
      return NextResponse.json({ error: 'Mute operation failed' }, { status: 500 })
  }
}

function denialResponse(reason: string) {
  switch (reason) {
    case 'GROUP_NOT_FOUND':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'TARGET_UNAVAILABLE':
    case 'TARGET_NOT_MEMBER':
      return NextResponse.json({ error: 'Target user is not a group member' }, { status: 404 })
    case 'GROUP_DISSOLVED':
      return NextResponse.json({ error: 'Group has been dissolved' }, { status: 409 })
    case 'SELF_FORBIDDEN':
      return NextResponse.json({ error: 'Cannot mute yourself' }, { status: 400 })
    case 'OWNER_FORBIDDEN':
    case 'HIERARCHY_FORBIDDEN':
      return NextResponse.json({ error: 'No permission to mute this user' }, { status: 403 })
    case 'ACTOR_UNAVAILABLE':
    case 'ACTOR_NOT_MANAGER':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    default:
      return NextResponse.json({ error: 'Mute operation failed' }, { status: 500 })
  }
}

function muteDurationText(mutedUntil: string): string {
  const diffHours = Math.round((Date.parse(mutedUntil) - Date.now()) / (60 * 60 * 1000))
  if (diffHours <= 4) return '3 hours'
  if (diffHours <= 25) return '1 day'
  if (diffHours <= 170) return '7 days'
  return 'permanently'
}

async function moderateMute(input: {
  actorId: string
  operationId: string
  groupId: string
  targetUserId: string
  action: MuteAction
  mutedUntil: string | null
  reason: string | null
}): Promise<AtomicMuteAcknowledgement | NextResponse> {
  const admin = getSupabaseAdmin()
  const { data, error } = await admin.rpc(
    'moderate_group_mute_atomic' as never,
    {
      p_actor_id: input.actorId,
      p_operation_id: input.operationId,
      p_group_id: input.groupId,
      p_target_id: input.targetUserId,
      p_action: input.action,
      p_muted_until: input.mutedUntil,
      p_reason: input.reason,
    } as never
  )

  if (error) {
    logger.error('Atomic group mute operation failed', {
      action: input.action,
      groupId: input.groupId,
      targetUserId: input.targetUserId,
      code: error.code,
    })
    return databaseErrorResponse(error)
  }

  const acknowledgement = readAtomicMuteAcknowledgement(data)
  if (!acknowledgement) {
    logger.error('Atomic group mute operation returned an invalid acknowledgement', {
      action: input.action,
      groupId: input.groupId,
      targetUserId: input.targetUserId,
    })
    return NextResponse.json({ error: 'Mute operation failed' }, { status: 500 })
  }

  if (!acknowledgement.success) return acknowledgement

  const sameTimestamp =
    input.mutedUntil === null
      ? acknowledgement.mutedUntil === null
      : acknowledgement.mutedUntil !== null &&
        Date.parse(acknowledgement.mutedUntil) === Date.parse(input.mutedUntil)
  if (
    acknowledgement.action !== input.action ||
    acknowledgement.operationId !== input.operationId ||
    acknowledgement.groupId !== input.groupId ||
    acknowledgement.targetId !== input.targetUserId ||
    !sameTimestamp ||
    acknowledgement.muteReason !== input.reason ||
    acknowledgement.mutedBy !== (input.action === 'mute' ? input.actorId : null)
  ) {
    logger.error('Atomic group mute acknowledgement did not match its request', {
      action: input.action,
      groupId: input.groupId,
      targetUserId: input.targetUserId,
    })
    return NextResponse.json({ error: 'Mute operation failed' }, { status: 500 })
  }

  return acknowledgement
}

export async function POST(request: NextRequest, context: RouteContext) {
  const resolvedParams = await context.params
  const params = ModerationIdsSchema.safeParse({
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

      const operationId = IdempotencyKeySchema.safeParse(req.headers.get('Idempotency-Key'))
      if (!operationId.success) {
        return NextResponse.json({ error: 'Invalid idempotency key' }, { status: 400 })
      }

      let body: unknown
      try {
        body = await req.json()
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
      const parsedBody = MuteBodySchema.safeParse(body)
      if (!parsedBody.success) {
        return NextResponse.json({ error: 'Invalid mute request' }, { status: 400 })
      }

      const mutedUntil = new Date(parsedBody.data.muted_until).toISOString()
      const actorId = user.id.toLowerCase()
      const reason = parsedBody.data.reason || null
      const result = await moderateMute({
        actorId,
        operationId: operationId.data,
        groupId: params.data.groupId,
        targetUserId: params.data.targetUserId,
        action: 'mute',
        mutedUntil,
        reason,
      })
      if (result instanceof NextResponse) return result
      if (!result.success) return denialResponse(result.reason)

      if (result.applied && result.mutedUntil) {
        const reasonText = result.muteReason ? `\nReason: ${result.muteReason}` : ''
        const message = `You have been muted in "${result.groupName}" for ${muteDurationText(result.mutedUntil)}. ${reasonText}`
        sendNotification(
          getSupabaseAdmin(),
          {
            user_id: result.targetId,
            type: 'system',
            title: 'Group mute notification',
            message,
            link: `/groups/${result.groupId}`,
            actor_id: actorId,
            reference_id: result.groupId,
          },
          'group-mute'
        )
      }

      return NextResponse.json({
        success: true,
        operation_id: operationId.data,
        ...(result.applied ? {} : { already_muted: true }),
      })
    },
    { name: 'group-member-mute', rateLimit: 'write' }
  )

  return handler(request)
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const resolvedParams = await context.params
  const params = ModerationIdsSchema.safeParse({
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

      const operationId = IdempotencyKeySchema.safeParse(req.headers.get('Idempotency-Key'))
      if (!operationId.success) {
        return NextResponse.json({ error: 'Invalid idempotency key' }, { status: 400 })
      }

      const result = await moderateMute({
        actorId: user.id.toLowerCase(),
        operationId: operationId.data,
        groupId: params.data.groupId,
        targetUserId: params.data.targetUserId,
        action: 'unmute',
        mutedUntil: null,
        reason: null,
      })
      if (result instanceof NextResponse) return result
      if (!result.success) return denialResponse(result.reason)

      return NextResponse.json({
        success: true,
        operation_id: operationId.data,
        ...(result.applied ? {} : { already_unmuted: true }),
      })
    },
    { name: 'group-member-unmute', rateLimit: 'write' }
  )

  return handler(request)
}
