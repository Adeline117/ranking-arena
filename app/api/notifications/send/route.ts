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
import {
  getSupabaseAdmin,
  handleError,
} from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { verifyServiceAuth as verifyServiceAuthShared } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'

const VALID_TYPES = [
  'follow', 'like', 'comment', 'mention', 'system',
  'copy_trade', 'trader_alert', 'message', 'post_reply',
  'new_follower', 'group_update',
]

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
      return NextResponse.json(
        { error: 'Forbidden: notifications must be sent by internal services only' },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { user_id, type, title, message, link, actor_id, reference_id } = body

    // 验证必填字段
    if (!user_id || typeof user_id !== 'string') {
      return NextResponse.json({ error: 'Missing user_id' }, { status: 400 })
    }
    if (!type || !VALID_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `Invalid notification type, supported: ${VALID_TYPES.join(', ')}` },
        { status: 400 }
      )
    }
    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: 'Missing title' }, { status: 400 })
    }
    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'Missing message' }, { status: 400 })
    }

    // 防止给自己发通知
    if (actor_id && actor_id === user_id) {
      return NextResponse.json({ success: true, message: 'Skipped self-notification', skipped: true })
    }

    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('notifications')
      .insert({
        user_id,
        type,
        title: title.slice(0, 200),
        message: message.slice(0, 1000),
        link: link?.slice(0, 500) || null,
        actor_id: actor_id || null,
        reference_id: reference_id || null,
        read: false,
      })
      .select('id')
      .single()

    if (error) {
      logger.error('[notifications/send] 创建通知Failed:', error)
      return NextResponse.json({ error: 'Failed to create notification' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      notification_id: data.id,
    })
  } catch (error: unknown) {
    return handleError(error, 'notifications/send POST')
  }
}
