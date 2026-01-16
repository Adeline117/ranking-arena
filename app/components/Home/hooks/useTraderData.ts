'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type { Trader } from '../../Features/RankingTable'

export type TimeRange = '90D' | '30D' | '7D'

// 本地存储 key
const TIME_RANGE_STORAGE_KEY = 'ranking_time_range'

interface UseTraderDataOptions {
  autoRefreshInterval?: number // 自动刷新间隔（毫秒）
  onDataUpdated?: () => void
}

export function useTraderData(options: UseTraderDataOptions = {}) {
  const { autoRefreshInterval = 5 * 60 * 1000, onDataUpdated } = options
  
  // 使用 Map 缓存已加载的数据
  const tradersCache = useRef<Map<string, Trader[]>>(new Map())
  const [currentTraders, setCurrentTraders] = useState<Trader[]>([])
  const [loading, setLoading] = useState(true)
  
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

  // 加载单个时间段数据
  const loadTimeRange = useCallback(async (timeRange: TimeRange, forceRefresh = false): Promise<Trader[]> => {
    // 检查缓存（非强制刷新时）
    if (!forceRefresh && tradersCache.current.has(timeRange)) {
      return tradersCache.current.get(timeRange) || []
    }
    
    try {
      const response = await fetch(`/api/traders?timeRange=${timeRange}`)
      if (!response.ok) {
        console.error(`[useTraderData] ${timeRange} API 错误`)
        return tradersCache.current.get(timeRange) || []
      }
      const data = await response.json()
      const traders = data.traders || []
      
      // 更新缓存
      tradersCache.current.set(timeRange, traders)
      
      return traders
    } catch (error) {
      console.error(`[useTraderData] 加载 ${timeRange} 数据失败:`, error)
      return tradersCache.current.get(timeRange) || []
    }
  }, [])

  // 加载当前选中时间段的数据
  const loadCurrentData = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    try {
      const traders = await loadTimeRange(activeTimeRange, forceRefresh)
      setCurrentTraders(traders)
      
      if (forceRefresh && onDataUpdated) {
        onDataUpdated()
      }
    } catch (error) {
      console.error('[useTraderData] 加载交易者数据失败:', error)
      setCurrentTraders([])
    } finally {
      setLoading(false)
    }
  }, [activeTimeRange, loadTimeRange, onDataUpdated])

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
  
  // 自动刷新
  useEffect(() => {
    if (autoRefreshInterval > 0) {
      const interval = setInterval(() => {
        loadCurrentData(true)
      }, autoRefreshInterval)
      
      return () => clearInterval(interval)
    }
  }, [autoRefreshInterval, loadCurrentData])

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
    changeTimeRange,
    refresh,
    clearCache,
  }
}
