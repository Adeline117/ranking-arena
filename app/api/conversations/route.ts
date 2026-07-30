/**
 * Direct-message inbox API.
 *
 * SECURITY: The actor comes only from the authenticated session. One
 * service-only RPC returns the sorted conversation window, profiles, settings,
 * previews, and unread counts from one database snapshot.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'

export const dynamic = 'force-dynamic'

const LIST_LIMIT = 50
const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const UuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]?.length ?? 0) <= 6)

const MemberSettingsSchema = z
  .object({
    remark: z.string().nullable(),
    is_muted: z.boolean(),
    is_pinned: z.boolean(),
    is_blocked: z.boolean(),
  })
  .strict()

const ConversationSchema = z
  .object({
    id: UuidSchema,
    other_user: z
      .object({
        id: UuidSchema,
        handle: z.string().nullable(),
        avatar_url: z.string().nullable(),
        bio: z.string().nullable(),
      })
      .strict(),
    last_message_at: TimestampSchema,
    last_message_preview: z.string().max(100).nullable(),
    unread_count: z.number().int().nonnegative(),
    created_at: TimestampSchema.nullable(),
    member_settings: MemberSettingsSchema.nullable(),
  })
  .strict()

const ConversationListSuccessSchema = z
  .object({
    success: z.literal(true),
    actor_id: UuidSchema,
    limit: z.literal(LIST_LIMIT),
    conversations: z.array(ConversationSchema).max(LIST_LIMIT),
  })
  .strict()

const ConversationListFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['INVALID', 'ACTOR_UNAVAILABLE']),
  })
  .strict()

type ConversationListAcknowledgement =
  | z.infer<typeof ConversationListSuccessSchema>
  | z.infer<typeof ConversationListFailureSchema>

function timestampMicros(value: string): number | null {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ''
  if (fraction.length > 6) return null
  const microsWithinMillisecond = Number(fraction.padEnd(6, '0').slice(3, 6))
  return milliseconds * 1000 + microsWithinMillisecond
}

function readAcknowledgement(value: unknown): ConversationListAcknowledgement | null {
  const failure = ConversationListFailureSchema.safeParse(value)
  if (failure.success) return failure.data

  const success = ConversationListSuccessSchema.safeParse(value)
  return success.success ? success.data : null
}

function acknowledgementMatchesActor(
  acknowledgement: z.infer<typeof ConversationListSuccessSchema>,
  actorId: string
): boolean {
  if (acknowledgement.actor_id !== actorId || acknowledgement.limit !== LIST_LIMIT) return false

  const conversationIds = new Set<string>()
  const counterpartyIds = new Set<string>()

  for (let index = 0; index < acknowledgement.conversations.length; index += 1) {
    const conversation = acknowledgement.conversations[index]
    if (
      !conversation ||
      conversationIds.has(conversation.id) ||
      counterpartyIds.has(conversation.other_user.id) ||
      conversation.other_user.id === actorId
    ) {
      return false
    }
    conversationIds.add(conversation.id)
    counterpartyIds.add(conversation.other_user.id)

    if (
      conversation.other_user.handle === null &&
      (conversation.other_user.avatar_url !== null || conversation.other_user.bio !== null)
    ) {
      return false
    }

    const currentTime = timestampMicros(conversation.last_message_at)
    if (currentTime === null) return false

    const previous = acknowledgement.conversations[index - 1]
    if (!previous) continue

    const previousPinned = previous.member_settings?.is_pinned ?? false
    const currentPinned = conversation.member_settings?.is_pinned ?? false
    if (!previousPinned && currentPinned) return false
    if (previousPinned !== currentPinned) continue

    const previousTime = timestampMicros(previous.last_message_at)
    if (
      previousTime === null ||
      previousTime < currentTime ||
      (previousTime === currentTime && previous.id >= conversation.id)
    ) {
      return false
    }
  }

  return true
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

export const GET = withAuth(
  async ({ user, supabase }) => {
    const actor = z.string().uuid().safeParse(user.id)
    if (!actor.success) return json({ error: 'Failed to fetch conversations' }, 500)

    const actorId = actor.data.toLowerCase()
    const { data, error } = await supabase.rpc('get_direct_message_conversation_list_atomic', {
      p_actor_id: actorId,
      p_limit: LIST_LIMIT,
    })

    if (error) return json({ error: 'Failed to fetch conversations' }, 500)

    const acknowledgement = readAcknowledgement(data)
    if (!acknowledgement) return json({ error: 'Failed to fetch conversations' }, 500)

    if (!acknowledgement.success) {
      if (acknowledgement.reason === 'ACTOR_UNAVAILABLE') {
        return json({ error: 'No permission to access conversations' }, 403)
      }
      return json({ error: 'Failed to fetch conversations' }, 500)
    }

    if (!acknowledgementMatchesActor(acknowledgement, actorId)) {
      return json({ error: 'Failed to fetch conversations' }, 500)
    }

    return json({ conversations: acknowledgement.conversations })
  },
  { rateLimit: 'authenticated', name: 'conversations' }
)
