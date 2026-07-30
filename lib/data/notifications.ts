/**
 * 通知数据层
 *
 * API route 必须通过 sendNotification()（非阻塞）或
 * deliverNotification()（等待精确确认）发送通知。
 * 两者共享同一原子创建/去重 authority，防止：
 * 1. 通知阻塞 API 响应
 * 2. 重复通知轰炸用户
 * 3. 通知失败影响主流程
 *
 * 仅经审计的 cron 批量广播可直接 insert（有独立批次 authority）。
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { fireAndForget } from '@/lib/utils/logger'
import {
  PERSISTED_NOTIFICATION_TYPES,
  type NotificationType as PersistedNotificationType,
} from '@/lib/types/notification'

export type NotificationType = PersistedNotificationType

export type NotificationCreateInput = {
  user_id: string
  type: NotificationType
  title: string
  message: string
  link?: string
  actor_id?: string
  reference_id?: string
  read?: boolean
}

export type NotificationDeliveryOptions = {
  deduplicate?: boolean
  dedupWindowSeconds?: number
}

export type NotificationDeliveryResult = {
  outcome: 'CREATED' | 'DEDUPLICATED' | 'SKIPPED_SELF'
  notificationId: string | null
  createdAt: string | null
  created: boolean
  deduplicated: boolean
  skippedSelf: boolean
}

export type NotificationDeliveryErrorCode =
  | 'INVALID_REQUEST'
  | 'RECIPIENT_UNAVAILABLE'
  | 'ACTOR_UNAVAILABLE'
  | 'RPC_ERROR'
  | 'INVALID_ACKNOWLEDGEMENT'

export class NotificationDeliveryError extends Error {
  constructor(
    readonly code: NotificationDeliveryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'NotificationDeliveryError'
  }
}

const NormalizedUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]?.length ?? 0) <= 6)
const SafeLinkSchema = z
  .string()
  .max(500)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.includes('\\') &&
      !/[\u0000-\u001f\u007f]/.test(value)
  )
const NotificationCreateInputSchema = z
  .object({
    user_id: NormalizedUuidSchema,
    type: z.enum(PERSISTED_NOTIFICATION_TYPES).refine((value) => value !== 'tip_received'),
    title: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim().length > 0),
    message: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value.trim().length > 0),
    link: SafeLinkSchema.optional().transform((value) => value ?? null),
    actor_id: NormalizedUuidSchema.optional().transform((value) => value ?? null),
    reference_id: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => value.trim().length > 0)
      .optional()
      .transform((value) => value ?? null),
    read: z.literal(false).optional(),
  })
  .strict()
const NotificationDeliveryOptionsSchema = z
  .object({
    deduplicate: z.boolean().optional(),
    dedupWindowSeconds: z.number().int().min(0).max(604800).optional(),
  })
  .strict()
const NotificationCreateFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['INVALID', 'RECIPIENT_UNAVAILABLE', 'ACTOR_UNAVAILABLE']),
  })
  .strict()
const NotificationCreateSuccessSchema = z
  .object({
    success: z.literal(true),
    outcome: z.enum(['CREATED', 'DEDUPLICATED', 'SKIPPED_SELF']),
    recipient_id: NormalizedUuidSchema,
    type: z.enum(PERSISTED_NOTIFICATION_TYPES),
    title: z.string(),
    message: z.string(),
    link: z.string().nullable(),
    actor_id: NormalizedUuidSchema.nullable(),
    reference_id: z.string().nullable(),
    deduplicate: z.boolean(),
    dedup_window_seconds: z.number().int().nonnegative().refine(Number.isSafeInteger),
    notification_id: NormalizedUuidSchema.nullable(),
    created_at: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const skipped = value.outcome === 'SKIPPED_SELF'
    if (skipped !== (value.notification_id === null) || skipped !== (value.created_at === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Notification outcome does not match its persisted identity',
      })
    }
  })

/**
 * 统一通知入口 — 所有 API route 必须使用这个函数发送通知。
 * Fire-and-forget wrapper. Actor + reference events default to a one-hour
 * dedup window; system events opt in explicitly when their identity is stable.
 *
 * @example
 * sendNotification(supabase, {
 *   user_id: targetUserId,
 *   type: 'comment',
 *   title: `${handle} commented on your post`,
 *   message: content.slice(0, 100),
 *   actor_id: currentUserId,
 *   link: `/post/${postId}`,
 *   reference_id: postId,
 * }, 'Comment notification')
 */
export function sendNotification(
  supabase: SupabaseClient,
  notification: NotificationCreateInput,
  context: string,
  options?: NotificationDeliveryOptions
): void {
  fireAndForget(deliverNotification(supabase, notification, options), context)
}

/**
 * 批量通知入口 — fire-and-forget，每条独立 dedup。
 * 用于 @mentions 等一次通知多人的场景。
 */
export function sendNotifications(
  supabase: SupabaseClient,
  notifications: NotificationCreateInput[],
  context: string,
  options?: NotificationDeliveryOptions
): void {
  if (notifications.length === 0) return
  fireAndForget(
    Promise.all(
      notifications.map((notification) => deliverNotification(supabase, notification, options))
    ),
    context
  )
}

/**
 * Create or atomically deduplicate one notification and wait for the exact
 * database acknowledgement. Callers whose primary write must stay fast should
 * use sendNotification(), which observes this promise through fireAndForget().
 */
export async function deliverNotification(
  supabase: SupabaseClient,
  notification: NotificationCreateInput,
  options: NotificationDeliveryOptions = {}
): Promise<NotificationDeliveryResult> {
  const parsedNotification = NotificationCreateInputSchema.safeParse(notification)
  const parsedOptions = NotificationDeliveryOptionsSchema.safeParse(options)
  if (!parsedNotification.success || !parsedOptions.success) {
    throw new NotificationDeliveryError('INVALID_REQUEST', 'Invalid notification request')
  }

  const input = parsedNotification.data
  const deduplicate =
    parsedOptions.data.deduplicate ?? Boolean(input.actor_id && input.reference_id)
  const dedupWindowSeconds = deduplicate ? (parsedOptions.data.dedupWindowSeconds ?? 3600) : 0
  if (
    (deduplicate && (!input.reference_id || dedupWindowSeconds < 1)) ||
    (!deduplicate &&
      parsedOptions.data.dedupWindowSeconds !== undefined &&
      parsedOptions.data.dedupWindowSeconds !== 0)
  ) {
    throw new NotificationDeliveryError('INVALID_REQUEST', 'Invalid notification deduplication')
  }

  const { data, error } = await supabase.rpc('create_notification_atomic', {
    p_recipient_id: input.user_id,
    p_type: input.type,
    p_title: input.title,
    p_message: input.message,
    p_link: input.link,
    p_actor_id: input.actor_id,
    p_reference_id: input.reference_id,
    p_deduplicate: deduplicate,
    p_dedup_window_seconds: dedupWindowSeconds,
  })

  if (error) {
    throw new NotificationDeliveryError('RPC_ERROR', 'Notification authority unavailable', {
      cause: error,
    })
  }

  const failure = NotificationCreateFailureSchema.safeParse(data)
  if (failure.success) {
    const code = failure.data.reason
    if (code === 'RECIPIENT_UNAVAILABLE' || code === 'ACTOR_UNAVAILABLE') {
      throw new NotificationDeliveryError(code, `Notification ${code.toLowerCase()}`)
    }
    throw new NotificationDeliveryError(
      'INVALID_ACKNOWLEDGEMENT',
      'Notification authority rejected validated input'
    )
  }

  const acknowledgement = NotificationCreateSuccessSchema.safeParse(data)
  if (
    !acknowledgement.success ||
    acknowledgement.data.recipient_id !== input.user_id ||
    acknowledgement.data.type !== input.type ||
    acknowledgement.data.title !== input.title ||
    acknowledgement.data.message !== input.message ||
    acknowledgement.data.link !== input.link ||
    acknowledgement.data.actor_id !== input.actor_id ||
    acknowledgement.data.reference_id !== input.reference_id ||
    acknowledgement.data.deduplicate !== deduplicate ||
    acknowledgement.data.dedup_window_seconds !== dedupWindowSeconds
  ) {
    throw new NotificationDeliveryError(
      'INVALID_ACKNOWLEDGEMENT',
      'Notification authority returned an invalid acknowledgement'
    )
  }

  return {
    outcome: acknowledgement.data.outcome,
    notificationId: acknowledgement.data.notification_id,
    createdAt: acknowledgement.data.created_at,
    created: acknowledgement.data.outcome === 'CREATED',
    deduplicated: acknowledgement.data.outcome === 'DEDUPLICATED',
    skippedSelf: acknowledgement.data.outcome === 'SKIPPED_SELF',
  }
}

/** Backward-compatible awaited dedup helper. */
export async function createNotificationDeduped(
  supabase: SupabaseClient,
  notification: NotificationCreateInput,
  options?: NotificationDeliveryOptions
): Promise<NotificationDeliveryResult> {
  return deliverNotification(supabase, notification, options)
}
