import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { PushSubscriptionTokenBodySchema } from '@/lib/push/subscription-input'
import { getPushNotificationService } from '@/lib/services/push-notification'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

/**
 * Return only the current viewer's ownership of a browser subscription.
 * The endpoint stays in the CSRF-protected body so it is not copied into
 * reverse-proxy access logs as a query parameter.
 */
export const POST = withAuth(
  async ({ user, request }) => {
    const body = await request.json().catch(() => null)
    const parsed = PushSubscriptionTokenBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid push subscription token' },
        { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
      )
    }

    try {
      const service = getPushNotificationService()
      const subscribed = await service.hasActiveSubscription(user.id, parsed.data.token)
      return NextResponse.json(
        { success: true, data: { subscribed } },
        { headers: { 'Cache-Control': 'private, no-store' } }
      )
    } catch (error: unknown) {
      logger.error('[push/subscribe/status] 查询订阅状态失败:', error)
      return NextResponse.json(
        { success: false, error: 'Failed to read push subscription status' },
        { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
      )
    }
  },
  { name: 'push-subscription-status', rateLimit: 'authenticated' }
)
