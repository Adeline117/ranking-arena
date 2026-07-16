/**
 * 推送订阅 API
 *
 * POST - 注册推送订阅
 * DELETE - 取消推送订阅
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { getPushNotificationService } from '@/lib/services/push-notification'
import {
  PushSubscriptionRegistrationSchema,
  PushSubscriptionTokenBodySchema,
} from '@/lib/push/subscription-input'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

// 注册推送订阅
export const POST = withAuth(
  async ({ user, request }) => {
    const body = await request.json().catch(() => null)
    const parsed = PushSubscriptionRegistrationSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid push subscription' },
        { status: 400 }
      )
    }

    const { token, provider, deviceId, deviceName, platform, endpoint, p256dh, auth } = parsed.data

    try {
      const service = getPushNotificationService()
      const subscription = await service.registerSubscription(user.id, token, provider, {
        deviceId,
        deviceName,
        platform,
        endpoint,
        p256dh,
        auth,
      })

      return NextResponse.json({
        success: true,
        data: subscription,
      })
    } catch (error: unknown) {
      logger.error('[push/subscribe] 注册订阅Failed:', error)
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to register subscription',
        },
        { status: 500 }
      )
    }
  },
  { name: 'push-subscribe', rateLimit: 'write' }
)

// 取消推送订阅
export const DELETE = withAuth(
  async ({ user, request }) => {
    const body = await request.json().catch(() => null)
    const parsed = PushSubscriptionTokenBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid push subscription token' },
        { status: 400 }
      )
    }

    try {
      const service = getPushNotificationService()
      await service.unregisterSubscription(user.id, parsed.data.token)

      return NextResponse.json({
        success: true,
      })
    } catch (error: unknown) {
      logger.error('[push/subscribe] 取消订阅Failed:', error)
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to unsubscribe',
        },
        { status: 500 }
      )
    }
  },
  { name: 'push-unsubscribe', rateLimit: 'write' }
)
