/**
 * 内部通知发送 API
 *
 * POST /api/notifications/send
 *
 * 仅供系统内部使用（cron jobs、服务端触发等）。
 * 需要 CRON_SECRET 或 INTERNAL_API_KEY 认证，不接受普通用户调用。
 *
 * Body: {
 *   user_id: string        // 接收通知的用户
 *   type: string           // follow/like/comment/mention/system/copy_trade/trader_alert/...
 *   title: string          // 通知标题
 *   message: string        // 通知正文
 *   link?: string          // 可选跳转链接
 *   actor_id?: string      // 触发者用户 ID
 *   reference_id?: string  // 关联对象 ID（帖子/评论等）
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin, handleError } from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { verifyServiceAuth as verifyServiceAuthShared } from '@/lib/auth/verify-service-auth'
import { deliverNotification, NotificationDeliveryError } from '@/lib/data/notifications'
import type { NotificationType } from '@/lib/types/notification'

export const dynamic = 'force-dynamic'

const VALID_TYPES = [
  'follow',
  'like',
  'comment',
  'mention',
  'system',
  'copy_trade',
  'trader_alert',
  'message',
  'post_reply',
  'new_follower',
  'group_update',
  'ranking_change',
  'referral_reward',
] as const satisfies readonly NotificationType[]

const NormalizedUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
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
const NotificationSendBodySchema = z
  .object({
    user_id: NormalizedUuidSchema,
    type: z.enum(VALID_TYPES),
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
    link: SafeLinkSchema.optional(),
    actor_id: NormalizedUuidSchema.optional(),
    reference_id: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => value.trim().length > 0)
      .optional(),
    deduplicate: z.boolean().optional(),
    dedup_window_seconds: z.number().int().min(1).max(604800).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.deduplicate === true && value.reference_id === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reference_id'],
        message: 'Deduplication requires a reference ID',
      })
    }
    if (value.deduplicate !== true && value.dedup_window_seconds !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dedup_window_seconds'],
        message: 'Deduplication window requires deduplicate=true',
      })
    }
  })

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

/**
 * Verify caller is an internal/service caller (timing-safe).
 * Accepts either CRON_SECRET (Bearer) or INTERNAL_API_KEY (x-internal-key).
 * Regular user JWT tokens are NOT accepted — notifications must be system-generated.
 */
function verifyServiceAuth(request: NextRequest): boolean {
  return verifyServiceAuthShared(request)
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    // Service-role only: reject any regular user JWT calls
    if (!verifyServiceAuth(request)) {
      return json({ error: 'Forbidden: notifications must be sent by internal services only' }, 403)
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return json({ error: 'Invalid notification request' }, 400)
    }

    const body = NotificationSendBodySchema.safeParse(rawBody)
    if (!body.success) {
      return json({ error: 'Invalid notification request' }, 400)
    }

    const result = await deliverNotification(
      getSupabaseAdmin(),
      {
        user_id: body.data.user_id,
        type: body.data.type,
        title: body.data.title,
        message: body.data.message,
        ...(body.data.link === undefined ? {} : { link: body.data.link }),
        ...(body.data.actor_id === undefined ? {} : { actor_id: body.data.actor_id }),
        ...(body.data.reference_id === undefined ? {} : { reference_id: body.data.reference_id }),
      },
      {
        deduplicate: body.data.deduplicate ?? false,
        ...(body.data.dedup_window_seconds === undefined
          ? {}
          : { dedupWindowSeconds: body.data.dedup_window_seconds }),
      }
    )

    return json({
      success: true,
      notification_id: result.notificationId,
      outcome: result.outcome,
      created: result.created,
      deduplicated: result.deduplicated,
      skipped: result.skippedSelf,
    })
  } catch (error: unknown) {
    if (error instanceof NotificationDeliveryError) {
      logger.error('[notifications/send] atomic delivery failed', {
        code: error.code,
      })
      if (error.code === 'RECIPIENT_UNAVAILABLE') {
        return json({ error: 'Notification recipient is unavailable' }, 404)
      }
      if (error.code === 'ACTOR_UNAVAILABLE') {
        return json({ error: 'Notification actor is unavailable' }, 400)
      }
      return json({ error: 'Failed to create notification' }, 500)
    }
    return handleError(error, 'notifications/send POST')
  }
}
