/**
 * Atomic direct-message history search.
 *
 * The authenticated actor, membership, clear boundary, live messages, and
 * total pagination cursor are bound by one service-only database authority.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('chat-search')

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const UuidSchema = z.string().uuid()
const TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]?.length ?? 0) <= 6)

const SearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .optional(),
    cursor: TimestampSchema.optional(),
    cursorId: UuidSchema.optional(),
    from: TimestampSchema.optional(),
    to: TimestampSchema.optional(),
  })
  .strict()
  .refine((value) => (value.cursor === undefined) === (value.cursorId === undefined), {
    message: 'Both cursor fields are required',
  })
  .refine(
    (value) => {
      if (value.from === undefined || value.to === undefined) return true
      const from = timestampMicros(value.from)
      const to = timestampMicros(value.to)
      return from !== null && to !== null && from <= to
    },
    { message: 'Invalid date range' }
  )

const SearchMessageSchema = z
  .object({
    id: UuidSchema,
    sender_id: UuidSchema,
    content: z.string(),
    created_at: TimestampSchema,
  })
  .strict()

const SearchFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['INVALID', 'NOT_FOUND', 'ACTOR_UNAVAILABLE', 'PARTICIPANT_UNAVAILABLE']),
  })
  .strict()

const SearchSuccessSchema = z
  .object({
    success: z.literal(true),
    actor_id: UuidSchema,
    conversation_id: UuidSchema,
    query: z.string().min(1).max(100),
    from_created_at: TimestampSchema.nullable(),
    to_created_at: TimestampSchema.nullable(),
    messages: z.array(SearchMessageSchema).max(MAX_LIMIT),
    has_more: z.boolean(),
    next_cursor: z
      .object({
        before: TimestampSchema,
        before_id: UuidSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()

type SearchInput = {
  query: string
  limit: number
  before: string | null
  beforeId: string | null
  from: string | null
  to: string | null
}

function timestampMicros(value: string): number | null {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ''
  if (fraction.length > 6) return null
  return milliseconds * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6))
}

function comparePosition(
  left: { created_at: string; id: string },
  right: { created_at: string; id: string }
): number | null {
  const leftTime = timestampMicros(left.created_at)
  const rightTime = timestampMicros(right.created_at)
  if (leftTime === null || rightTime === null) return null
  if (leftTime !== rightTime) return leftTime - rightTime
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

function sameTimestamp(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  const leftMicros = timestampMicros(left)
  return leftMicros !== null && leftMicros === timestampMicros(right)
}

function readSearchInput(searchParams: URLSearchParams): SearchInput | null {
  const entries = [...searchParams.entries()]
  const raw = Object.fromEntries(entries)
  if (entries.length !== Object.keys(raw).length) return null

  const parsed = SearchQuerySchema.safeParse(raw)
  if (!parsed.success) return null

  return {
    query: parsed.data.q,
    limit: parsed.data.limit === undefined ? DEFAULT_LIMIT : Number(parsed.data.limit),
    before: parsed.data.cursor ?? null,
    beforeId: parsed.data.cursorId?.toLowerCase() ?? null,
    from: parsed.data.from ?? null,
    to: parsed.data.to ?? null,
  }
}

function acknowledgementMatchesRequest(
  acknowledgement: z.infer<typeof SearchSuccessSchema>,
  input: SearchInput,
  actorId: string,
  conversationId: string
): boolean {
  if (
    acknowledgement.actor_id !== actorId ||
    acknowledgement.conversation_id !== conversationId ||
    acknowledgement.query !== input.query ||
    !sameTimestamp(acknowledgement.from_created_at, input.from) ||
    !sameTimestamp(acknowledgement.to_created_at, input.to) ||
    acknowledgement.messages.length > input.limit ||
    (acknowledgement.has_more && acknowledgement.messages.length !== input.limit) ||
    acknowledgement.has_more !== (acknowledgement.next_cursor !== null)
  ) {
    return false
  }

  const messageIds = new Set<string>()
  for (let index = 0; index < acknowledgement.messages.length; index += 1) {
    const message = acknowledgement.messages[index]
    if (!message || messageIds.has(message.id)) return false
    messageIds.add(message.id)

    const messageTime = timestampMicros(message.created_at)
    if (messageTime === null) return false
    const fromTime = input.from === null ? null : timestampMicros(input.from)
    const toTime = input.to === null ? null : timestampMicros(input.to)
    if (
      (fromTime !== null && messageTime < fromTime) ||
      (toTime !== null && messageTime > toTime)
    ) {
      return false
    }

    const previous = acknowledgement.messages[index - 1]
    if (previous) {
      const order = comparePosition(previous, message)
      if (order === null || order <= 0) return false
    }

    if (input.before !== null && input.beforeId !== null) {
      const cursorOrder = comparePosition(message, {
        created_at: input.before,
        id: input.beforeId,
      })
      if (cursorOrder === null || cursorOrder >= 0) return false
    }
  }

  if (acknowledgement.next_cursor !== null) {
    const last = acknowledgement.messages[acknowledgement.messages.length - 1]
    if (
      !last ||
      acknowledgement.next_cursor.before !== last.created_at ||
      acknowledgement.next_cursor.before_id !== last.id
    ) {
      return false
    }
  }

  return true
}

function snippet(content: string, query: string): string {
  if (content.length <= 100) return content
  const rawIndex = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  const matchIndex = rawIndex < 0 ? 0 : rawIndex
  const start = Math.max(0, matchIndex - 40)
  const end = Math.min(content.length, matchIndex + query.length + 40)
  return `${start > 0 ? '...' : ''}${content.slice(start, end)}${end < content.length ? '...' : ''}`
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> | { conversationId: string } }
) {
  const resolvedParams = params instanceof Promise ? await params : params
  const handler = withAuth(
    async ({ user, supabase }) => {
      const parsedConversationId = UuidSchema.safeParse(resolvedParams.conversationId)
      const input = readSearchInput(request.nextUrl.searchParams)
      if (!parsedConversationId.success || !input) {
        return json({ error: 'Invalid search request' }, 400)
      }
      const conversationId = parsedConversationId.data.toLowerCase()

      const parsedActorId = UuidSchema.safeParse(user.id)
      if (!parsedActorId.success) return json({ error: 'No permission to search messages' }, 403)
      const actorId = parsedActorId.data.toLowerCase()

      const { data, error } = await supabase.rpc('search_direct_message_conversation_atomic', {
        p_conversation_id: conversationId,
        p_actor_id: actorId,
        p_query: input.query,
        p_before_created_at: input.before,
        p_before_id: input.beforeId,
        p_from_created_at: input.from,
        p_to_created_at: input.to,
        p_limit: input.limit,
      })

      if (error) {
        logger.error('Atomic search failed', { error: error.message })
        return json({ error: 'Search failed' }, 500)
      }

      const failure = SearchFailureSchema.safeParse(data)
      if (failure.success) {
        switch (failure.data.reason) {
          case 'INVALID':
            return json({ error: 'Invalid search request' }, 400)
          case 'NOT_FOUND':
            return json({ error: 'Conversation not found' }, 404)
          case 'ACTOR_UNAVAILABLE':
          case 'PARTICIPANT_UNAVAILABLE':
            return json({ error: 'No permission to search messages' }, 403)
        }
      }

      const acknowledgement = SearchSuccessSchema.safeParse(data)
      if (
        !acknowledgement.success ||
        !acknowledgementMatchesRequest(acknowledgement.data, input, actorId, conversationId)
      ) {
        logger.error('Atomic search returned an invalid acknowledgement')
        return json({ error: 'Search failed' }, 500)
      }

      const matches = acknowledgement.data.messages.map((message) => ({
        message_id: message.id,
        snippet: snippet(message.content, input.query),
        created_at: message.created_at,
        sender_id: message.sender_id,
      }))

      return json({
        matches,
        next_cursor: acknowledgement.data.next_cursor,
        total_in_page: matches.length,
      })
    },
    { name: 'chat-search', rateLimit: 'authenticated' }
  )

  return handler(request)
}
