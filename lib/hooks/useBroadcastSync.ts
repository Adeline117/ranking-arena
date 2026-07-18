/**
 * 多窗口状态同步 Hook
 * 使用 BroadcastChannel API 实现同源页面间的状态同步
 *
 * 用法示例:
 * ```tsx
 * const { broadcast, subscribe } = useBroadcastSync('follow-state')
 *
 * // 广播状态变化
 * broadcast({ type: 'FOLLOW_CHANGED', traderId, following: true })
 *
 * // 订阅状态变化
 * useEffect(() => {
 *   return subscribe((data) => {
 *     if (data.type === 'FOLLOW_CHANGED') {
 *       setFollowing(data.following)
 *     }
 *   })
 * }, [subscribe])
 * ```
 */

import { useCallback, useEffect, useRef } from 'react'
import { logger } from '@/lib/logger'

export type SyncEventType =
  | 'FOLLOW_CHANGED'
  | 'TRADER_DATA_UPDATED'
  | 'USER_LOGGED_IN'
  | 'USER_LOGGED_OUT'
  | 'THEME_CHANGED'
  | 'LANGUAGE_CHANGED'

export interface SyncEvent<T = unknown> {
  type: SyncEventType
  payload: T
  timestamp: number
  sourceTabId: string
}

// 生成唯一的 Tab ID
const TAB_ID =
  typeof window !== 'undefined'
    ? `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    : 'server'

/**
 * 多窗口同步 Hook
 * @param channelName 频道名称，用于区分不同的同步场景
 */
export function useBroadcastSync<T = unknown>(channelName: string) {
  const channelRef = useRef<BroadcastChannel | null>(null)
  const listenersRef = useRef<Set<(event: SyncEvent<T>) => void>>(new Set())

  // 初始化 BroadcastChannel (or localStorage fallback for Safari < 15.4)
  useEffect(() => {
    if (typeof window === 'undefined') return

    const dispatchToListeners = (data: SyncEvent<T>) => {
      if (data.sourceTabId === TAB_ID) return
      listenersRef.current.forEach((listener) => {
        try {
          listener(data)
        } catch (error) {
          logger.error('[BroadcastSync] Listener error:', error)
        }
      })
    }

    // Prefer BroadcastChannel; fall back to localStorage storage events
    if ('BroadcastChannel' in window) {
      const channel = new BroadcastChannel(`ranking-arena:${channelName}`)
      channelRef.current = channel
      channel.onmessage = (event: MessageEvent<SyncEvent<T>>) => dispatchToListeners(event.data)
      return () => {
        channel.close()
        channelRef.current = null
      }
    }

    // localStorage fallback: storage events fire in OTHER tabs when a key changes
    const storageKey = `ranking-arena:sync:${channelName}`
    const handler = (e: StorageEvent) => {
      if (e.key !== storageKey || !e.newValue) return
      try {
        dispatchToListeners(JSON.parse(e.newValue) as SyncEvent<T>)
      } catch {
        // Malformed JSON — ignore
      }
    }
    const win = globalThis as unknown as Window
    win.addEventListener('storage', handler)
    return () => win.removeEventListener('storage', handler)
  }, [channelName])

  // 广播消息到其他窗口
  const broadcast = useCallback(
    (type: SyncEventType, payload: T) => {
      const event: SyncEvent<T> = {
        type,
        payload,
        timestamp: Date.now(),
        sourceTabId: TAB_ID,
      }

      try {
        if (channelRef.current) {
          channelRef.current.postMessage(event)
        } else if (typeof window !== 'undefined') {
          // localStorage fallback: write then immediately remove to trigger storage event
          const storageKey = `ranking-arena:sync:${channelName}`
          localStorage.setItem(storageKey, JSON.stringify(event))
          localStorage.removeItem(storageKey)
        }
      } catch (error) {
        logger.error('[BroadcastSync] Broadcast error:', error)
      }
    },
    [channelName]
  )

  // 订阅消息
  const subscribe = useCallback((listener: (event: SyncEvent<T>) => void) => {
    listenersRef.current.add(listener)

    // 返回取消订阅函数
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  // 便捷方法：订阅特定类型的事件
  const on = useCallback(
    (eventType: SyncEventType, handler: (payload: T) => void) => {
      const listener = (event: SyncEvent<T>) => {
        if (event.type === eventType) {
          handler(event.payload)
        }
      }

      return subscribe(listener)
    },
    [subscribe]
  )

  return {
    broadcast,
    subscribe,
    on,
    tabId: TAB_ID,
  }
}

// ============================================
// 预定义的同步事件类型
// ============================================

export interface FollowChangePayload {
  traderId: string
  source: string
  following: boolean
  userId: string
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderDataPayload {
  timeRange: '7D' | '30D' | '90D' | 'COMPOSITE'
  traders: unknown[]
  lastUpdated: string
  isStale?: boolean
}

export interface UserFollowChangePayload {
  targetUserId: string
  following: boolean
  currentUserId: string
}

export interface AuthChangePayload {
  userId: string | null
  handle: string | null
}

// ============================================
// 便捷 Hooks
// ============================================

/**
 * 关注状态同步 Hook
 */
export function useFollowSync() {
  return useBroadcastSync<FollowChangePayload>('follow-state')
}

/**
 * 用户关注状态同步 Hook (user-to-user follow)
 */
export function useUserFollowSync() {
  return useBroadcastSync<UserFollowChangePayload>('user-follow-state')
}

/**
 * 交易员数据同步 Hook
 */
export function useTraderDataSync() {
  return useBroadcastSync<TraderDataPayload>('trader-data')
}

/**
 * 认证状态同步 Hook
 */
export function useAuthSync() {
  return useBroadcastSync<AuthChangePayload>('auth-state')
}
