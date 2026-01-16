/**
 * 实时更新 Hook
 * 使用 Supabase Realtime 订阅数据变化
 */

'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'

// ============================================
// 类型定义
// ============================================

type PostgresChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

interface RealtimeConfig<T> {
  /** 表名 */
  table: string
  /** 监听的事件类型 */
  event?: PostgresChangeEvent
  /** Schema 名称 */
  schema?: string
  /** 过滤条件 */
  filter?: string
  /** 变化回调 */
  onInsert?: (payload: T) => void
  onUpdate?: (payload: { old: T; new: T }) => void
  onDelete?: (payload: T) => void
  /** 是否启用 */
  enabled?: boolean
}

interface UseRealtimeReturn {
  /** 连接状态 */
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  /** 错误信息 */
  error: string | null
  /** 手动重连 */
  reconnect: () => void
}

// ============================================
// 主 Hook
// ============================================

/**
 * 订阅表的实时变化
 * 
 * @example
 * ```tsx
 * useRealtime({
 *   table: 'posts',
 *   event: '*',
 *   onInsert: (post) => setPosts(prev => [post, ...prev]),
 *   onUpdate: ({ new: newPost }) => setPosts(prev => 
 *     prev.map(p => p.id === newPost.id ? newPost : p)
 *   ),
 *   onDelete: (post) => setPosts(prev => 
 *     prev.filter(p => p.id !== post.id)
 *   ),
 * })
 * ```
 */
export function useRealtime<T extends Record<string, unknown>>(
  config: RealtimeConfig<T>
): UseRealtimeReturn {
  const {
    table,
    event = '*',
    schema = 'public',
    filter,
    onInsert,
    onUpdate,
    onDelete,
    enabled = true,
  } = config

  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected')
  const [error, setError] = useState<string | null>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)

  const handleChange = useCallback(
    (payload: RealtimePostgresChangesPayload<T>) => {
      switch (payload.eventType) {
        case 'INSERT':
          onInsert?.(payload.new as T)
          break
        case 'UPDATE':
          onUpdate?.({ old: payload.old as T, new: payload.new as T })
          break
        case 'DELETE':
          onDelete?.(payload.old as T)
          break
      }
    },
    [onInsert, onUpdate, onDelete]
  )

  const connect = useCallback(() => {
    if (!enabled) return

    setStatus('connecting')
    setError(null)

    // 创建频道
    const channelName = `realtime:${schema}:${table}:${Date.now()}`
    const channel = supabase.channel(channelName)

    // 配置监听
    const channelConfig: {
      event: PostgresChangeEvent
      schema: string
      table: string
      filter?: string
    } = {
      event,
      schema,
      table,
    }

    if (filter) {
      channelConfig.filter = filter
    }

    // @ts-expect-error - Supabase types issue with postgres_changes event
    channel
      .on(
        'postgres_changes',
        channelConfig,
        handleChange as (payload: RealtimePostgresChangesPayload<{ [key: string]: unknown }>) => void
      )
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          setStatus('connected')
        } else if (status === 'CHANNEL_ERROR') {
          setStatus('error')
          setError('频道连接失败')
        } else if (status === 'TIMED_OUT') {
          setStatus('error')
          setError('连接超时')
        } else if (status === 'CLOSED') {
          setStatus('disconnected')
        }
      })

    channelRef.current = channel
  }, [enabled, table, event, schema, filter, handleChange])

  const disconnect = useCallback(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
      setStatus('disconnected')
    }
  }, [])

  const reconnect = useCallback(() => {
    disconnect()
    connect()
  }, [disconnect, connect])

  // 初始化连接
  useEffect(() => {
    connect()
    return () => {
      disconnect()
    }
  }, [connect, disconnect])

  return { status, error, reconnect }
}

// ============================================
// 专用 Hooks
// ============================================

/**
 * 订阅帖子更新
 */
export function usePostsRealtime(callbacks: {
  onInsert?: (post: Record<string, unknown>) => void
  onUpdate?: (payload: { old: Record<string, unknown>; new: Record<string, unknown> }) => void
  onDelete?: (post: Record<string, unknown>) => void
}) {
  return useRealtime({
    table: 'posts',
    event: '*',
    ...callbacks,
  })
}

/**
 * 订阅交易员快照更新
 */
export function useTraderSnapshotsRealtime(
  source?: string,
  callbacks?: {
    onInsert?: (snapshot: Record<string, unknown>) => void
    onUpdate?: (payload: { old: Record<string, unknown>; new: Record<string, unknown> }) => void
  }
) {
  return useRealtime({
    table: 'trader_snapshots',
    event: '*',
    filter: source ? `source=eq.${source}` : undefined,
    ...callbacks,
  })
}

/**
 * 订阅通知更新
 */
export function useNotificationsRealtime(
  userId: string | undefined,
  onNewNotification?: (notification: Record<string, unknown>) => void
) {
  return useRealtime({
    table: 'notifications',
    event: 'INSERT',
    filter: userId ? `user_id=eq.${userId}` : undefined,
    onInsert: onNewNotification,
    enabled: !!userId,
  })
}

/**
 * 订阅消息更新
 */
export function useMessagesRealtime(
  conversationId: string | undefined,
  onNewMessage?: (message: Record<string, unknown>) => void
) {
  return useRealtime({
    table: 'messages',
    event: 'INSERT',
    filter: conversationId ? `conversation_id=eq.${conversationId}` : undefined,
    onInsert: onNewMessage,
    enabled: !!conversationId,
  })
}

// ============================================
// 在线状态 Hook
// ============================================

interface PresenceState {
  onlineUsers: string[]
  isOnline: boolean
}

/**
 * 订阅用户在线状态
 */
export function usePresence(
  roomId: string,
  userId?: string
): PresenceState {
  const [onlineUsers, setOnlineUsers] = useState<string[]>([])
  const channelRef = useRef<RealtimeChannel | null>(null)

  useEffect(() => {
    if (!userId) return

    const channel = supabase.channel(`presence:${roomId}`)

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        const users = Object.keys(state)
        setOnlineUsers(users)
      })
      .on('presence', { event: 'join' }, ({ key }) => {
        setOnlineUsers((prev) => [...new Set([...prev, key])])
      })
      .on('presence', { event: 'leave' }, ({ key }) => {
        setOnlineUsers((prev) => prev.filter((u) => u !== key))
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user_id: userId, online_at: new Date().toISOString() })
        }
      })

    channelRef.current = channel

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
      }
    }
  }, [roomId, userId])

  return {
    onlineUsers,
    isOnline: userId ? onlineUsers.includes(userId) : false,
  }
}
