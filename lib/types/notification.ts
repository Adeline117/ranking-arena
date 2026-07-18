/**
 * 通知相关类型定义
 */

// Canonical persisted notification vocabulary. The database CHECK migration
// has a contract test against this exact list; generic send APIs intentionally
// expose only a smaller, separately reviewed subset.
export const PERSISTED_NOTIFICATION_TYPES = [
  'follow',
  'like',
  'reaction',
  'comment',
  'system',
  'mention',
  'copy_trade',
  'message',
  'trader_alert',
  'trader_alert_roi',
  'trader_alert_drawdown',
  'trader_alert_score',
  'trader_alert_pnl',
  'trader_alert_rank',
  'post_reply',
  'new_follower',
  'group_update',
  'ranking_change',
  'referral_reward',
  'tip_received',
  'subscription_expiring',
  'subscription_expired',
  'nft_expired',
  'nft_pending',
  'nft_minted',
] as const

export type NotificationType = (typeof PERSISTED_NOTIFICATION_TYPES)[number]

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
