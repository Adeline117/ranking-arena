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
        error: '缺少必要参数: token, provider',
      }, { status: 400 })
    }

    const validProviders: PushProvider[] = ['fcm', 'apns', 'web']
    if (!validProviders.includes(provider)) {
      return NextResponse.json({
        success: false,
        error: '无效的 provider',
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
      console.error('[push/subscribe] 注册订阅失败:', error)
      return NextResponse.json({
        success: false,
        error: '注册订阅失败',
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
        error: '缺少必要参数: token',
      }, { status: 400 })
    }

    try {
      const service = getPushNotificationService()
      await service.unregisterSubscription(user.id, token)

      return NextResponse.json({
        success: true,
      })
    } catch (error: unknown) {
      console.error('[push/subscribe] 取消订阅失败:', error)
      return NextResponse.json({
        success: false,
        error: '取消订阅失败',
      }, { status: 500 })
    }
  },
  { name: 'push-unsubscribe', rateLimit: 'write' }
)
