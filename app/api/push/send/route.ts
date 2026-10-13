/**
 * Push Notification Send API
 *
 * POST - Send push notification to user(s)
 * Requires admin role or the notification to be self-targeted.
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { getPushNotificationService } from '@/lib/services/push-notification'
import type { PushNotification } from '@/lib/services/push-notification'
import logger from '@/lib/logger'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, request }) => {
    const body = await request.json()
    const { userIds, title, body: messageBody, data, imageUrl } = body

    // Validate required fields
    if (!title || !messageBody) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing required fields: title, body',
        },
        { status: 400 }
      )
    }

    if (
      userIds !== undefined &&
      (!Array.isArray(userIds) ||
        userIds.length === 0 ||
        userIds.length > 1000 ||
        !userIds.every((id: unknown) => typeof id === 'string' && id.length > 0))
    ) {
      return NextResponse.json(
        { success: false, error: 'userIds must be a non-empty array of user ids' },
        { status: 400 }
      )
    }

    const targetUserIds: string[] = userIds ?? [user.id]
    const isSelfTarget = targetUserIds.length === 1 && targetUserIds[0] === user.id

    if (!isSelfTarget) {
      // Sending to other users is an admin action: use the shared verifyAdmin
      // (production email allowlist + banned/deleted lifecycle checks), not a
      // bare user_profiles.role === 'admin' read.
      const admin = await verifyAdmin(getSupabaseAdmin(), request.headers.get('authorization'))
      if (!admin || admin.id !== user.id) {
        return NextResponse.json(
          {
            success: false,
            error: 'Admin role required to send to other users',
          },
          { status: 403 }
        )
      }
    }

    try {
      const service = getPushNotificationService()
      const notification: PushNotification = {
        title,
        body: messageBody,
        data,
        imageUrl,
        channelId: 'arena_default',
      }

      const results = await service.sendToUsers(targetUserIds, notification)

      return NextResponse.json({
        success: true,
        results,
      })
    } catch (error: unknown) {
      logger.error('[push/send] Failed to send notification:', error)
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to send notification',
        },
        { status: 500 }
      )
    }
  },
  { name: 'push-send', rateLimit: 'write' }
)
