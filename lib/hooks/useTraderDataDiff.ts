'use client'

/**
 * useTraderDataDiff - 交易员数据差分更新 Hook
 *
 * 特性：
 * - WebSocket 推送时只更新变化的字段
 * - 粒度化 memoization (ROI、PnL 独立更新)
 * - 避免整个列表重新渲染
 * - 支持批量更新合并
 */

import { useCallback, useRef, useMemo, useState, useEffect } from 'react'

export interface TraderMetrics {
  roi: number
  pnl?: number | null
  arena_score?: number
  win_rate?: number | null
  max_drawdown?: number | null
  followers?: number
  // V3 metrics
  sortino_ratio?: number | null
  alpha?: number | null
}

export interface TraderData {
  id: string
  handle?: string | null
  source?: string
  avatar_url?: string | null
  metrics: TraderMetrics
}

interface DiffResult {
  /** 新增的交易员 */
  added: TraderData[]
  /** 删除的交易员 */
  removed: string[]
  /** 更新的字段 (trader_id -> changed_fields) */
  updated: Map<string, Partial<TraderMetrics>>
}

/**
 * 计算两个数据集的差分
 */
export function calculateDiff(
  oldData: TraderData[],
  newData: TraderData[]
): DiffResult {
  const oldMap = new Map(oldData.map(t => [t.id, t]))
  const newMap = new Map(newData.map(t => [t.id, t]))

  const added: TraderData[] = []
  const removed: string[] = []
  const updated = new Map<string, Partial<TraderMetrics>>()

  // 查找新增和更新
  for (const [id, newTrader] of newMap) {
    const oldTrader = oldMap.get(id)

    if (!oldTrader) {
      added.push(newTrader)
    } else {
      // 比较指标变化
      const changes: Partial<TraderMetrics> = {}
      const oldMetrics = oldTrader.metrics
      const newMetrics = newTrader.metrics

      if (oldMetrics.roi !== newMetrics.roi) {
        changes.roi = newMetrics.roi
      }
      if (oldMetrics.pnl !== newMetrics.pnl) {
        changes.pnl = newMetrics.pnl
      }
      if (oldMetrics.arena_score !== newMetrics.arena_score) {
        changes.arena_score = newMetrics.arena_score
      }
      if (oldMetrics.win_rate !== newMetrics.win_rate) {
        changes.win_rate = newMetrics.win_rate
      }
      if (oldMetrics.max_drawdown !== newMetrics.max_drawdown) {
        changes.max_drawdown = newMetrics.max_drawdown
      }
      if (oldMetrics.followers !== newMetrics.followers) {
        changes.followers = newMetrics.followers
      }
      if (oldMetrics.sortino_ratio !== newMetrics.sortino_ratio) {
        changes.sortino_ratio = newMetrics.sortino_ratio
      }
      if (oldMetrics.alpha !== newMetrics.alpha) {
        changes.alpha = newMetrics.alpha
      }

      if (Object.keys(changes).length > 0) {
        updated.set(id, changes)
      }
    }
  }

  // 查找删除
  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) {
      removed.push(id)
    }
  }

  return { added, removed, updated }
}

/**
 * 数据差分更新 Hook
 */
export function useTraderDataDiff(initialData: TraderData[]) {
  const [data, setData] = useState<TraderData[]>(initialData)
  const prevDataRef = useRef<TraderData[]>(initialData)
  const pendingUpdatesRef = useRef<Map<string, Partial<TraderMetrics>>>(new Map())
  const batchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // 批量更新合并 (16ms 内的更新合并为一次)
  const flushBatchedUpdates = useCallback(() => {
    if (pendingUpdatesRef.current.size === 0) return

    const updates = new Map(pendingUpdatesRef.current)
    pendingUpdatesRef.current.clear()

    setData(prev => {
      return prev.map(trader => {
        const changes = updates.get(trader.id)
        if (!changes) return trader

        return {
          ...trader,
          metrics: {
            ...trader.metrics,
            ...changes,
          },
        }
      })
    })
  }, [])

  // 应用单个交易员的更新
  const applyUpdate = useCallback((traderId: string, changes: Partial<TraderMetrics>) => {
    // 合并到待处理更新
    const existing = pendingUpdatesRef.current.get(traderId) || {}
    pendingUpdatesRef.current.set(traderId, { ...existing, ...changes })

    // 批量处理 (16ms debounce)
    if (batchTimeoutRef.current) {
      clearTimeout(batchTimeoutRef.current)
    }
    batchTimeoutRef.current = setTimeout(flushBatchedUpdates, 16)
  }, [flushBatchedUpdates])

  // 处理 WebSocket 推送的更新
  const handleWebSocketUpdate = useCallback((update: {
    trader_id: string
    roi?: number
    pnl?: number
    arena_score?: number
    [key: string]: unknown
  }) => {
    const changes: Partial<TraderMetrics> = {}

    if (update.roi !== undefined) changes.roi = update.roi
    if (update.pnl !== undefined) changes.pnl = update.pnl
    if (update.arena_score !== undefined) changes.arena_score = update.arena_score

    if (Object.keys(changes).length > 0) {
      applyUpdate(update.trader_id, changes)
    }
  }, [applyUpdate])

  // 全量数据更新 (使用差分)
  const updateData = useCallback((newData: TraderData[]) => {
    const diff = calculateDiff(prevDataRef.current, newData)

    if (diff.added.length === 0 && diff.removed.length === 0 && diff.updated.size === 0) {
      return // 无变化
    }

    setData(prev => {
      let result = prev

      // 处理删除
      if (diff.removed.length > 0) {
        const removedSet = new Set(diff.removed)
        result = result.filter(t => !removedSet.has(t.id))
      }

      // 处理更新
      if (diff.updated.size > 0) {
        result = result.map(trader => {
          const changes = diff.updated.get(trader.id)
          if (!changes) return trader

          return {
            ...trader,
            metrics: {
              ...trader.metrics,
              ...changes,
            },
          }
        })
      }

      // 处理新增
      if (diff.added.length > 0) {
        result = [...result, ...diff.added]
      }

      return result
    })

    prevDataRef.current = newData
  }, [])

  // 清理
  useEffect(() => {
    return () => {
      if (batchTimeoutRef.current) {
        clearTimeout(batchTimeoutRef.current)
      }
    }
  }, [])

  return {
    data,
    updateData,
    applyUpdate,
    handleWebSocketUpdate,
  }
}

/**
 * 创建浅比较函数 (用于 React.memo)
 */
export function createTraderPropsComparator<T extends { trader: { id: string; metrics: TraderMetrics } }>(
  watchedFields: (keyof TraderMetrics)[] = ['roi', 'arena_score']
) {
  return (prevProps: T, nextProps: T): boolean => {
    // ID 变化必须重新渲染
    if (prevProps.trader.id !== nextProps.trader.id) {
      return false
    }

    // 只检查监视的字段
    const prevMetrics = prevProps.trader.metrics
    const nextMetrics = nextProps.trader.metrics

    for (const field of watchedFields) {
      if (prevMetrics[field] !== nextMetrics[field]) {
        return false
      }
    }

    return true
  }
}

/**
 * ROI 专用 memoization (最常更新的字段)
 */
export function useROIMemo(roi: number, precision: number = 2) {
  return useMemo(() => {
    const isPositive = roi >= 0
    const formatted = `${isPositive ? '+' : ''}${roi.toFixed(precision)}%`
    const color = isPositive ? 'var(--accent-success)' : 'var(--accent-error)'

    return { formatted, color, isPositive }
  }, [roi, precision])
}

/**
 * Arena Score 专用 memoization
 */
export function useArenaScoreMemo(score: number | undefined | null) {
  return useMemo(() => {
    if (score === undefined || score === null) {
      return { display: '--', tier: 'none' as const, color: 'var(--text-tertiary)' }
    }

    let tier: 'legendary' | 'epic' | 'rare' | 'common' | 'none'
    let color: string

    if (score >= 90) {
      tier = 'legendary'
      color = '#FFD700' // Gold
    } else if (score >= 75) {
      tier = 'epic'
      color = '#A855F7' // Purple
    } else if (score >= 60) {
      tier = 'rare'
      color = '#3B82F6' // Blue
    } else if (score >= 40) {
      tier = 'common'
      color = 'var(--text-primary)'
    } else {
      tier = 'none'
      color = 'var(--text-tertiary)'
    }

    return {
      display: score.toFixed(1),
      tier,
      color,
    }
  }, [score])
}
