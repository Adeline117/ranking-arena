/**
 * 实时更新 Hook
 * 使用 Supabase Realtime 订阅数据变化
 * 增强功能：自动重连、心跳检测、连接状态管理
 */

'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'

// ============================================
// 类型定义
// ============================================

type PostgresChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error'

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
  /** 自动重连配置 */
  autoReconnect?: boolean
  /** 最大重连次数 */
  maxRetries?: number
  /** 重连基础延迟（毫秒） */
  retryBaseDelay?: number
  /** 连接状态变化回调 */
  onStatusChange?: (status: ConnectionStatus) => void
  /** 连接成功回调 */
  onConnect?: () => void
  /** 断开连接回调 */
  onDisconnect?: () => void
  /** 错误回调 */
  onError?: (error: string) => void
}

interface UseRealtimeReturn {
  /** 连接状态 */
  status: ConnectionStatus
  /** 错误信息 */
  error: string | null
  /** 手动重连 */
  reconnect: () => void
  /** 手动断开 */
  disconnect: () => void
  /** 重连次数 */
  retryCount: number
  /** 是否正在重连 */
  isReconnecting: boolean
}

// ============================================
// 重连工具
// ============================================

/**
 * 计算指数退避延迟
 */
function calculateBackoffDelay(retryCount: number, baseDelay: number = 1000): number {
  // 指数退避：baseDelay * 2^retryCount + 随机抖动
  const exponentialDelay = baseDelay * Math.pow(2, retryCount)
  const jitter = Math.random() * 1000 // 0-1秒的随机抖动
  return Math.min(exponentialDelay + jitter, 30000) // 最大 30 秒
}

// ============================================
// 主 Hook
// ============================================

/**
 * 订阅表的实时变化（增强版）
 * 
 * 特性：
 * - 自动重连（指数退避）
 * - 连接状态管理
 * - 错误恢复
 * 
 * @example
 * ```tsx
 * useRealtime({
 *   table: 'posts',
 *   event: '*',
 *   autoReconnect: true,
 *   maxRetries: 5,
 *   onInsert: (post) => setPosts(prev => [post, ...prev]),
 *   onUpdate: ({ new: newPost }) => setPosts(prev => 
 *     prev.map(p => p.id === newPost.id ? newPost : p)
 *   ),
 *   onDelete: (post) => setPosts(prev => 
 *     prev.filter(p => p.id !== post.id)
 *   ),
 *   onStatusChange: (status) => console.log('Connection:', status),
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
    autoReconnect = true,
    maxRetries = 5,
    retryBaseDelay = 1000,
    onStatusChange,
    onConnect,
    onDisconnect,
    onError,
  } = config

  const [status, setStatusInternal] = useState<ConnectionStatus>('disconnected')
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  
  const channelRef = useRef<RealtimeChannel | null>(null)
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const isReconnectingRef = useRef(false)

  // 更新状态并通知
  const setStatus = useCallback((newStatus: ConnectionStatus) => {
    setStatusInternal(newStatus)
    onStatusChange?.(newStatus)
  }, [onStatusChange])

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

  // 清理重连定时器
  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [])

  // 断开连接
  const disconnect = useCallback(() => {
    clearRetryTimeout()
    isReconnectingRef.current = false
    
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }
    
    setStatus('disconnected')
    setRetryCount(0)
    onDisconnect?.()
  }, [clearRetryTimeout, setStatus, onDisconnect])

  // 安排重连
  const scheduleReconnect = useCallback(() => {
    if (!autoReconnect || retryCount >= maxRetries) {
      setStatus('error')
      setError(`重连失败，已达到最大重试次数 (${maxRetries})`)
      onError?.(`重连失败，已达到最大重试次数 (${maxRetries})`)
      isReconnectingRef.current = false
      return
    }

    const delay = calculateBackoffDelay(retryCount, retryBaseDelay)
    console.log(`[Realtime] 将在 ${delay}ms 后重连 (尝试 ${retryCount + 1}/${maxRetries})`)
    
    setStatus('reconnecting')
    isReconnectingRef.current = true

    retryTimeoutRef.current = setTimeout(() => {
      setRetryCount(prev => prev + 1)
      connect()
    }, delay)
  }, [autoReconnect, retryCount, maxRetries, retryBaseDelay, setStatus, onError])

  // 建立连接
  const connect = useCallback(() => {
    if (!enabled) return

    // 清理现有连接
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }

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

    channel
      .on(
        'postgres_changes' as any,
        channelConfig,
        handleChange as (payload: RealtimePostgresChangesPayload<{ [key: string]: unknown }>) => void
      )
      .subscribe((subscribeStatus: string) => {
        if (subscribeStatus === 'SUBSCRIBED') {
          setStatus('connected')
          setRetryCount(0) // 重置重连计数
          isReconnectingRef.current = false
          onConnect?.()
        } else if (subscribeStatus === 'CHANNEL_ERROR') {
          const errorMsg = '频道连接失败'
          setStatus('error')
          setError(errorMsg)
          onError?.(errorMsg)
          
          // 尝试重连
          if (autoReconnect) {
            scheduleReconnect()
          }
        } else if (subscribeStatus === 'TIMED_OUT') {
          const errorMsg = '连接超时'
          setStatus('error')
          setError(errorMsg)
          onError?.(errorMsg)
          
          // 尝试重连
          if (autoReconnect) {
            scheduleReconnect()
          }
        } else if (subscribeStatus === 'CLOSED') {
          setStatus('disconnected')
          
          // 如果不是主动断开，尝试重连
          if (enabled && autoReconnect && !isReconnectingRef.current) {
            scheduleReconnect()
          }
        }
      })

    channelRef.current = channel
  }, [enabled, table, event, schema, filter, handleChange, autoReconnect, setStatus, onConnect, onError, scheduleReconnect])

  // 手动重连
  const reconnect = useCallback(() => {
    clearRetryTimeout()
    setRetryCount(0)
    isReconnectingRef.current = false
    connect()
  }, [clearRetryTimeout, connect])

  // 初始化连接
  useEffect(() => {
    connect()
    return () => {
      disconnect()
    }
  }, []) // 只在挂载和卸载时执行

  // 监听 enabled 变化
  useEffect(() => {
    if (enabled) {
      if (status === 'disconnected') {
        connect()
      }
    } else {
      disconnect()
    }
  }, [enabled])

  // 监听网络状态
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleOnline = () => {
      console.log('[Realtime] 网络恢复，尝试重连')
      if (status !== 'connected' && enabled) {
        reconnect()
      }
    }

    const handleOffline = () => {
      console.log('[Realtime] 网络断开')
      setStatus('disconnected')
      setError('网络连接断开')
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [status, enabled, reconnect, setStatus])

  return { 
    status, 
    error, 
    reconnect, 
    disconnect,
    retryCount,
    isReconnecting: isReconnectingRef.current,
  }
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
