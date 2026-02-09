/**
 * 内部通知发送 API
 * 
 * POST /api/notifications/send
 * 
 * 用于其他功能模块创建通知（关注、点赞、评论、跟单等）
 * 需要 service role 或已认证用户调用
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
  requireAuth,
  handleError,
} from '@/lib/api'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

const VALID_TYPES = [
  'follow', 'like', 'comment', 'mention', 'system',
  'copy_trade', 'trader_alert', 'message', 'post_reply',
  'new_follower', 'group_update',
]

export async function POST(request: NextRequest) {
  try {
    // 支持两种认证方式：
    // 1. 普通用户 Bearer token（用于用户触发的通知如关注、点赞）
    // 2. 内部 service key（用于系统通知、cron 等）
    const internalKey = request.headers.get('x-internal-key')
    const isInternal = internalKey === process.env.INTERNAL_API_KEY

    if (!isInternal) {
      // 非内部调用需要用户认证
      await requireAuth(request)
    }

    const body = await request.json()
    const { user_id, type, title, message, link, actor_id, reference_id } = body

    // 验证必填字段
    if (!user_id || typeof user_id !== 'string') {
      return NextResponse.json({ error: '缺少 user_id' }, { status: 400 })
    }
    if (!type || !VALID_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `无效的通知类型，支持: ${VALID_TYPES.join(', ')}` },
        { status: 400 }
      )
    }
    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: '缺少 title' }, { status: 400 })
    }
    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: '缺少 message' }, { status: 400 })
    }

    // 防止给自己发通知
    if (actor_id && actor_id === user_id) {
      return NextResponse.json({ success: true, message: '跳过自我通知', skipped: true })
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
      logger.error('[notifications/send] 创建通知失败:', error)
      return NextResponse.json({ error: '创建通知失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      notification_id: data.id,
    })
  } catch (error: unknown) {
    return handleError(error, 'notifications/send POST')
  }
}
