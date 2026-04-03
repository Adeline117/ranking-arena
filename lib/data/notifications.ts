/**
 * 通知数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

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

export type NotificationType =
  | 'follow'
  | 'like'
  | 'comment'
  | 'system'
  | 'mention'
  | 'copy_trade'
  | 'message'
  | 'trader_alert'
  | 'post_reply'
  | 'new_follower'
  | 'group_update'

export interface NotificationListOptions {
  limit?: number
  offset?: number
  unread_only?: boolean
}

// 数据库返回的通知行类型
interface NotificationRow {
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
 * 获取用户通知列表
 */
export async function getUserNotifications(
  supabase: SupabaseClient,
  userId: string,
  options: NotificationListOptions = {}
): Promise<Notification[]> {
  const { limit = 50, offset = 0, unread_only = false } = options

  let query = supabase
    .from('notifications')
    .select('id, user_id, type, title, message, link, read, actor_id, reference_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (unread_only) {
    query = query.eq('read', false)
  }

  const { data, error } = await query

  if (error) {
    throw error
  }

  if (!data || data.length === 0) return []

  // 获取触发者信息
  const actorIds = [...new Set(data.map(n => n.actor_id).filter(Boolean))]
  const actorMap = new Map<string, { handle: string; avatar_url: string | null }>()

  if (actorIds.length > 0) {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, handle, avatar_url')
      .in('id', actorIds)

    if (profiles) {
      profiles.forEach((p: { id: string; handle: string; avatar_url: string | null }) => {
        actorMap.set(p.id, { handle: p.handle, avatar_url: p.avatar_url })
      })
    }
  }

  return data.map((n: NotificationRow) => {
    const actor = n.actor_id ? actorMap.get(n.actor_id) : undefined
    return {
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
      actor_handle: actor?.handle,
      actor_avatar_url: actor?.avatar_url || undefined,
    }
  })
}

/**
 * 获取未读通知数量
 */
export async function getUnreadNotificationCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false)

  if (error) return 0
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


