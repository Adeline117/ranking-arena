/**
 * 通知 API
 * GET /api/notifications - 获取通知列表
 * PUT /api/notifications - 标记通知为已读
 * DELETE /api/notifications - 删除单个通知
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '@/lib/api/middleware'
import { features } from '@/lib/features'
import { PERSISTED_NOTIFICATION_TYPES, type NotificationType } from '@/lib/types/notification'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'

const logger = createLogger('notifications-list')
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_MUTATION_IDS = 100
const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const FILTER_TYPE_MAP = {
  all: null,
  follow: ['follow', 'new_follower'],
  like: ['like'],
  comment: ['comment', 'post_reply'],
  mention: ['mention'],
} as const satisfies Record<string, readonly NotificationType[] | null>

type NotificationFilter = keyof typeof FILTER_TYPE_MAP

const SOCIAL_NOTIFICATION_TYPES = [
  'post_reply',
  'new_follower',
  'group_update',
  'like',
  'reaction',
  'comment',
  'follow',
  'mention',
  'message',
] as const satisfies readonly NotificationType[]
const SOCIAL_NOTIFICATION_TYPE_SET = new Set<NotificationType>(SOCIAL_NOTIFICATION_TYPES)

const UuidSchema = z.string().uuid()
const NormalizedUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]?.length ?? 0) <= 6)
const NotificationTypeSchema = z.enum(PERSISTED_NOTIFICATION_TYPES)
const NotificationFilterSchema = z.enum(
  Object.keys(FILTER_TYPE_MAP) as [NotificationFilter, ...NotificationFilter[]]
)
const NotificationPageQuerySchema = z
  .object({
    filter: NotificationFilterSchema.optional(),
    cursor: TimestampSchema.optional(),
    cursorId: UuidSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .optional(),
  })
  .strict()
  .refine((value) => (value.cursor === undefined) === (value.cursorId === undefined), {
    message: 'Both cursor fields are required',
  })

const NotificationSchema = z
  .object({
    id: UuidSchema,
    user_id: UuidSchema,
    type: NotificationTypeSchema,
    title: z.string(),
    message: z.string(),
    link: z.string().nullable(),
    read: z.boolean(),
    actor_id: UuidSchema.nullable(),
    reference_id: z.string().nullable(),
    created_at: TimestampSchema,
    actor_handle: z.string().nullable(),
    actor_avatar_url: z.string().nullable(),
  })
  .strict()

const NotificationPageFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['INVALID', 'ACTOR_UNAVAILABLE', 'DATA_INTEGRITY']),
  })
  .strict()

const NotificationPageSuccessSchema = z
  .object({
    success: z.literal(true),
    actor_id: UuidSchema,
    types: z.array(NotificationTypeSchema).max(PERSISTED_NOTIFICATION_TYPES.length).nullable(),
    notifications: z.array(NotificationSchema).max(MAX_LIMIT),
    unread_count: z.number().int().nonnegative().refine(Number.isSafeInteger),
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

const NotificationMutationActionSchema = z.enum(['MARK_READ', 'MARK_ALL_READ', 'DELETE'])
const NotificationMutationFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['INVALID', 'ACTOR_UNAVAILABLE', 'NOT_FOUND']),
  })
  .strict()
const NotificationMutationSuccessSchema = z
  .object({
    success: z.literal(true),
    actor_id: UuidSchema,
    action: NotificationMutationActionSchema,
    notification_ids: z.array(UuidSchema).max(MAX_MUTATION_IDS).nullable(),
    changed_count: z.number().int().nonnegative().refine(Number.isSafeInteger),
    mutation_at: TimestampSchema,
  })
  .strict()

const NotificationIdsSchema = z
  .array(NormalizedUuidSchema)
  .min(1)
  .max(MAX_MUTATION_IDS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate notification ID' })
    }
  })
const MarkAllBodySchema = z.object({ mark_all: z.literal(true) }).strict()
const MarkOneBodySchema = z.object({ notification_id: NormalizedUuidSchema }).strict()
const MarkManyBodySchema = z.object({ notification_ids: NotificationIdsSchema }).strict()
const NotificationPutBodySchema = z.union([
  MarkAllBodySchema,
  MarkOneBodySchema,
  MarkManyBodySchema,
])
const NotificationDeleteBodySchema = MarkOneBodySchema

type NotificationMutationInput = {
  action: z.infer<typeof NotificationMutationActionSchema>
  notificationIds: string[] | null
}

type NotificationPageInput = {
  before: string | null
  beforeId: string | null
  filter: NotificationFilter
  limit: number
  types: NotificationType[] | null
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

function sameTypes(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function effectiveTypes(filter: NotificationFilter): NotificationType[] | null {
  const requested = FILTER_TYPE_MAP[filter] as readonly NotificationType[] | null
  if (features.social) return requested === null ? null : [...requested].sort()

  const visibleTypes = PERSISTED_NOTIFICATION_TYPES.filter(
    (type) => !SOCIAL_NOTIFICATION_TYPE_SET.has(type)
  )
  const filtered =
    requested === null ? visibleTypes : visibleTypes.filter((type) => requested.includes(type))
  return [...filtered].sort()
}

function readPageInput(searchParams: URLSearchParams): NotificationPageInput | null {
  const entries = [...searchParams.entries()]
  const raw = Object.fromEntries(entries)
  if (entries.length !== Object.keys(raw).length) return null

  const parsed = NotificationPageQuerySchema.safeParse(raw)
  if (!parsed.success) return null
  const filter = parsed.data.filter ?? 'all'
  return {
    before: parsed.data.cursor ?? null,
    beforeId: parsed.data.cursorId?.toLowerCase() ?? null,
    filter,
    limit: parsed.data.limit === undefined ? DEFAULT_LIMIT : Number(parsed.data.limit),
    types: effectiveTypes(filter),
  }
}

function acknowledgementMatchesRequest(
  acknowledgement: z.infer<typeof NotificationPageSuccessSchema>,
  input: NotificationPageInput,
  actorId: string
): boolean {
  if (
    acknowledgement.actor_id !== actorId ||
    !sameTypes(acknowledgement.types, input.types) ||
    acknowledgement.notifications.length > input.limit ||
    (acknowledgement.has_more && acknowledgement.notifications.length !== input.limit) ||
    acknowledgement.has_more !== (acknowledgement.next_cursor !== null)
  ) {
    return false
  }

  const notificationIds = new Set<string>()
  for (let index = 0; index < acknowledgement.notifications.length; index += 1) {
    const notification = acknowledgement.notifications[index]
    if (
      !notification ||
      notification.user_id !== actorId ||
      notificationIds.has(notification.id) ||
      (input.types !== null && !input.types.includes(notification.type)) ||
      (notification.actor_id === null &&
        (notification.actor_handle !== null || notification.actor_avatar_url !== null))
    ) {
      return false
    }
    notificationIds.add(notification.id)

    const previous = acknowledgement.notifications[index - 1]
    if (previous) {
      const order = comparePosition(previous, notification)
      if (order === null || order <= 0) return false
    }

    if (input.before !== null && input.beforeId !== null) {
      const cursorOrder = comparePosition(notification, {
        created_at: input.before,
        id: input.beforeId,
      })
      if (cursorOrder === null || cursorOrder >= 0) return false
    }
  }

  if (acknowledgement.next_cursor !== null) {
    const last = acknowledgement.notifications.at(-1)
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

function safeNotificationLink(value: string | null): string | null {
  if (
    value === null ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null
  }
  return value
}

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

function sameIds(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function mutationAcknowledgementMatchesRequest(
  acknowledgement: z.infer<typeof NotificationMutationSuccessSchema>,
  actorId: string,
  input: NotificationMutationInput
): boolean {
  if (
    acknowledgement.actor_id !== actorId ||
    acknowledgement.action !== input.action ||
    !sameIds(acknowledgement.notification_ids, input.notificationIds)
  ) {
    return false
  }

  if (input.action === 'DELETE') return acknowledgement.changed_count === 1
  if (input.action === 'MARK_READ') {
    return (
      input.notificationIds !== null &&
      acknowledgement.changed_count <= input.notificationIds.length
    )
  }
  return input.notificationIds === null
}

async function executeNotificationMutation(
  supabase: SupabaseClient,
  rawActorId: string,
  input: NotificationMutationInput
) {
  const parsedActorId = NormalizedUuidSchema.safeParse(rawActorId)
  if (!parsedActorId.success) {
    logger.error('Authenticated notification mutation actor is malformed')
    return privateJson({ error: 'Failed to mutate notifications' }, 500)
  }
  const actorId = parsedActorId.data

  const { data, error } = await supabase.rpc('mutate_notifications_atomic', {
    p_actor_id: actorId,
    p_action: input.action,
    p_notification_ids: input.notificationIds,
  })

  if (error) {
    logger.error('Atomic notification mutation failed', { error: error.message })
    return privateJson({ error: 'Failed to mutate notifications' }, 500)
  }

  const failure = NotificationMutationFailureSchema.safeParse(data)
  if (failure.success) {
    switch (failure.data.reason) {
      case 'ACTOR_UNAVAILABLE':
        return privateJson({ error: 'No permission to mutate notifications' }, 403)
      case 'NOT_FOUND':
        return privateJson({ error: 'Notification not found' }, 404)
      case 'INVALID':
        logger.error('Atomic notification mutation rejected validated input')
        return privateJson({ error: 'Failed to mutate notifications' }, 500)
    }
  }

  const acknowledgement = NotificationMutationSuccessSchema.safeParse(data)
  if (
    !acknowledgement.success ||
    !mutationAcknowledgementMatchesRequest(acknowledgement.data, actorId, input)
  ) {
    logger.error('Atomic notification mutation returned an invalid acknowledgement')
    return privateJson({ error: 'Failed to mutate notifications' }, 500)
  }

  return privateJson({
    success: true,
    data: {
      message:
        input.action === 'DELETE'
          ? 'Notification deleted'
          : input.action === 'MARK_ALL_READ'
            ? 'All notifications marked as read'
            : input.notificationIds?.length === 1
              ? 'Marked as read'
              : `${input.notificationIds?.length ?? 0} notifications marked as read`,
      actor_id: acknowledgement.data.actor_id,
      action: acknowledgement.data.action,
      notification_ids: acknowledgement.data.notification_ids,
      changed_count: acknowledgement.data.changed_count,
      mutation_at: acknowledgement.data.mutation_at,
    },
  })
}

export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const input = readPageInput(new URL(request.url).searchParams)
    const parsedActorId = UuidSchema.safeParse(user.id)
    if (!input) return privateJson({ error: 'Invalid notification page request' }, 400)
    if (!parsedActorId.success) {
      logger.error('Authenticated notification actor is malformed')
      return privateJson({ error: 'Failed to fetch notifications' }, 500)
    }
    const actorId = parsedActorId.data.toLowerCase()

    const { data, error } = await supabase.rpc('get_notification_page_atomic', {
      p_actor_id: actorId,
      p_types: input.types,
      p_before_created_at: input.before,
      p_before_id: input.beforeId,
      p_limit: input.limit,
    })

    if (error) {
      logger.error('Atomic notification page failed', { error: error.message })
      return privateJson({ error: 'Failed to fetch notifications' }, 500)
    }

    const failure = NotificationPageFailureSchema.safeParse(data)
    if (failure.success) {
      switch (failure.data.reason) {
        case 'INVALID':
          return privateJson({ error: 'Failed to fetch notifications' }, 500)
        case 'ACTOR_UNAVAILABLE':
          return privateJson({ error: 'No permission to access notifications' }, 403)
        case 'DATA_INTEGRITY':
          logger.error('Atomic notification page reported invalid persisted state')
          return privateJson({ error: 'Failed to fetch notifications' }, 500)
      }
    }

    const acknowledgement = NotificationPageSuccessSchema.safeParse(data)
    if (
      !acknowledgement.success ||
      !acknowledgementMatchesRequest(acknowledgement.data, input, actorId)
    ) {
      logger.error('Atomic notification page returned an invalid acknowledgement')
      return privateJson({ error: 'Failed to fetch notifications' }, 500)
    }

    return privateJson({
      notifications: acknowledgement.data.notifications.map((notification) => ({
        ...notification,
        link: safeNotificationLink(notification.link),
      })),
      unread_count: acknowledgement.data.unread_count,
      next_cursor: acknowledgement.data.next_cursor,
    })
  },
  { name: 'notifications-list', rateLimit: 'read' }
)

export const PUT = withAuth(
  async ({ user, supabase, request }) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return privateJson({ error: 'Invalid notification mutation request' }, 400)
    }

    const body = NotificationPutBodySchema.safeParse(rawBody)
    if (!body.success) {
      return privateJson({ error: 'Invalid notification mutation request' }, 400)
    }

    let input: NotificationMutationInput
    if ('mark_all' in body.data) {
      input = { action: 'MARK_ALL_READ', notificationIds: null }
    } else if ('notification_ids' in body.data) {
      input = { action: 'MARK_READ', notificationIds: body.data.notification_ids }
    } else {
      input = { action: 'MARK_READ', notificationIds: [body.data.notification_id] }
    }

    return executeNotificationMutation(supabase, user.id, input)
  },
  { name: 'notifications-mark-read', rateLimit: 'write' }
)

export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return privateJson({ error: 'Invalid notification deletion request' }, 400)
    }

    const body = NotificationDeleteBodySchema.safeParse(rawBody)
    if (!body.success) {
      return privateJson({ error: 'Invalid notification deletion request' }, 400)
    }

    return executeNotificationMutation(supabase, user.id, {
      action: 'DELETE',
      notificationIds: [body.data.notification_id],
    })
  },
  { name: 'notifications-delete', rateLimit: 'write' }
)
