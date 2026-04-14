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

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, request, supabase }) => {
    const body = await request.json()
    const { userIds, title, body: messageBody, data, imageUrl } = body

    // Validate required fields
    if (!title || !messageBody) {
      return NextResponse.json({
        success: false,
        error: 'Missing required fields: title, body',
      }, { status: 400 })
    }

    // Check if user is admin (for sending to others)
    const targetUserIds: string[] = userIds || [user.id]
    const isSelfTarget = targetUserIds.length === 1 && targetUserIds[0] === user.id

    if (!isSelfTarget) {
      // Check admin role
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (profile?.role !== 'admin') {
        return NextResponse.json({
          success: false,
          error: 'Admin role required to send to other users',
        }, { status: 403 })
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
      return NextResponse.json({
        success: false,
        error: 'Failed to send notification',
      }, { status: 500 })
    }
  },
  { name: 'push-send', rateLimit: 'write' }
)
