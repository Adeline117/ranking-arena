/**
 * POST /api/messages/read
 *
 * Mark live inbound messages in one conversation as read. Membership, active
 * actor state, the monotonic update, and its count/timestamp evidence are
 * owned by one database transaction.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import logger from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import type { Database } from '@/lib/supabase/database.types'

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const CanonicalUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const MarkReadInputSchema = z
  .object({
    conversationId: CanonicalUuidSchema,
  })
  .strict()
const MarkReadSuccessSchema = z
  .object({
    success: z.literal(true),
    actor_id: CanonicalUuidSchema,
    conversation_id: CanonicalUuidSchema,
    marked_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    read_at: z.string().datetime({ offset: true }),
  })
  .strict()
const MarkReadFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['NOT_FOUND', 'ACTOR_UNAVAILABLE']),
  })
  .strict()
const MarkReadResultSchema = z.discriminatedUnion('success', [
  MarkReadSuccessSchema,
  MarkReadFailureSchema,
])

type MarkReadFailure = z.infer<typeof MarkReadFailureSchema>

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

function failureResponse(result: MarkReadFailure) {
  switch (result.reason) {
    case 'NOT_FOUND':
      return privateJson({ error: 'Conversation not found' }, 404)
    case 'ACTOR_UNAVAILABLE':
      return privateJson({ error: 'Permission denied' }, 403)
  }
}

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const parsedActorId = CanonicalUuidSchema.safeParse(user.id)
    if (!parsedActorId.success) {
      return privateJson({ error: 'Permission denied' }, 403)
    }
    const actorId = parsedActorId.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return privateJson({ error: 'Invalid JSON body' }, 400)
    }

    const parsedInput = MarkReadInputSchema.safeParse(rawBody)
    if (!parsedInput.success) {
      return privateJson({ error: 'Invalid conversation id' }, 400)
    }
    const conversationId = parsedInput.data.conversationId

    const sb: SupabaseClient<Database> = supabase
    const { data, error } = await sb.rpc('mark_direct_message_conversation_read_atomic', {
      p_conversation_id: conversationId,
      p_actor_id: actorId,
    })

    if (error) {
      logger.error('Atomic direct-message conversation read failed', {
        code: error.code,
        actorId,
        conversationId,
      })
      return privateJson({ error: 'Failed to mark as read' }, 500)
    }

    const parsedResult = MarkReadResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic direct-message conversation read returned an invalid result', {
        actorId,
        conversationId,
      })
      return privateJson({ error: 'Failed to mark as read' }, 500)
    }

    const result = parsedResult.data
    if (!result.success) return failureResponse(result)
    if (result.actor_id !== actorId || result.conversation_id !== conversationId) {
      logger.error('Atomic direct-message read acknowledgement mismatched its request', {
        actorId,
        conversationId,
      })
      return privateJson({ error: 'Failed to mark as read' }, 500)
    }

    return privateJson({
      ok: true,
      marked_count: result.marked_count,
      read_at: result.read_at,
    })
  },
  { name: 'messages-read', rateLimit: 'write' }
)
