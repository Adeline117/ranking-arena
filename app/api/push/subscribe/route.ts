/**
 * 推送订阅 API
 * 
 * POST - 注册推送订阅
 * DELETE - 取消推送订阅
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { getPushNotificationService } from '@/lib/services/push-notification'
import type { PushProvider } from '@/lib/services/push-notification'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

// 注册推送订阅
export const POST = withAuth(
  async ({ user, request }) => {
    const body = await request.json()
    const { token, provider, deviceId, deviceName, platform, endpoint, p256dh, auth } = body

    // 验证参数
    if (!token || !provider) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: token, provider',
      }, { status: 400 })
    }

    const validProviders: PushProvider[] = ['fcm', 'apns', 'web']
    if (!validProviders.includes(provider)) {
      return NextResponse.json({
        success: false,
        error: 'Invalid provider',
      }, { status: 400 })
    }

    try {
      const service = getPushNotificationService()
      const subscription = await service.registerSubscription(
        user.id,
        token,
        provider,
        { deviceId, deviceName, platform, endpoint, p256dh, auth }
      )

      return NextResponse.json({
        success: true,
        data: subscription,
      })
    } catch (error: unknown) {
      logger.error('[push/subscribe] 注册订阅Failed:', error)
      return NextResponse.json({
        success: false,
        error: 'Failed to register subscription',
      }, { status: 500 })
    }
  },
  { name: 'push-subscribe', rateLimit: 'write' }
)

// 取消推送订阅
export const DELETE = withAuth(
  async ({ user, request }) => {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')

    if (!token) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameter: token',
      }, { status: 400 })
    }

    try {
      const service = getPushNotificationService()
      await service.unregisterSubscription(user.id, token)

      return NextResponse.json({
        success: true,
      })
    } catch (error: unknown) {
      logger.error('[push/subscribe] 取消订阅Failed:', error)
      return NextResponse.json({
        success: false,
        error: 'Failed to unsubscribe',
      }, { status: 500 })
    }
  },
  { name: 'push-unsubscribe', rateLimit: 'write' }
)
