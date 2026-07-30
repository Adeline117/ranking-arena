/**
 * POST /api/messages/start
 *
 * One database RPC owns account admission, DM permission/privacy, canonical
 * conversation get-or-create, and the identity-bound acknowledgement. A
 * separate operation ledger is unnecessary because the ordered user pair is
 * itself a unique, naturally idempotent resource.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import logger from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import type { Database } from '@/lib/supabase/database.types'
import { traceMessage } from '@/lib/utils/logger'

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const CanonicalUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const StartConversationInputSchema = z
  .object({
    receiverId: CanonicalUuidSchema,
  })
  .strict()
const AvailableMessageLimitSchema = z
  .object({
    reached: z.literal(false),
    sent: z.number().int().min(0).max(2),
    max: z.literal(3),
  })
  .strict()
const ReachedMessageLimitSchema = z
  .object({
    reached: z.literal(true),
    sent: z.number().int().min(3),
    max: z.literal(3),
  })
  .strict()
const MessageLimitSchema = z.discriminatedUnion('reached', [
  AvailableMessageLimitSchema,
  ReachedMessageLimitSchema,
])
const StartConversationSuccessSchema = z
  .object({
    success: z.literal(true),
    sender_id: CanonicalUuidSchema,
    receiver_id: CanonicalUuidSchema,
    conversation_id: CanonicalUuidSchema,
    receiver_handle: z.string().min(1),
    can_message: z.boolean(),
    is_mutual_follow: z.boolean(),
    message_limit: MessageLimitSchema.nullable(),
    created: z.boolean(),
  })
  .strict()
  .superRefine((result, context) => {
    const expectedCanMessage = result.message_limit?.reached !== true
    if (
      result.sender_id === result.receiver_id ||
      result.can_message !== expectedCanMessage ||
      (result.is_mutual_follow && result.message_limit !== null) ||
      (!result.can_message && result.is_mutual_follow) ||
      (result.created && !result.can_message)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Inconsistent direct-message conversation acknowledgement',
      })
    }
  })
const StartConversationFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['SENDER_UNAVAILABLE', 'USER_NOT_FOUND', 'BLOCKED', 'DM_DISABLED']),
  })
  .strict()
const StartConversationResultSchema = z.discriminatedUnion('success', [
  StartConversationSuccessSchema,
  StartConversationFailureSchema,
])

type StartConversationSuccess = z.infer<typeof StartConversationSuccessSchema>
type StartConversationFailure = z.infer<typeof StartConversationFailureSchema>

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

function failureResponse(result: StartConversationFailure) {
  switch (result.reason) {
    case 'DM_DISABLED':
      return privateJson(
        {
          error: 'This user has disabled direct messages',
          error_code: 'PERMISSION_DENIED',
        },
        403
      )
    case 'USER_NOT_FOUND':
      return privateJson({ error: 'User not found' }, 404)
    case 'SENDER_UNAVAILABLE':
    case 'BLOCKED':
      return privateJson({ error: 'Permission denied', error_code: 'PERMISSION_DENIED' }, 403)
  }
}

function matchesRequest(
  result: StartConversationSuccess,
  senderId: string,
  receiverId: string
): boolean {
  return result.sender_id === senderId && result.receiver_id === receiverId
}

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const parsedSenderId = CanonicalUuidSchema.safeParse(user.id)
    if (!parsedSenderId.success) {
      return privateJson({ error: 'Permission denied', error_code: 'PERMISSION_DENIED' }, 403)
    }
    const senderId = parsedSenderId.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return privateJson({ error: 'Invalid JSON body', error_code: 'VALIDATION_ERROR' }, 400)
    }

    const parsedInput = StartConversationInputSchema.safeParse(rawBody)
    if (!parsedInput.success) {
      return privateJson({ error: 'Invalid input', error_code: 'VALIDATION_ERROR' }, 400)
    }
    const receiverId = parsedInput.data.receiverId

    if (senderId === receiverId) {
      return privateJson(
        { error: 'Cannot send message to yourself', error_code: 'VALIDATION_ERROR' },
        400
      )
    }

    const sb: SupabaseClient<Database> = supabase
    const { data, error } = await sb.rpc('start_direct_message_conversation_atomic', {
      p_sender_id: senderId,
      p_receiver_id: receiverId,
    })

    if (error) {
      logger.error('Atomic direct-message conversation start failed', {
        code: error.code,
        senderId,
        receiverId,
      })
      return privateJson({ error: 'Failed to start conversation' }, 500)
    }

    const parsedResult = StartConversationResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic direct-message conversation start returned an invalid result', {
        senderId,
        receiverId,
      })
      return privateJson({ error: 'Failed to start conversation' }, 500)
    }

    const result = parsedResult.data
    if (!result.success) return failureResponse(result)
    if (!matchesRequest(result, senderId, receiverId)) {
      logger.error('Atomic direct-message conversation acknowledgement mismatched its request', {
        senderId,
        receiverId,
      })
      return privateJson({ error: 'Failed to start conversation' }, 500)
    }

    traceMessage({
      event: 'conversation_created',
      conversationId: result.conversation_id,
      senderId,
      receiverId,
      metadata: {
        created: result.created,
        isMutualFollow: result.is_mutual_follow,
      },
    })

    return privateJson({
      conversation_id: result.conversation_id,
      sender_id: result.sender_id,
      receiver_id: result.receiver_id,
      can_message: result.can_message,
      is_mutual_follow: result.is_mutual_follow,
      message_limit: result.message_limit,
      receiver_handle: result.receiver_handle,
    })
  },
  { name: 'messages-start', rateLimit: 'write' }
)
