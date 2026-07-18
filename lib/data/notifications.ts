/**
 * 通知数据层
 *
 * 所有 API route 发送通知必须使用 sendNotification()。
 * 它强制 fire-and-forget + dedup，防止：
 * 1. 通知阻塞 API 响应
 * 2. 重复通知轰炸用户
 * 3. 通知失败影响主流程
 *
 * 仅 cron 批量通知可直接 insert（已有自己的 dedup 逻辑）。
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import type { NotificationType as PersistedNotificationType } from '@/lib/types/notification'

export interface Notification {
  id: string
  user_id: string
  type: NotificationType
  title: string
  message: string
  link?: string
  read: boolean
  actor_id?: string
  reference_id?: string
  created_at: string
  // 关联信息
  actor_handle?: string
  actor_avatar_url?: string
}

export type NotificationType = PersistedNotificationType

export interface NotificationListOptions {
  limit?: number
  offset?: number
  unread_only?: boolean
}

// 数据库返回的通知行类型
interface _NotificationRow {
  id: string
  user_id: string
  type: NotificationType
  title: string
  message: string
  link?: string
  read: boolean
  actor_id?: string
  reference_id?: string
  created_at: string
}

/**
 * 获取用户通知列表 + 未读数（单次 RPC 调用，含 actor JOIN）
 */
export async function getUserNotificationsWithCount(
  supabase: SupabaseClient,
  userId: string,
  options: NotificationListOptions = {}
): Promise<{ notifications: Notification[]; unreadCount: number }> {
  const { limit = 50, offset = 0, unread_only = false } = options

  const { data, error } = await supabase.rpc('get_user_notifications', {
    p_user_id: userId,
    p_limit: limit,
    p_offset: offset,
    p_unread_only: unread_only,
  })

  if (error) {
    throw error
  }

  if (!data || data.length === 0) {
    // Still need unread count even when no notifications on this page
    const { count } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('read', false)
    return { notifications: [], unreadCount: count || 0 }
  }

  // unread_count is the same on every row (CROSS JOIN)
  const unreadCount = Number(data[0].unread_count) || 0

  const notifications: Notification[] = data.map(
    (n: {
      id: string
      user_id: string
      type: NotificationType
      title: string
      message: string
      link?: string
      read: boolean
      actor_id?: string
      reference_id?: string
      created_at: string
      actor_handle?: string
      actor_avatar_url?: string
    }) => ({
      id: n.id,
      user_id: n.user_id,
      type: n.type,
      title: n.title,
      message: n.message,
      link: n.link,
      read: n.read,
      actor_id: n.actor_id,
      reference_id: n.reference_id,
      created_at: n.created_at,
      actor_handle: n.actor_handle || undefined,
      actor_avatar_url: n.actor_avatar_url || undefined,
    })
  )

  return { notifications, unreadCount }
}

/**
 * 获取用户通知列表（兼容旧调用方，内部使用 RPC）
 */
export async function getUserNotifications(
  supabase: SupabaseClient,
  userId: string,
  options: NotificationListOptions = {}
): Promise<Notification[]> {
  const { notifications } = await getUserNotificationsWithCount(supabase, userId, options)
  return notifications
}

/**
 * 获取未读通知数量
 */
export async function getUnreadNotificationCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  // KEEP 'exact' — scoped to a single user via (user_id, read) index,
  // tiny row set per user, and the exact number is shown as the
  // notification badge (e.g. "3 unread").
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false)

  if (error) {
    // A failed count must not read as a confident "0 unread" — the badge would
    // hide real notifications with no signal. Log so the failure is observable.
    logger.error('[notifications] getUnreadNotificationCount failed', {
      userId,
      error: error.message,
    })
    return 0
  }
  return count || 0
}

/**
 * 标记通知为已读
 */
export async function markNotificationAsRead(
  supabase: SupabaseClient,
  notificationId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('user_id', userId)

  if (error) {
    throw error
  }
}

/**
 * 统一通知入口 — 所有 API route 必须使用这个函数发送通知。
 * 强制 fire-and-forget + dedup，不阻塞响应，不影响主流程。
 *
 * @example
 * sendNotification(supabase, {
 *   user_id: targetUserId,
 *   type: 'comment',
 *   title: `${handle} commented on your post`,
 *   message: content.slice(0, 100),
 *   actor_id: currentUserId,
 *   link: `/post/${postId}`,
 *   reference_id: postId,
 * }, 'Comment notification')
 */
export function sendNotification(
  supabase: SupabaseClient,
  notification: {
    user_id: string
    type: NotificationType
    title: string
    message: string
    link?: string
    actor_id?: string
    reference_id?: string
    read?: boolean
  },
  context: string
): void {
  fireAndForget(createNotificationDeduped(supabase, notification), context)
}

/**
 * 批量通知入口 — fire-and-forget，每条独立 dedup。
 * 用于 @mentions 等一次通知多人的场景。
 */
export function sendNotifications(
  supabase: SupabaseClient,
  notifications: Array<{
    user_id: string
    type: NotificationType
    title: string
    message: string
    link?: string
    actor_id?: string
    reference_id?: string
    read?: boolean
  }>,
  context: string
): void {
  if (notifications.length === 0) return
  fireAndForget(
    Promise.all(notifications.map((n) => createNotificationDeduped(supabase, n))),
    context
  )
}

/**
 * 标记所有通知为已读
 */
export async function markAllNotificationsAsRead(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('read', false)

  if (error) {
    logger.error('[notifications] 标记全部已读失败:', error)
    throw error
  }
}

/**
 * 创建通知（用于系统通知等）
 */
export async function createNotification(
  supabase: SupabaseClient,
  notification: {
    user_id: string
    type: NotificationType
    title: string
    message: string
    link?: string
    actor_id?: string
    reference_id?: string
  }
): Promise<Notification> {
  const { data, error } = await supabase
    .from('notifications')
    .insert(notification)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

/**
 * 去重通知：同一 actor + type + reference 在 1 小时内不重复发送
 * 用于 like/comment/follow 等高频操作，防止通知轰炸
 */
export async function createNotificationDeduped(
  supabase: SupabaseClient,
  notification: {
    user_id: string
    type: NotificationType
    title: string
    message: string
    link?: string
    actor_id?: string
    reference_id?: string
    read?: boolean
  }
): Promise<void> {
  // Check for recent duplicate (same actor + type + reference within 1 hour)
  if (notification.actor_id && notification.reference_id) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data: existing } = await supabase
      .from('notifications')
      .select('id')
      .eq('user_id', notification.user_id)
      .eq('type', notification.type)
      .eq('actor_id', notification.actor_id)
      .eq('reference_id', notification.reference_id)
      .gte('created_at', oneHourAgo)
      .limit(1)
      .maybeSingle()

    if (existing) {
      return // Duplicate within window — skip
    }
  }

  const { error } = await supabase.from('notifications').insert(notification)

  if (error) {
    logger.warn('[notifications] Deduped insert failed:', error.message)
  }
}

/**
 * 删除通知
 */
export async function deleteNotification(
  supabase: SupabaseClient,
  notificationId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('id', notificationId)
    .eq('user_id', userId)

  if (error) {
    logger.error('[notifications] 删除通知失败:', error)
    throw error
  }
}

/**
 * 清空已读通知
 */
export async function clearReadNotifications(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId)
    .eq('read', true)

  if (error) {
    throw error
  }
}
