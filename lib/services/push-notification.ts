/**
 * 推送通知服务
 * 
 * 支持 FCM (Android) 和 APNs (iOS) 推送通知
 * 用于交易员变动提醒等功能
 */

import { createClient } from '@supabase/supabase-js'
import { sendPushNotification as sendWebPush } from '@/lib/utils/web-push'
import type { PushPayload } from '@/lib/utils/web-push'

// ============================================
// 类型定义
// ============================================

export type PushProvider = 'fcm' | 'apns' | 'web'

export interface PushSubscription {
  id: string
  userId: string
  token: string
  provider: PushProvider
  deviceId?: string
  deviceName?: string
  platform?: 'ios' | 'android' | 'web'
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface PushNotification {
  title: string
  body: string
  data?: Record<string, string>
  imageUrl?: string
  badge?: number
  sound?: string
  channelId?: string
}

export interface SendResult {
  success: boolean
  messageId?: string
  error?: string
}

// ============================================
// FCM 消息结构
// ============================================

interface FCMMessage {
  message: {
    token: string
    notification: {
      title: string
      body: string
      image?: string
    }
    data?: Record<string, string>
    android?: {
      priority: 'high' | 'normal'
      notification?: {
        channel_id?: string
        sound?: string
        click_action?: string
      }
    }
    apns?: {
      headers?: {
        'apns-priority'?: '5' | '10'
      }
      payload?: {
        aps?: {
          badge?: number
          sound?: string
          'content-available'?: number
        }
      }
    }
  }
}

// ============================================
// 推送通知服务类
// ============================================

export class PushNotificationService {
  private supabase: ReturnType<typeof createClient>
  private fcmServerKey: string | null

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    })
    this.fcmServerKey = process.env.FCM_SERVER_KEY || null
  }

  /**
   * 注册推送订阅
   */
  async registerSubscription(
    userId: string,
    token: string,
    provider: PushProvider,
    options?: {
      deviceId?: string
      deviceName?: string
      platform?: 'ios' | 'android' | 'web'
      endpoint?: string
      p256dh?: string
      auth?: string
    }
  ): Promise<PushSubscription> {
     
    const { data, error } = await (this.supabase as any)
      .from('push_subscriptions')
      .upsert({
        user_id: userId,
        token,
        provider,
        device_id: options?.deviceId,
        device_name: options?.deviceName,
        platform: options?.platform,
        endpoint: options?.endpoint,
        p256dh: options?.p256dh,
        auth: options?.auth,
        enabled: true,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,token',
      })
      .select()
      .single()

    if (error) {
      console.error('[PushNotification] 注册订阅失败:', error)
      throw error
    }

    return this.mapSubscription(data)
  }

  /**
   * 取消推送订阅
   */
  async unregisterSubscription(userId: string, token: string): Promise<void> {
     
    const { error } = await (this.supabase as any)
      .from('push_subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('token', token)

    if (error) {
      console.error('[PushNotification] 取消订阅失败:', error)
      throw error
    }
  }

  /**
   * 禁用推送订阅（保留记录）
   */
  async disableSubscription(userId: string, token: string): Promise<void> {
     
    const { error } = await (this.supabase as any)
      .from('push_subscriptions')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('token', token)

    if (error) {
      console.error('[PushNotification] 禁用订阅失败:', error)
      throw error
    }
  }

  /**
   * 获取用户的所有推送订阅
   */
  async getUserSubscriptions(userId: string): Promise<PushSubscription[]> {
     
    const { data, error } = await (this.supabase as any)
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('enabled', true)

    if (error) {
      console.error('[PushNotification] 获取订阅失败:', error)
      throw error
    }

    return (data || []).map(this.mapSubscription)
  }

  /**
   * 发送推送通知给单个用户
   */
  async sendToUser(
    userId: string,
    notification: PushNotification
  ): Promise<SendResult[]> {
    const subscriptions = await this.getUserSubscriptions(userId)
    
    if (subscriptions.length === 0) {
      return [{ success: false, error: '用户没有有效的推送订阅' }]
    }

    const results: SendResult[] = []

    for (const subscription of subscriptions) {
      const result = await this.sendToToken(subscription.token, subscription.provider, notification)
      results.push(result)

      // 如果 token 无效，禁用订阅
      if (!result.success && result.error?.includes('InvalidRegistration')) {
        await this.disableSubscription(userId, subscription.token)
      }
    }

    return results
  }

  /**
   * 发送推送通知到特定 token
   */
  async sendToToken(
    token: string,
    provider: PushProvider,
    notification: PushNotification
  ): Promise<SendResult> {
    if (provider === 'fcm' || provider === 'apns') {
      return this.sendViaFCM(token, notification)
    }

    if (provider === 'web') {
      return this.sendViaWebPush(token, notification)
    }

    return { success: false, error: 'Unknown provider' }
  }

  /**
   * 通过 Web Push (VAPID) 发送推送
   */
  private async sendViaWebPush(
    token: string,
    notification: PushNotification
  ): Promise<SendResult> {
    // Look up the subscription keys from DB
    const { data: sub } = await (this.supabase as any)
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('token', token)
      .eq('enabled', true)
      .single()

    if (!sub?.endpoint || !sub?.p256dh || !sub?.auth) {
      return { success: false, error: 'Web Push subscription keys not found' }
    }

    const payload: PushPayload = {
      type: (notification.data?.type as PushPayload['type']) || 'flash_news',
      title: notification.title,
      body: notification.body,
      url: notification.data?.url,
      icon: notification.imageUrl,
    }

    try {
      const ok = await sendWebPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      )
      return ok ? { success: true } : { success: false, error: 'Subscription expired' }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /**
   * 通过 FCM 发送推送
   */
  private async sendViaFCM(
    token: string,
    notification: PushNotification
  ): Promise<SendResult> {
    if (!this.fcmServerKey) {
      console.warn('[PushNotification] FCM_SERVER_KEY 未配置')
      return { success: false, error: 'FCM 未配置' }
    }

    const message: FCMMessage = {
      message: {
        token,
        notification: {
          title: notification.title,
          body: notification.body,
          image: notification.imageUrl,
        },
        data: notification.data,
        android: {
          priority: 'high',
          notification: {
            channel_id: notification.channelId || 'default',
            sound: notification.sound || 'default',
          },
        },
        apns: {
          headers: {
            'apns-priority': '10',
          },
          payload: {
            aps: {
              badge: notification.badge,
              sound: notification.sound || 'default',
            },
          },
        },
      },
    }

    try {
      const response = await fetch(
        'https://fcm.googleapis.com/v1/projects/arena-app/messages:send',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.fcmServerKey}`,
          },
          body: JSON.stringify(message),
        }
      )

      if (!response.ok) {
        const error = await response.text()
        console.error('[PushNotification] FCM 发送失败:', error)
        return { success: false, error }
      }

      const result = await response.json()
      return { success: true, messageId: result.name }
    } catch (error) {
      console.error('[PushNotification] FCM 请求失败:', error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * 批量发送推送通知
   */
  async sendToUsers(
    userIds: string[],
    notification: PushNotification
  ): Promise<Map<string, SendResult[]>> {
    const results = new Map<string, SendResult[]>()

    for (const userId of userIds) {
      const userResults = await this.sendToUser(userId, notification)
      results.set(userId, userResults)
    }

    return results
  }

  /**
   * 发送交易员变动提醒
   */
  async sendTraderAlert(
    userId: string,
    traderHandle: string,
    alertType: 'drawdown' | 'rank_drop' | 'win_rate_drop',
    message: string
  ): Promise<SendResult[]> {
    const titles: Record<string, { zh: string; en: string }> = {
      drawdown: { zh: '回撤预警', en: 'Drawdown Alert' },
      rank_drop: { zh: '排名下降', en: 'Rank Drop Alert' },
      win_rate_drop: { zh: '胜率下滑', en: 'Win Rate Alert' },
    }

    const notification: PushNotification = {
      title: titles[alertType]?.zh || '交易员提醒',
      body: message,
      data: {
        type: 'trader_alert',
        alertType,
        traderHandle,
        url: `/trader/${traderHandle}`,
      },
      channelId: 'trader_alerts',
      sound: 'alert',
    }

    return this.sendToUser(userId, notification)
  }

  /**
   * 映射数据库记录到类型
   */
  private mapSubscription(row: Record<string, unknown>): PushSubscription {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      token: row.token as string,
      provider: row.provider as PushProvider,
      deviceId: row.device_id as string | undefined,
      deviceName: row.device_name as string | undefined,
      platform: row.platform as 'ios' | 'android' | 'web' | undefined,
      enabled: row.enabled as boolean,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    }
  }
}

// ============================================
// 全局实例工厂函数
// ============================================

let _pushService: PushNotificationService | null = null

export function getPushNotificationService(): PushNotificationService {
  if (!_pushService) {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!url || !key) {
      throw new Error('Supabase 配置缺失')
    }

    _pushService = new PushNotificationService(url, key)
  }

  return _pushService
}
