/**
 * 实时更新 Hook
 * 使用 Supabase Realtime 订阅数据变化
 * 增强功能：连接池复用、自动重连、心跳检测、连接状态管理
 */

'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { channelPool } from '@/lib/realtime/channel-pool'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { realtimeLogger } from '@/lib/utils/logger'

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
  /** Viewer/session owner used to prevent cross-account channel reuse. */
  scopeKey?: string
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
  /** 是否使用连接池（默认 true，推荐） */
  usePool?: boolean
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
// 连接池模式 Hook
// ============================================

/**
 * 使用连接池的实时订阅（推荐）
 * 多个组件订阅同一表时共享连接
 */
function useRealtimePooled<T extends Record<string, unknown>>(
  config: RealtimeConfig<T>
): UseRealtimeReturn {
  const {
    table,
    event = '*',
    schema = 'public',
    filter,
    scopeKey,
    onInsert,
    onUpdate,
    onDelete,
    enabled = true,
    onStatusChange,
    onConnect,
    onDisconnect,
  } = config

  const [status, setStatusInternal] = useState<ConnectionStatus>('disconnected')
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const setStatus = useCallback(
    (newStatus: ConnectionStatus) => {
      setStatusInternal(newStatus)
      onStatusChange?.(newStatus)
    },
    [onStatusChange]
  )

  // Subscribe using pool
  useEffect(() => {
    if (!enabled) {
      setStatus('disconnected')
      return
    }

    setStatus('connecting')

    unsubscribeRef.current = channelPool.subscribe(
      { schema, table, event, filter, scopeKey },
      {
        onInsert: onInsert as ((payload: Record<string, unknown>) => void) | undefined,
        onUpdate: onUpdate as
          | ((payload: { old: Record<string, unknown>; new: Record<string, unknown> }) => void)
          | undefined,
        onDelete: onDelete as ((payload: Record<string, unknown>) => void) | undefined,
      }
    )

    // Check connection after a short delay (cleanup on unmount)
    const statusTimer = setTimeout(() => {
      if (channelPool.hasChannel(schema, table, event, filter, scopeKey)) {
        setStatus('connected')
        onConnect?.()
      }
    }, 100)

    return () => {
      clearTimeout(statusTimer)
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      onDisconnect?.()
    }
  }, [
    enabled,
    table,
    event,
    schema,
    filter,
    scopeKey,
    onInsert,
    onUpdate,
    onDelete,
    setStatus,
    onConnect,
    onDisconnect,
  ])

  const disconnect = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current()
      unsubscribeRef.current = null
    }
    setStatus('disconnected')
    onDisconnect?.()
  }, [setStatus, onDisconnect])

  const reconnect = useCallback(() => {
    disconnect()
    // Will auto-reconnect via useEffect when enabled is true
  }, [disconnect])

  return {
    status,
    error: null,
    reconnect,
    disconnect,
    retryCount: 0,
    isReconnecting: false,
  }
}

// ============================================
// 独立连接模式 Hook（用于需要独立控制的场景）
// ============================================

/**
 * 独立连接的实时订阅（用于特殊场景）
 */
function useRealtimeDirect<T extends Record<string, unknown>>(
  config: RealtimeConfig<T>
): UseRealtimeReturn {
  const {
    table,
    event = '*',
    schema = 'public',
    filter,
    scopeKey,
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
  const retryCountRef = useRef(0)
  retryCountRef.current = retryCount
  const connectionGenerationRef = useRef(0)
  const connectRef = useRef<() => void>(() => {})
  // Guard against state updates after unmount (subscribe callback can fire after disconnect)
  const mountedRef = useRef(true)
  const callbacksRef = useRef({
    onInsert,
    onUpdate,
    onDelete,
    onStatusChange,
    onConnect,
    onDisconnect,
    onError,
  })
  callbacksRef.current = {
    onInsert,
    onUpdate,
    onDelete,
    onStatusChange,
    onConnect,
    onDisconnect,
    onError,
  }
  const reconnectConfigRef = useRef({ autoReconnect, maxRetries, retryBaseDelay })
  reconnectConfigRef.current = { autoReconnect, maxRetries, retryBaseDelay }

  const setStatus = useCallback((newStatus: ConnectionStatus) => {
    setStatusInternal(newStatus)
    callbacksRef.current.onStatusChange?.(newStatus)
  }, [])

  const handleChange = useCallback((payload: { eventType: string; new: unknown; old: unknown }) => {
    switch (payload.eventType) {
      case 'INSERT':
        callbacksRef.current.onInsert?.(payload.new as T)
        break
      case 'UPDATE':
        callbacksRef.current.onUpdate?.({ old: payload.old as T, new: payload.new as T })
        break
      case 'DELETE':
        callbacksRef.current.onDelete?.(payload.old as T)
        break
    }
  }, [])

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [])

  const disconnect = useCallback(() => {
    connectionGenerationRef.current += 1
    mountedRef.current = false // prevent subscribe callback from firing after cleanup
    clearRetryTimeout()
    isReconnectingRef.current = false

    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }

    setStatus('disconnected')
    retryCountRef.current = 0
    setRetryCount(0)
    callbacksRef.current.onDisconnect?.()
  }, [clearRetryTimeout, setStatus])

  const scheduleReconnect = useCallback(
    (connectionGeneration: number) => {
      if (!mountedRef.current || connectionGenerationRef.current !== connectionGeneration) {
        return
      }
      const { autoReconnect, maxRetries, retryBaseDelay } = reconnectConfigRef.current
      const currentRetryCount = retryCountRef.current
      if (!autoReconnect || currentRetryCount >= maxRetries) {
        setStatus('error')
        setError(`重连失败，已达到最大重试次数 (${maxRetries})`)
        callbacksRef.current.onError?.(`重连失败，已达到最大重试次数 (${maxRetries})`)
        isReconnectingRef.current = false
        return
      }

      const delay = calculateBackoffDelay(currentRetryCount, retryBaseDelay)
      realtimeLogger.info(`将在 ${delay}ms 后重连 (尝试 ${currentRetryCount + 1}/${maxRetries})`)

      setStatus('reconnecting')
      isReconnectingRef.current = true

      retryTimeoutRef.current = setTimeout(() => {
        if (!mountedRef.current || connectionGenerationRef.current !== connectionGeneration) {
          return
        }
        retryCountRef.current += 1
        setRetryCount(retryCountRef.current)
        connectRef.current()
      }, delay)
    },
    [setStatus]
  )

  const connect = useCallback(() => {
    if (!enabled) return

    const connectionGeneration = connectionGenerationRef.current + 1
    connectionGenerationRef.current = connectionGeneration
    mountedRef.current = true // re-arm for reconnect scenarios

    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }

    setStatus('connecting')
    setError(null)

    // Use a stable channel name (no Date.now())
    const scope = scopeKey === undefined ? 'shared' : `scoped:${encodeURIComponent(scopeKey)}`
    const channelName = `direct:${scope}:${schema}:${table}:${filter || 'all'}`
    const channel = supabase.channel(channelName)
    const handleScopedChange = (payload: { eventType: string; new: unknown; old: unknown }) => {
      if (
        !mountedRef.current ||
        connectionGenerationRef.current !== connectionGeneration ||
        channelRef.current !== channel
      ) {
        return
      }
      handleChange(payload)
    }

    channel
      .on(
        'postgres_changes',
        { event, schema, table, ...(filter ? { filter } : {}) },
        handleScopedChange
      )
      .subscribe((subscribeStatus: string) => {
        // Guard: if component unmounted while subscribe was in-flight, bail out.
        // Without this, the callback would call setState on an unmounted component
        // and potentially scheduleReconnect, leaking a new channel.
        if (
          !mountedRef.current ||
          connectionGenerationRef.current !== connectionGeneration ||
          channelRef.current !== channel
        ) {
          return
        }

        if (subscribeStatus === 'SUBSCRIBED') {
          setStatus('connected')
          retryCountRef.current = 0
          setRetryCount(0)
          isReconnectingRef.current = false
          callbacksRef.current.onConnect?.()
        } else if (subscribeStatus === 'CHANNEL_ERROR') {
          const errorMsg = '频道连接失败'
          setStatus('error')
          setError(errorMsg)
          callbacksRef.current.onError?.(errorMsg)
          if (reconnectConfigRef.current.autoReconnect) scheduleReconnect(connectionGeneration)
        } else if (subscribeStatus === 'TIMED_OUT') {
          const errorMsg = '连接超时'
          setStatus('error')
          setError(errorMsg)
          callbacksRef.current.onError?.(errorMsg)
          if (reconnectConfigRef.current.autoReconnect) scheduleReconnect(connectionGeneration)
        } else if (subscribeStatus === 'CLOSED') {
          setStatus('disconnected')
          if (enabled && reconnectConfigRef.current.autoReconnect && !isReconnectingRef.current) {
            scheduleReconnect(connectionGeneration)
          }
        }
      })

    channelRef.current = channel
  }, [enabled, table, event, schema, filter, scopeKey, handleChange, setStatus, scheduleReconnect])
  connectRef.current = connect

  const reconnect = useCallback(() => {
    clearRetryTimeout()
    setRetryCount(0)
    isReconnectingRef.current = false
    connect()
  }, [clearRetryTimeout, connect])

  useEffect(() => {
    if (!enabled) return
    connect()
    return () => disconnect()
  }, [connect, disconnect, enabled])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleOnline = () => {
      realtimeLogger.info('网络恢复，尝试重连')
      if (status !== 'connected' && enabled) reconnect()
    }

    const handleOffline = () => {
      realtimeLogger.warn('网络断开')
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
// 主 Hook
// ============================================

/**
 * 订阅表的实时变化（增强版）
 *
 * 特性：
 * - 连接池复用（默认启用，防止连接泄漏）
 * - 自动重连（指数退避）
 * - 连接状态管理
 * - 错误恢复
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
 *   onStatusChange: (status) => console.log('Connection:', status),
 * })
 * ```
 */
export function useRealtime<T extends Record<string, unknown>>(
  config: RealtimeConfig<T>
): UseRealtimeReturn {
  const { usePool = true, enabled = true } = config

  // Always call both hooks unconditionally to satisfy React's rules of hooks
  // Only one will actually be enabled based on usePool
  const pooledResult = useRealtimePooled({ ...config, enabled: enabled && usePool })
  const directResult = useRealtimeDirect({ ...config, enabled: enabled && !usePool })

  // Return the appropriate result based on usePool preference
  return usePool ? pooledResult : directResult
}

// ============================================
// 专用 Hooks
// ============================================

/**
 * 订阅帖子更新
 */
export function usePostsRealtime(
  callbacks: {
    onInsert?: (post: Record<string, unknown>) => void
    onUpdate?: (payload: { old: Record<string, unknown>; new: Record<string, unknown> }) => void
    onDelete?: (post: Record<string, unknown>) => void
  },
  options?: { scopeKey?: string; enabled?: boolean }
) {
  return useRealtime({
    table: 'posts',
    event: '*',
    scopeKey: options?.scopeKey,
    enabled: options?.enabled,
    ...callbacks,
  })
}

/**
 * 订阅交易员快照更新
 */
export function useTraderSnapshotsRealtime(
  platform?: string,
  callbacks?: {
    onInsert?: (snapshot: Record<string, unknown>) => void
    onUpdate?: (payload: { old: Record<string, unknown>; new: Record<string, unknown> }) => void
  }
) {
  return useRealtime({
    table: 'trader_snapshots_v2',
    event: '*',
    filter: platform ? `platform=eq.${platform}` : undefined,
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
    table: 'direct_messages',
    event: 'INSERT',
    filter: conversationId ? `conversation_id=eq.${conversationId}` : undefined,
    onInsert: onNewMessage,
    enabled: !!conversationId,
  })
}

/**
 * 订阅评论更新（当用户在查看帖子详情时）
 */
export function useCommentsRealtime(
  postId: string | undefined,
  callbacks?: {
    onInsert?: (comment: Record<string, unknown>) => void
    onDelete?: (comment: Record<string, unknown>) => void
  },
  options?: { scopeKey?: string; enabled?: boolean }
) {
  return useRealtime({
    table: 'comments',
    event: '*',
    filter: postId ? `post_id=eq.${postId}` : undefined,
    onInsert: callbacks?.onInsert,
    onDelete: callbacks?.onDelete,
    scopeKey: options?.scopeKey,
    enabled: !!postId && (options?.enabled ?? true),
  })
}

// ============================================
// 在线状态 Hook — use usePresence from './usePresence' for full-featured presence
// ============================================

// ============================================
// 导出连接池统计（用于监控）
// ============================================

export function getRealtimePoolStats() {
  return channelPool.getStats()
}
