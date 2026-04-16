/**
 * 标记通知已读 API
 *
 * POST /api/notifications/mark-read
 * Body: { notification_ids?: string[], mark_all?: boolean }
 */

import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError, success } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:notifications-mark-read')

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    const { notification_ids, mark_all } = body as {
      notification_ids?: string[]
      mark_all?: boolean
    }

    if (mark_all) {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true, read_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('read', false)

      if (error) {
        log.error('mark_all failed', { error: error.message })
        return serverError('Failed to mark notifications as read')
      }

      return success({ message: 'All marked as read' })
    }

    if (!notification_ids || !Array.isArray(notification_ids) || notification_ids.length === 0) {
      return badRequest('Missing notification ID')
    }

    const { error } = await supabase
      .from('notifications')
      .update({ read: true, read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .in('id', notification_ids)

    if (error) {
      log.error('batch mark-read failed', { error: error.message })
      return serverError('Failed to mark notifications as read')
    }

    return success({ message: `${notification_ids.length} notifications marked as read` })
  },
  { name: 'notifications-mark-read', rateLimit: 'write' }
)
