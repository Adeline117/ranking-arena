/**
 * 通知 API
 * GET /api/notifications - 获取通知列表
 * PUT /api/notifications - 标记通知为已读
 * DELETE /api/notifications - 删除单个通知
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
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import {
  getUserNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
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
  } catch (error: unknown) {
    return handleError(error, 'notifications GET')
  }
}

export async function PUT(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    const notification_id = validateString(body.notification_id)
    const mark_all = body.mark_all === true

    if (mark_all) {
      await markAllNotificationsAsRead(supabase, user.id)
      return success({ message: 'All notifications marked as read' })
    } else if (notification_id) {
      await markNotificationAsRead(supabase, notification_id, user.id)
      return success({ message: 'Marked as read' })
    } else {
      return handleError(new Error('Please provide notification_id or set mark_all to true'), 'notifications PUT')
    }
  } catch (error: unknown) {
    return handleError(error, 'notifications PUT')
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    const notification_id = validateString(body.notification_id)

    if (!notification_id) {
      return handleError(new Error('Please provide notification_id'), 'notifications DELETE')
    }

    await deleteNotification(supabase, notification_id, user.id)
    return success({ message: 'Notification deleted' })
  } catch (error: unknown) {
    return handleError(error, 'notifications DELETE')
  }
}
