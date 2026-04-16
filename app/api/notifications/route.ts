/**
 * 通知 API
 * GET /api/notifications - 获取通知列表
 * PUT /api/notifications - 标记通知为已读
 * DELETE /api/notifications - 删除单个通知
 */

import { withAuth } from '@/lib/api/middleware'
import {
  success,
  successWithPagination,
  badRequest,
  handleError,
} from '@/lib/api/response'
import { validateString, validateNumber } from '@/lib/api/validation'
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

export const GET = withAuth(
  async ({ user, supabase, request }) => {
    try {
      const { searchParams } = new URL(request.url)

      const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
      const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
      const unread_only = searchParams.get('unread_only') === 'true'

      const cacheKey = `notifications:${user.id}:${limit}:${offset}:${unread_only}`
      const { notifications: initialNotifications, unreadCount } = await getOrSet(
        cacheKey,
        async () => {
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
  },
  { name: 'notifications-list', rateLimit: 'read' }
)

export const PUT = withAuth(
  async ({ user, supabase, request }) => {
    try {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return badRequest('Invalid JSON body')
      }

      const notification_id = validateString(body.notification_id)
      const notification_ids: string[] | undefined = Array.isArray(body.notification_ids)
        ? body.notification_ids.filter((id: unknown) => typeof id === 'string')
        : undefined
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
        return badRequest('Please provide notification_id, notification_ids, or set mark_all to true')
      }
    } catch (error: unknown) {
      return handleError(error, 'notifications PUT')
    }
  },
  { name: 'notifications-mark-read', rateLimit: 'write' }
)

export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    try {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return badRequest('Invalid JSON body')
      }

      const notification_id = validateString(body.notification_id)

      if (!notification_id) {
        return badRequest('Please provide notification_id')
      }

      await deleteNotification(supabase, notification_id, user.id)
      await delByPattern(`notifications:${user.id}:*`)
      return success({ message: 'Notification deleted' })
    } catch (error: unknown) {
      return handleError(error, 'notifications DELETE')
    }
  },
  { name: 'notifications-delete', rateLimit: 'write' }
)
