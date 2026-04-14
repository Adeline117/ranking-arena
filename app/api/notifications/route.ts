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
import { features } from '@/lib/features'
import { getOrSet, delByPattern } from '@/lib/cache'

const SOCIAL_NOTIFICATION_TYPES = ['post_reply', 'new_follower', 'group_update', 'like', 'comment', 'follow', 'mention']

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const unread_only = searchParams.get('unread_only') === 'true'

    const cacheKey = `notifications:${user.id}:${limit}:${offset}:${unread_only}`
    const { notifications: initialNotifications, unreadCount } = await getOrSet(
      cacheKey,
      async () => {
        const supabase = getSupabaseAdmin()
        const [notifs, count] = await Promise.all([
          getUserNotifications(supabase, user.id, { limit, offset, unread_only }),
          getUnreadNotificationCount(supabase, user.id),
        ])
        return { notifications: notifs, unreadCount: count }
      },
      { ttl: 30 }
    )
    let notifications = initialNotifications

    // When social features are off, filter out social notification types
    if (!features.social) {
      notifications = notifications.filter(
        (n: { type?: string }) => !SOCIAL_NOTIFICATION_TYPES.includes(n.type || '')
      )
    }

    return successWithPagination(
      { notifications, unread_count: features.social ? unreadCount : notifications.length },
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
    const notification_ids: string[] | undefined = Array.isArray(body.notification_ids) ? body.notification_ids.filter((id: unknown) => typeof id === 'string') : undefined
    const mark_all = body.mark_all === true

    if (mark_all) {
      await markAllNotificationsAsRead(supabase, user.id)
      await delByPattern(`notifications:${user.id}:*`)
      return success({ message: 'All notifications marked as read' })
    } else if (notification_ids && notification_ids.length > 0) {
      // Batch mark-read: update all IDs belonging to this user
      await supabase
        .from('notifications')
        .update({ read: true, read_at: new Date().toISOString() })
        .in('id', notification_ids)
        .eq('user_id', user.id)
      await delByPattern(`notifications:${user.id}:*`)
      return success({ message: `${notification_ids.length} notifications marked as read` })
    } else if (notification_id) {
      await markNotificationAsRead(supabase, notification_id, user.id)
      await delByPattern(`notifications:${user.id}:*`)
      return success({ message: 'Marked as read' })
    } else {
      return handleError(new Error('Please provide notification_id, notification_ids, or set mark_all to true'), 'notifications PUT')
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
    await delByPattern(`notifications:${user.id}:*`)
    return success({ message: 'Notification deleted' })
  } catch (error: unknown) {
    return handleError(error, 'notifications DELETE')
  }
}
