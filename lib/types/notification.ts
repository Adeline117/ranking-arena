/**
 * 通知相关类型定义
 */

export type NotificationType = 'follow' | 'like' | 'comment' | 'system' | 'mention' | 'copy_trade' | 'trader_alert' | 'message' | 'post_reply' | 'new_follower' | 'group_update'

export interface Notification {
  id: string
  user_id: string
  type: NotificationType
  title: string
  message: string
  link?: string | null
  read: boolean
  actor_id?: string | null
  reference_id?: string | null
  created_at: string
}

export interface NotificationWithActor extends Notification {
  actor_handle?: string
  actor_avatar_url?: string | null
}

export interface NotificationListOptions {
  limit?: number
  offset?: number
  unread_only?: boolean
}

export interface CreateNotificationInput {
  user_id: string
  type: NotificationType
  title: string
  message: string
  link?: string
  actor_id?: string
  reference_id?: string
}


