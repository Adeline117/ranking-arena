/**
 * 自定义筛选保存功能 Hook
 * 
 * 用户可以保存常用的筛选条件组合
 * 存储在 localStorage 或用户账户（如果登录）
 */

import { useState, useEffect, useCallback } from 'react'
import type { PresetId } from '@/app/components/ranking/FilterPresets'
import { logger } from '@/lib/logger'

// ============================================
// 类型定义
// ============================================

export interface FilterConditions {
  /** 时间段 */
  seasonId?: string
  /** 分类预设 */
  preset?: PresetId | null
  /** 选中的交易所 */
  exchanges?: string[]
  /** ROI 范围 */
  roiRange?: { min: number | null; max: number | null }
  /** 最大回撤范围 */
  drawdownRange?: { min: number | null; max: number | null }
  /** 胜率范围 */
  winRateRange?: { min: number | null; max: number | null }
  /** Arena Score 范围 */
  arenaScoreRange?: { min: number | null; max: number | null }
  /** 排序方式 */
  sortBy?: string
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc'
}

export interface SavedFilter {
  /** 唯一 ID */
  id: string
  /** 筛选器名称 */
  name: string
  /** 筛选条件 */
  conditions: FilterConditions
  /** 创建时间 */
  createdAt: string
  /** 最后使用时间 */
  lastUsedAt: string
  /** 使用次数 */
  useCount: number
  /** 是否固定 */
  isPinned: boolean
}

interface UseSavedFiltersOptions {
  /** localStorage 键名 */
  storageKey?: string
  /** 最大保存数量 */
  maxSaved?: number
  /** 用户 ID（用于区分不同用户） */
  userId?: string | null
}

interface UseSavedFiltersReturn {
  /** 已保存的筛选列表 */
  savedFilters: SavedFilter[]
  /** 当前激活的筛选 ID */
  activeFilterId: string | null
  /** 保存筛选 */
  saveFilter: (name: string, conditions: FilterConditions) => SavedFilter
  /** 加载筛选 */
  loadFilter: (id: string) => FilterConditions | null
  /** 删除筛选 */
  deleteFilter: (id: string) => void
  /** 更新筛选 */
  updateFilter: (id: string, updates: Partial<Omit<SavedFilter, 'id' | 'createdAt'>>) => void
  /** 固定/取消固定筛选 */
  togglePin: (id: string) => void
  /** 设置当前激活的筛选 */
  setActiveFilter: (id: string | null) => void
  /** 重置为默认 */
  clearActiveFilter: () => void
  /** 导出筛选配置 */
  exportFilters: () => string
  /** 导入筛选配置 */
  importFilters: (json: string) => boolean
  /** 是否正在加载 */
  isLoading: boolean
}

// ============================================
// 常量
// ============================================

const DEFAULT_STORAGE_KEY = 'ranking-arena-saved-filters'
const DEFAULT_MAX_SAVED = 20

// ============================================
// 工具函数
// ============================================

function generateId(): string {
  return `filter_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

function getStorageKey(baseKey: string, userId?: string | null): string {
  return userId ? `${baseKey}:${userId}` : baseKey
}

// ============================================
// Hook 实现
// ============================================

export function useSavedFilters(options: UseSavedFiltersOptions = {}): UseSavedFiltersReturn {
  const {
    storageKey = DEFAULT_STORAGE_KEY,
    maxSaved = DEFAULT_MAX_SAVED,
    userId = null,
  } = options
  
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [activeFilterId, setActiveFilterId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  
  const fullStorageKey = getStorageKey(storageKey, userId)
  
  // 初始化：从 localStorage 加载
  useEffect(() => {
    try {
      const stored = localStorage.getItem(fullStorageKey)
      if (stored) {
        const parsed = JSON.parse(stored) as SavedFilter[]
        // 按固定状态和最后使用时间排序
        const sorted = parsed.sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
          return new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
        })
        setSavedFilters(sorted)
      }
      
      // 加载激活的筛选 ID
      const activeId = localStorage.getItem(`${fullStorageKey}:active`)
      if (activeId) {
        setActiveFilterId(activeId)
      }
    } catch (error) {
      logger.error('Failed to load saved filters:', error)
    } finally {
      setIsLoading(false)
    }
  }, [fullStorageKey])
  
  // 保存到 localStorage
  const persistFilters = useCallback((filters: SavedFilter[]) => {
    try {
      localStorage.setItem(fullStorageKey, JSON.stringify(filters))
    } catch (error) {
      logger.error('Failed to persist filters:', error)
    }
  }, [fullStorageKey])
  
  // 保存激活状态
  const persistActiveId = useCallback((id: string | null) => {
    try {
      if (id) {
        localStorage.setItem(`${fullStorageKey}:active`, id)
      } else {
        localStorage.removeItem(`${fullStorageKey}:active`)
      }
    } catch (error) {
      logger.error('Failed to persist active filter:', error)
    }
  }, [fullStorageKey])
  
  // 保存筛选
  const saveFilter = useCallback((name: string, conditions: FilterConditions): SavedFilter => {
    const now = new Date().toISOString()
    const newFilter: SavedFilter = {
      id: generateId(),
      name: name.trim() || `筛选 ${savedFilters.length + 1}`,
      conditions,
      createdAt: now,
      lastUsedAt: now,
      useCount: 0,
      isPinned: false,
    }
    
    setSavedFilters(prev => {
      // 限制数量，移除最旧的非固定筛选
      let updated = [...prev, newFilter]
      if (updated.length > maxSaved) {
        // 找到最旧的非固定筛选
        const nonPinned = updated.filter(f => !f.isPinned)
        if (nonPinned.length > 0) {
          const oldest = nonPinned.sort(
            (a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime()
          )[0]
          updated = updated.filter(f => f.id !== oldest.id)
        }
      }
      
      persistFilters(updated)
      return updated
    })
    
    return newFilter
  }, [savedFilters.length, maxSaved, persistFilters])
  
  // 加载筛选
  const loadFilter = useCallback((id: string): FilterConditions | null => {
    const filter = savedFilters.find(f => f.id === id)
    if (!filter) return null
    
    // 更新使用统计
    setSavedFilters(prev => {
      const updated = prev.map(f => 
        f.id === id
          ? { ...f, lastUsedAt: new Date().toISOString(), useCount: f.useCount + 1 }
          : f
      )
      persistFilters(updated)
      return updated
    })
    
    setActiveFilterId(id)
    persistActiveId(id)
    
    return filter.conditions
  }, [savedFilters, persistFilters, persistActiveId])
  
  // 删除筛选
  const deleteFilter = useCallback((id: string) => {
    setSavedFilters(prev => {
      const updated = prev.filter(f => f.id !== id)
      persistFilters(updated)
      return updated
    })
    
    if (activeFilterId === id) {
      setActiveFilterId(null)
      persistActiveId(null)
    }
  }, [activeFilterId, persistFilters, persistActiveId])
  
  // 更新筛选
  const updateFilter = useCallback((
    id: string,
    updates: Partial<Omit<SavedFilter, 'id' | 'createdAt'>>
  ) => {
    setSavedFilters(prev => {
      const updated = prev.map(f =>
        f.id === id ? { ...f, ...updates } : f
      )
      persistFilters(updated)
      return updated
    })
  }, [persistFilters])
  
  // 固定/取消固定
  const togglePin = useCallback((id: string) => {
    setSavedFilters(prev => {
      const updated = prev.map(f =>
        f.id === id ? { ...f, isPinned: !f.isPinned } : f
      )
      // 重新排序
      const sorted = updated.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
        return new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
      })
      persistFilters(sorted)
      return sorted
    })
  }, [persistFilters])
  
  // 设置当前激活筛选
  const setActiveFilter = useCallback((id: string | null) => {
    setActiveFilterId(id)
    persistActiveId(id)
  }, [persistActiveId])
  
  // 清除激活筛选
  const clearActiveFilter = useCallback(() => {
    setActiveFilterId(null)
    persistActiveId(null)
  }, [persistActiveId])
  
  // 导出筛选
  const exportFilters = useCallback((): string => {
    return JSON.stringify(savedFilters, null, 2)
  }, [savedFilters])
  
  // 导入筛选
  const importFilters = useCallback((json: string): boolean => {
    try {
      const imported = JSON.parse(json) as SavedFilter[]
      if (!Array.isArray(imported)) return false
      
      // 验证格式
      const valid = imported.every(f => 
        typeof f.id === 'string' &&
        typeof f.name === 'string' &&
        typeof f.conditions === 'object'
      )
      
      if (!valid) return false
      
      // 合并，避免 ID 冲突
      setSavedFilters(prev => {
        const existingIds = new Set(prev.map(f => f.id))
        const newFilters = imported.map(f => ({
          ...f,
          id: existingIds.has(f.id) ? generateId() : f.id,
        }))
        
        const merged = [...prev, ...newFilters].slice(0, maxSaved)
        persistFilters(merged)
        return merged
      })
      
      return true
    } catch (_err) {
      /* parse fallback */
      return false
    }
  }, [maxSaved, persistFilters])
  
  return {
    savedFilters,
    activeFilterId,
    saveFilter,
    loadFilter,
    deleteFilter,
    updateFilter,
    togglePin,
    setActiveFilter,
    clearActiveFilter,
    exportFilters,
    importFilters,
    isLoading,
  }
}

// ============================================
// 预定义筛选模板
// ============================================

export const FILTER_TEMPLATES: Array<{ name: string; conditions: FilterConditions }> = [
  {
    name: 'Top Performers',
    conditions: {
      arenaScoreRange: { min: 60, max: null },
      sortBy: 'arena_score',
      sortOrder: 'desc',
    },
  },
  {
    name: 'Low Risk',
    conditions: {
      drawdownRange: { min: null, max: 15 },
      winRateRange: { min: 55, max: null },
      sortBy: 'max_drawdown',
      sortOrder: 'asc',
    },
  },
  {
    name: 'High ROI',
    conditions: {
      roiRange: { min: 50, max: null },
      sortBy: 'roi',
      sortOrder: 'desc',
    },
  },
  {
    name: 'Consistent Winners',
    conditions: {
      winRateRange: { min: 60, max: null },
      roiRange: { min: 20, max: null },
      sortBy: 'win_rate',
      sortOrder: 'desc',
    },
  },
  {
    name: 'DeFi Only',
    conditions: {
      preset: 'onchain_dex',
      sortBy: 'arena_score',
      sortOrder: 'desc',
    },
  },
]
