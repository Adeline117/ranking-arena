/**
 * 网络状态检测和离线支持 Hooks
 * 
 * 功能:
 * - 检测在线/离线状态
 * - 网络质量检测
 * - 离线数据缓存
 * - 重连自动同步
 */

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'

// ============================================
// useNetworkStatus - 网络状态检测
// ============================================

export type NetworkStatus = 'online' | 'offline' | 'slow'
export type ConnectionType = '4g' | '3g' | '2g' | 'slow-2g' | 'unknown'

export interface NetworkInfo {
  status: NetworkStatus
  online: boolean
  connectionType: ConnectionType
  effectiveType: string | null
  downlink: number | null // Mbps
  rtt: number | null // ms
  saveData: boolean
}

export function useNetworkStatus() {
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo>({
    status: 'online',
    online: true,
    connectionType: 'unknown',
    effectiveType: null,
    downlink: null,
    rtt: null,
    saveData: false,
  })

  const updateNetworkInfo = useCallback(() => {
    const online = navigator.onLine
    
    // 获取 Network Information API 数据 (如果支持)
    const connection = (navigator as any).connection || 
                       (navigator as any).mozConnection || 
                       (navigator as any).webkitConnection

    let connectionType: ConnectionType = 'unknown'
    let effectiveType: string | null = null
    let downlink: number | null = null
    let rtt: number | null = null
    let saveData = false

    if (connection) {
      effectiveType = connection.effectiveType
      downlink = connection.downlink
      rtt = connection.rtt
      saveData = connection.saveData || false

      // 判断连接类型
      if (effectiveType === '4g') {
        connectionType = '4g'
      } else if (effectiveType === '3g') {
        connectionType = '3g'
      } else if (effectiveType === '2g') {
        connectionType = '2g'
      } else if (effectiveType === 'slow-2g') {
        connectionType = 'slow-2g'
      }
    }

    // 判断网络状态
    let status: NetworkStatus = 'online'
    if (!online) {
      status = 'offline'
    } else if (connectionType === '2g' || connectionType === 'slow-2g' || (rtt && rtt > 1000)) {
      status = 'slow'
    }

    setNetworkInfo({
      status,
      online,
      connectionType,
      effectiveType,
      downlink,
      rtt,
      saveData,
    })
  }, [])

  useEffect(() => {
    updateNetworkInfo()

    window.addEventListener('online', updateNetworkInfo)
    window.addEventListener('offline', updateNetworkInfo)

    // 监听连接变化
    const connection = (navigator as any).connection || 
                       (navigator as any).mozConnection || 
                       (navigator as any).webkitConnection
    
    if (connection) {
      connection.addEventListener('change', updateNetworkInfo)
    }

    return () => {
      window.removeEventListener('online', updateNetworkInfo)
      window.removeEventListener('offline', updateNetworkInfo)
      
      if (connection) {
        connection.removeEventListener('change', updateNetworkInfo)
      }
    }
  }, [updateNetworkInfo])

  return networkInfo
}

// ============================================
// useOfflineCache - 离线数据缓存
// ============================================

export interface OfflineCacheOptions {
  key: string
  ttl?: number // 缓存有效期 (ms)
}

export function useOfflineCache<T>(
  fetchFn: () => Promise<T>,
  options: OfflineCacheOptions
) {
  const { key, ttl = 24 * 60 * 60 * 1000 } = options // 默认 24 小时
  
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [isFromCache, setIsFromCache] = useState(false)
  
  const { online } = useNetworkStatus()

  const getCacheKey = useCallback(() => `offline-cache-${key}`, [key])

  const getCachedData = useCallback((): { data: T; timestamp: number } | null => {
    try {
      const cached = localStorage.getItem(getCacheKey())
      if (!cached) return null
      return JSON.parse(cached)
    } catch {
      return null
    }
  }, [getCacheKey])

  const setCachedData = useCallback((data: T) => {
    try {
      localStorage.setItem(getCacheKey(), JSON.stringify({
        data,
        timestamp: Date.now(),
      }))
    } catch {
      // 存储失败，忽略
    }
  }, [getCacheKey])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)

    // 先尝试从缓存获取
    const cached = getCachedData()
    const now = Date.now()

    // 如果离线，使用缓存数据
    if (!online) {
      if (cached) {
        setData(cached.data)
        setIsFromCache(true)
        setLoading(false)
        return
      }
      setError(new Error('离线且无缓存数据'))
      setLoading(false)
      return
    }

    // 如果缓存有效，先显示缓存，然后后台刷新
    if (cached && (now - cached.timestamp) < ttl) {
      setData(cached.data)
      setIsFromCache(true)
    }

    try {
      const freshData = await fetchFn()
      setData(freshData)
      setIsFromCache(false)
      setCachedData(freshData)
    } catch (err) {
      // 如果请求失败但有缓存，使用缓存
      if (cached) {
        setData(cached.data)
        setIsFromCache(true)
      } else {
        setError(err instanceof Error ? err : new Error('获取数据失败'))
      }
    } finally {
      setLoading(false)
    }
  }, [online, fetchFn, getCachedData, setCachedData, ttl])

  // 初始加载
  useEffect(() => {
    fetchData()
  }, [])

  // 网络恢复时刷新
  useEffect(() => {
    if (online && isFromCache) {
      fetchData()
    }
  }, [online])

  const refresh = useCallback(() => {
    return fetchData()
  }, [fetchData])

  const clearCache = useCallback(() => {
    try {
      localStorage.removeItem(getCacheKey())
    } catch {
      // 忽略
    }
  }, [getCacheKey])

  return {
    data,
    loading,
    error,
    isFromCache,
    refresh,
    clearCache,
  }
}

// ============================================
// useReconnectSync - 重连自动同步
// ============================================

export interface PendingAction {
  id: string
  type: string
  payload: unknown
  timestamp: number
}

export function useReconnectSync(
  syncFn: (actions: PendingAction[]) => Promise<void>
) {
  const pendingActionsRef = useRef<PendingAction[]>([])
  const { online } = useNetworkStatus()
  const [syncing, setSyncing] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  // 从 localStorage 恢复待同步操作
  useEffect(() => {
    try {
      const saved = localStorage.getItem('pending-sync-actions')
      if (saved) {
        pendingActionsRef.current = JSON.parse(saved)
        setPendingCount(pendingActionsRef.current.length)
      }
    } catch {
      // 忽略
    }
  }, [])

  // 添加待同步操作
  const addPendingAction = useCallback((type: string, payload: unknown) => {
    const action: PendingAction = {
      id: Math.random().toString(36).slice(2),
      type,
      payload,
      timestamp: Date.now(),
    }
    
    pendingActionsRef.current.push(action)
    setPendingCount(pendingActionsRef.current.length)
    
    // 保存到 localStorage
    try {
      localStorage.setItem('pending-sync-actions', JSON.stringify(pendingActionsRef.current))
    } catch {
      // 忽略
    }
    
    return action.id
  }, [])

  // 同步操作
  const sync = useCallback(async () => {
    if (pendingActionsRef.current.length === 0) return

    setSyncing(true)
    try {
      await syncFn(pendingActionsRef.current)
      
      // 清除已同步的操作
      pendingActionsRef.current = []
      setPendingCount(0)
      localStorage.removeItem('pending-sync-actions')
    } catch (err) {
      console.error('同步失败:', err)
    } finally {
      setSyncing(false)
    }
  }, [syncFn])

  // 网络恢复时自动同步
  useEffect(() => {
    if (online && pendingActionsRef.current.length > 0) {
      sync()
    }
  }, [online, sync])

  return {
    addPendingAction,
    sync,
    syncing,
    pendingCount,
    hasPending: pendingCount > 0,
  }
}

// ============================================
// OfflineBanner - 离线提示组件
// ============================================

export function OfflineBanner() {
  const { status, online } = useNetworkStatus()
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (!online && !dismissed) {
      setVisible(true)
    } else if (online) {
      // 网络恢复，短暂显示然后隐藏
      if (visible) {
        // Clear any existing timer
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current)
        }
        hideTimerRef.current = setTimeout(() => setVisible(false), 2000)
      }
      setDismissed(false)
    }

    // Cleanup timer on unmount or when dependencies change
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
    }
  }, [online, dismissed, visible])

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        padding: '12px 16px',
        background: online ? '#22c55e' : '#ef4444',
        color: '#fff',
        textAlign: 'center',
        fontSize: 14,
        fontWeight: 600,
        zIndex: tokens.zIndex.toast, // 网络状态提示需要高优先级
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        animation: 'slideDown 0.3s ease',
      }}
    >
      <span>{online ? '✓ 网络已恢复' : '⚠ 当前处于离线状态'}</span>
      {!online && (
        <button
          onClick={() => setDismissed(true)}
          style={{
            background: 'rgba(255,255,255,0.2)',
            border: 'none',
            borderRadius: 4,
            padding: '4px 8px',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          关闭
        </button>
      )}
      <style>{`
        @keyframes slideDown {
          from { transform: translateY(-100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

const networkStatusHooks = {
  useNetworkStatus,
  useOfflineCache,
  useReconnectSync,
  OfflineBanner,
}
export default networkStatusHooks
