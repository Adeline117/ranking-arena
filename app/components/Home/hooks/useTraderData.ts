'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type { Trader } from '../../Features/RankingTable'
import { useTraderDataSync, type TraderDataPayload } from '@/lib/hooks/useBroadcastSync'

export type TimeRange = '90D' | '30D' | '7D'

// 本地存储 key
const TIME_RANGE_STORAGE_KEY = 'ranking_time_range'

interface CachedData {
  traders: Trader[]
  lastUpdated: string | null
}

interface UseTraderDataOptions {
  autoRefreshInterval?: number // 自动刷新间隔（毫秒）
}

export function useTraderData(options: UseTraderDataOptions = {}) {
  // 默认 10 分钟自动刷新（数据每 2 小时更新一次，无需频繁刷新）
  const { autoRefreshInterval = 10 * 60 * 1000 } = options

  // 使用 Map 缓存已加载的数据
  const tradersCache = useRef<Map<string, CachedData>>(new Map())
  const [currentTraders, setCurrentTraders] = useState<Trader[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  // 多窗口同步
  const { broadcast, on } = useTraderDataSync()

  // 从 localStorage 读取用户偏好的时间段
  const [activeTimeRange, setActiveTimeRange] = useState<TimeRange>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(TIME_RANGE_STORAGE_KEY)
      if (saved === '90D' || saved === '30D' || saved === '7D') {
        return saved
      }
    }
    return '90D'
  })

  // 监听其他窗口的数据更新
  useEffect(() => {
    const unsubscribe = on('TRADER_DATA_UPDATED', (payload: TraderDataPayload) => {
      // 只处理当前时间段的数据
      if (payload.timeRange === activeTimeRange) {
        // 更新本地缓存和状态
        const cached: CachedData = {
          traders: payload.traders as Trader[],
          lastUpdated: payload.lastUpdated,
        }
        tradersCache.current.set(activeTimeRange, cached)
        setCurrentTraders(cached.traders)
        setLastUpdated(cached.lastUpdated)
      }
    })

    return unsubscribe
  }, [activeTimeRange, on])

  // 加载单个时间段数据
  const loadTimeRange = useCallback(async (timeRange: TimeRange, forceRefresh = false): Promise<CachedData> => {
    // 检查缓存（非强制刷新时）
    if (!forceRefresh && tradersCache.current.has(timeRange)) {
      return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null }
    }
    
    try {
      const response = await fetch(`/api/traders?timeRange=${timeRange}`)
      if (!response.ok) {
        console.error(`[useTraderData] ${timeRange} API 错误`)
        return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null }
      }
      const data = await response.json()
      const cached: CachedData = {
        traders: data.traders || [],
        lastUpdated: data.lastUpdated || null,
      }

      // 更新缓存
      tradersCache.current.set(timeRange, cached)

      // 广播数据更新到其他窗口
      broadcast('TRADER_DATA_UPDATED', {
        timeRange,
        traders: cached.traders,
        lastUpdated: cached.lastUpdated || '',
      })

      return cached
    } catch (error) {
      console.error(`[useTraderData] 加载 ${timeRange} 数据失败:`, error)
      return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null }
    }
  }, [])

  // 加载当前选中时间段的数据
  const loadCurrentData = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    try {
      const cached = await loadTimeRange(activeTimeRange, forceRefresh)
      setCurrentTraders(cached.traders)
      setLastUpdated(cached.lastUpdated)
    } catch (error) {
      console.error('[useTraderData] 加载交易者数据失败:', error)
      setCurrentTraders([])
      setLastUpdated(null)
    } finally {
      setLoading(false)
    }
  }, [activeTimeRange, loadTimeRange])

  // 初次加载和时间段切换时加载数据
  useEffect(() => {
    loadCurrentData()
  }, [loadCurrentData])

  // 保存时间段偏好到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, activeTimeRange)
    }
  }, [activeTimeRange])
  
  // 自动刷新（静默刷新，不显示 loading）
  useEffect(() => {
    if (autoRefreshInterval > 0) {
      const interval = setInterval(() => {
        // 静默刷新：不设置 loading 状态
        loadTimeRange(activeTimeRange, true).then(cached => {
          setCurrentTraders(cached.traders)
          setLastUpdated(cached.lastUpdated)
        })
      }, autoRefreshInterval)
      
      return () => clearInterval(interval)
    }
  }, [autoRefreshInterval, activeTimeRange, loadTimeRange])

  // 切换时间段
  const changeTimeRange = useCallback((range: TimeRange) => {
    setActiveTimeRange(range)
  }, [])

  // 刷新数据
  const refresh = useCallback(() => {
    loadCurrentData(true)
  }, [loadCurrentData])

  // 清除缓存
  const clearCache = useCallback(() => {
    tradersCache.current.clear()
  }, [])

  return {
    traders: currentTraders,
    loading,
    activeTimeRange,
    lastUpdated,
    changeTimeRange,
    refresh,
    clearCache,
  }
}
