import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import logger from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import type { Database } from '@/lib/supabase/database.types'

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const MAX_RECIPIENTS = 500
const CanonicalUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const NormalizedTitleSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .refine((value) => value.length <= 50)
const NormalizedMessageSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .refine((value) => value.length >= 1 && value.length <= 500)
const BroadcastInputSchema = z
  .object({
    operation_id: CanonicalUuidSchema,
    title: NormalizedTitleSchema.optional(),
    message: NormalizedMessageSchema,
    target_user_ids: z.array(CanonicalUuidSchema).min(1).max(MAX_RECIPIENTS).optional(),
  })
  .strict()
const SkipReasonsSchema = z.record(z.string().min(1).max(64), z.number().int().positive())
const BroadcastSuccessSchema = z
  .object({
    success: z.literal(true),
    operation_id: CanonicalUuidSchema,
    actor_id: CanonicalUuidSchema,
    group_id: CanonicalUuidSchema,
    target_scope: z.enum(['all', 'explicit']),
    notified: z.number().int().min(1).max(MAX_RECIPIENTS),
    total: z.number().int().min(1).max(MAX_RECIPIENTS),
    failed: z.literal(0),
    dm_delivered: z.number().int().min(0).max(MAX_RECIPIENTS),
    dm_skipped: z.number().int().min(0).max(MAX_RECIPIENTS),
    dm_skip_reasons: SkipReasonsSchema,
    applied: z.boolean(),
  })
  .strict()
const BroadcastFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum([
      'INVALID',
      'INVALID_TARGETS',
      'ACTOR_UNAVAILABLE',
      'GROUP_NOT_FOUND',
      'GROUP_DISSOLVED',
      'PERMISSION_DENIED',
      'NO_RECIPIENTS',
      'TOO_MANY_RECIPIENTS',
      'OPERATION_CONFLICT',
    ]),
  })
  .strict()
const BroadcastResultSchema = z.discriminatedUnion('success', [
  BroadcastSuccessSchema,
  BroadcastFailureSchema,
])

type BroadcastInput = z.infer<typeof BroadcastInputSchema>
type BroadcastSuccess = z.infer<typeof BroadcastSuccessSchema>
type BroadcastFailure = z.infer<typeof BroadcastFailureSchema>

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

function extractGroupId(url: string): string | null {
  const pathParts = new URL(url).pathname.split('/')
  const index = pathParts.indexOf('groups')
  return index >= 0 ? (pathParts[index + 1] ?? null) : null
}

function canonicalTargets(input: BroadcastInput, actorId: string): string[] | null {
  if (!input.target_user_ids) return null
  const sorted = [...input.target_user_ids].sort()
  if (sorted.includes(actorId)) return null
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) return null
  }
  return sorted
}

function matchesSuccess(
  result: BroadcastSuccess,
  request: {
    actorId: string
    groupId: string
    operationId: string
    targetScope: 'all' | 'explicit'
  }
): boolean {
  const skippedByReason = Object.values(result.dm_skip_reasons).reduce(
    (sum, count) => sum + count,
    0
  )
  return (
    result.actor_id === request.actorId &&
    result.group_id === request.groupId &&
    result.operation_id === request.operationId &&
    result.target_scope === request.targetScope &&
    result.total === result.notified &&
    result.dm_delivered + result.dm_skipped === result.notified &&
    skippedByReason === result.dm_skipped
  )
}

function failureResponse(result: BroadcastFailure) {
  switch (result.reason) {
    case 'INVALID':
    case 'INVALID_TARGETS':
      return privateJson({ error: 'Invalid notification request' }, 400)
    case 'ACTOR_UNAVAILABLE':
    case 'PERMISSION_DENIED':
      return privateJson({ error: 'Permission denied' }, 403)
    case 'GROUP_NOT_FOUND':
      return privateJson({ error: 'Group not found' }, 404)
    case 'GROUP_DISSOLVED':
      return privateJson({ error: 'The group has been dissolved' }, 409)
    case 'NO_RECIPIENTS':
      return privateJson({ error: 'No members to notify' }, 400)
    case 'TOO_MANY_RECIPIENTS':
      return privateJson({ error: 'Too many members to notify at once' }, 409)
    case 'OPERATION_CONFLICT':
      return privateJson({ error: 'Operation id conflicts with another request' }, 409)
  }
}

// Group owners/admins notify members through one authorization + effects
// transaction. The RPC owns recipient eligibility, DM policy and replay.
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const parsedGroupId = CanonicalUuidSchema.safeParse(extractGroupId(request.url))
    const parsedActorId = CanonicalUuidSchema.safeParse(user.id)
    if (!parsedGroupId.success || !parsedActorId.success) {
      return privateJson({ error: 'Invalid group id' }, 400)
    }
    const groupId = parsedGroupId.data
    const actorId = parsedActorId.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return privateJson({ error: 'Invalid JSON body' }, 400)
    }

    const parsedInput = BroadcastInputSchema.safeParse(rawBody)
    if (!parsedInput.success) {
      return privateJson({ error: 'Invalid notification request' }, 400)
    }
    const input = parsedInput.data
    const targetIds = canonicalTargets(input, actorId)
    if (input.target_user_ids && !targetIds) {
      return privateJson({ error: 'Invalid notification recipients' }, 400)
    }

    const sb: SupabaseClient<Database> = supabase
    const { data, error } = await sb.rpc('broadcast_group_notification_atomic', {
      p_operation_id: input.operation_id,
      p_actor_id: actorId,
      p_group_id: groupId,
      p_title: input.title || null,
      p_message: input.message,
      p_target_user_ids: targetIds,
    })

    if (error) {
      logger.error('Atomic group notification broadcast failed', {
        code: error.code,
        actorId,
        groupId,
        operationId: input.operation_id,
      })
      return privateJson({ error: 'Failed to send notification' }, 500)
    }

    const parsedResult = BroadcastResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic group notification broadcast returned an invalid result', {
        actorId,
        groupId,
        operationId: input.operation_id,
      })
      return privateJson({ error: 'Failed to send notification' }, 500)
    }

    const result = parsedResult.data
    if (!result.success) return failureResponse(result)
    if (
      !matchesSuccess(result, {
        actorId,
        groupId,
        operationId: input.operation_id,
        targetScope: targetIds ? 'explicit' : 'all',
      })
    ) {
      logger.error('Atomic group notification acknowledgement mismatched its request', {
        actorId,
        groupId,
        operationId: input.operation_id,
      })
      return privateJson({ error: 'Failed to send notification' }, 500)
    }

    return privateJson({
      success: true,
      notified: result.notified,
      failed: 0,
      total: result.total,
      dm_delivered: result.dm_delivered,
      dm_skipped: result.dm_skipped,
      replayed: !result.applied,
    })
  },
  { name: 'groups/notify', rateLimit: 'write' }
)
