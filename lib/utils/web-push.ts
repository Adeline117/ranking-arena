/**
 * Web Push Notifications utility
 *
 * Uses the web-push library with VAPID keys to send
 * push notifications to subscribed browsers.
 */

import webpush from 'web-push'
import { logger } from '@/lib/logger'
import { BASE_URL } from '@/lib/constants/urls'

// ── VAPID configuration ──

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || ''
const VAPID_SUBJECT = BASE_URL

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

// ── Types ──

export type PushPayloadType = 'rank_change' | 'flash_news' | 'new_follower' | 'post_reply'

export interface PushPayload {
  type: PushPayloadType
  title: string
  body: string
  url?: string
  icon?: string
  data?: Record<string, string>
}

export interface WebPushSubscription {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
}

// ── Helpers ──

/**
 * Send a push notification to a single Web Push subscription.
 * Returns true on success, false if the subscription is invalid/expired.
 */
export async function sendPushNotification(
  subscription: WebPushSubscription,
  payload: PushPayload
): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    logger.warn('[web-push] VAPID keys not configured')
    return false
  }

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      },
      JSON.stringify(payload),
      { TTL: 60 * 60 } // 1 hour
    )
    return true
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: number }).statusCode
    if (statusCode === 404 || statusCode === 410) {
      // Subscription expired or unsubscribed
      logger.warn('[web-push] Subscription expired:', subscription.endpoint)
      return false
    }
    logger.error('[web-push] Send failed:', error)
    throw error
  }
}

export { VAPID_PUBLIC_KEY }
