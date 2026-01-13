/**
 * 通知 API
 * GET /api/notifications - 获取通知列表
 * PUT /api/notifications - 标记通知为已读
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  successWithPagination,
  handleError,
  validateString,
  validateNumber,
} from '@/lib/api'
import {
  getUserNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
} from '@/lib/data/notifications'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    
    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const unread_only = searchParams.get('unread_only') === 'true'

    const [notifications, unreadCount] = await Promise.all([
      getUserNotifications(supabase, user.id, { limit, offset, unread_only }),
      getUnreadNotificationCount(supabase, user.id),
    ])

    return successWithPagination(
      { notifications, unread_count: unreadCount },
      { limit, offset, has_more: notifications.length === limit }
    )
  } catch (error) {
    return handleError(error, 'notifications GET')
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    const notification_id = validateString(body.notification_id)
    const mark_all = body.mark_all === true

    if (mark_all) {
      await markAllNotificationsAsRead(supabase, user.id)
      return success({ message: '已标记所有通知为已读' })
    } else if (notification_id) {
      await markNotificationAsRead(supabase, notification_id, user.id)
      return success({ message: '已标记为已读' })
    } else {
      return handleError(new Error('请提供 notification_id 或设置 mark_all 为 true'), 'notifications PUT')
    }
  } catch (error) {
    return handleError(error, 'notifications PUT')
  }
}
