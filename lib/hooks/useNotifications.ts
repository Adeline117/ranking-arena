/**
 * 通知管理 Hook
 * 
 * 提供通知列表获取、未读计数、标记已读等功能
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuthSession } from './useAuthSession'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { getCsrfHeaders } from '@/lib/api/client'
import { type NotificationWithActor } from '@/lib/types'
import { logger } from '@/lib/logger'

interface UseNotificationsOptions {
  /** 每页数量 */
  limit?: number
  /** 是否只获取未读 */
  unreadOnly?: boolean
  /** 是否自动加载 */
  autoFetch?: boolean
}

interface UseNotificationsReturn {
  notifications: NotificationWithActor[]
  unreadCount: number
  loading: boolean
  hasMore: boolean
  /** 加载/刷新通知 */
  refresh: () => Promise<void>
  /** 加载更多 */
  loadMore: () => Promise<void>
  /** 标记单条已读 */
  markAsRead: (id: string) => Promise<void>
  /** 标记全部已读 */
  markAllAsRead: () => Promise<void>
  /** 删除通知 */
  deleteNotification: (id: string) => Promise<void>
}

export function useNotifications(options: UseNotificationsOptions = {}): UseNotificationsReturn {
  const { limit = 50, unreadOnly = false, autoFetch = true } = options
  const { accessToken } = useAuthSession()
  const setUnreadNotifications = useInboxStore((s) => s.setUnreadNotifications)

  const [notifications, setNotifications] = useState<NotificationWithActor[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  const pendingRef = useRef(false)
  const mountedRef = useRef(true)

  const fetchNotifications = useCallback(async (fetchOffset = 0, append = false) => {
    if (!accessToken || pendingRef.current) return
    pendingRef.current = true
    if (!append) setLoading(true)

    try {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(fetchOffset),
      })
      if (unreadOnly) params.set('unread_only', 'true')

      const res = await fetch(`/api/notifications?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error('Failed to fetch')

      const result = await res.json()
      if (!mountedRef.current) return
      const data = result.data || result
      const items: NotificationWithActor[] = data.notifications || []
      const count = data.unread_count ?? 0

      if (append) {
        setNotifications((prev) => [...prev, ...items])
      } else {
        setNotifications(items)
      }
      setUnreadCount(count)
      setUnreadNotifications(count)
      setHasMore(items.length === limit)
      setOffset(fetchOffset + items.length)
    } catch (err) {
      logger.error('[useNotifications] fetch error:', err)
    } finally {
      if (mountedRef.current) setLoading(false)
      pendingRef.current = false
    }
  }, [accessToken, limit, unreadOnly, setUnreadNotifications])

  const refresh = useCallback(() => fetchNotifications(0, false), [fetchNotifications])
  const loadMore = useCallback(() => fetchNotifications(offset, true), [fetchNotifications, offset])

  const markAsRead = useCallback(async (id: string) => {
    if (!accessToken) return
    const prev = notifications.find((n) => n.id === id)
    if (!prev || prev.read) return

    // 乐观更新
    setNotifications((ns) => ns.map((n) => n.id === id ? { ...n, read: true } : n))
    const newCount = Math.max(0, unreadCount - 1)
    setUnreadCount(newCount)
    setUnreadNotifications(newCount)

    try {
      const res = await fetch('/api/notifications', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ notification_id: id }),
      })
      if (!res.ok) throw new Error('Failed')
    } catch (_err) {
      // 回滚
      setNotifications((ns) => ns.map((n) => n.id === id ? { ...n, read: false } : n))
      setUnreadCount(unreadCount)
      setUnreadNotifications(unreadCount)
    }
  }, [accessToken, notifications, unreadCount, setUnreadNotifications])

  const markAllAsRead = useCallback(async () => {
    if (!accessToken) return
    const prevNotifications = [...notifications]
    const prevCount = unreadCount

    setNotifications((ns) => ns.map((n) => ({ ...n, read: true })))
    setUnreadCount(0)
    setUnreadNotifications(0)

    try {
      const res = await fetch('/api/notifications', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ mark_all: true }),
      })
      if (!res.ok) throw new Error('Failed')
    } catch (_err) {
      // rollback optimistic update
      setNotifications(prevNotifications)
      setUnreadCount(prevCount)
      setUnreadNotifications(prevCount)
    }
  }, [accessToken, notifications, unreadCount, setUnreadNotifications])

  const deleteNotification = useCallback(async (id: string) => {
    if (!accessToken) return
    const prev = [...notifications]
    const target = notifications.find((n) => n.id === id)

    setNotifications((ns) => ns.filter((n) => n.id !== id))
    if (target && !target.read) {
      const newCount = Math.max(0, unreadCount - 1)
      setUnreadCount(newCount)
      setUnreadNotifications(newCount)
    }

    try {
      const res = await fetch('/api/notifications', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ notification_id: id }),
      })
      if (!res.ok) throw new Error('Failed')
    } catch (_err) {
      // rollback optimistic update
      setNotifications(prev)
      if (target && !target.read) {
        setUnreadCount(unreadCount)
        setUnreadNotifications(unreadCount)
      }
    }
  }, [accessToken, notifications, unreadCount, setUnreadNotifications])

  useEffect(() => {
    mountedRef.current = true
    if (autoFetch && accessToken) {
      fetchNotifications(0, false)
    }
    return () => { mountedRef.current = false }
  }, [autoFetch, accessToken, fetchNotifications])

  return {
    notifications,
    unreadCount,
    loading,
    hasMore,
    refresh,
    loadMore,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  }
}
