'use client'

/**
 * VirtualRankingList 完整使用示例
 *
 * 展示如何整合以下优化方案：
 * 1. useRankingsWithCache - 缓存优先策略 + 离线支持
 * 2. useTraderDataDiff - WebSocket 数据差分更新
 * 3. VirtualRankingList - 高性能虚拟列表渲染
 * 4. channelPool - WebSocket 连接池管理
 */

import { useRef, useCallback, useEffect, useState, useMemo } from 'react'
import { VirtualRankingList, VirtualRankingListRef, VirtualTrader } from './VirtualRankingList'
import { useRankingsWithCache, useNetworkStatus, getSkeletonState } from '@/lib/hooks/useRankingsWithCache'
import { useTraderDataDiff, TraderData } from '@/lib/hooks/useTraderDataDiff'
import { channelPool } from '@/lib/realtime/channel-pool'

// Transform TraderData to VirtualTrader format
function toVirtualTrader(trader: TraderData): VirtualTrader {
  return {
    id: trader.id,
    handle: trader.handle,
    source: trader.source,
    avatar_url: trader.avatar_url,
    roi: trader.metrics.roi,
    pnl: trader.metrics.pnl,
    arena_score: trader.metrics.arena_score,
    win_rate: trader.metrics.win_rate,
    max_drawdown: trader.metrics.max_drawdown,
    followers: trader.metrics.followers,
  }
}

// ============================================
// 类型定义
// ============================================

interface RankingsApiResponse {
  traders: TraderData[]
  total: number
  lastUpdated: string
}

interface RankingListExampleProps {
  /** 初始数据 (SSR) */
  initialData?: TraderData[]
  /** 平台筛选 */
  platform?: string
  /** 时间范围 */
  timeRange?: '7d' | '30d' | '90d' | 'all'
  /** 容器高度 */
  height?: number
  /** 行高 */
  rowHeight?: number
  /** 点击交易员回调 */
  onTraderClick?: (trader: TraderData) => void
}

// ============================================
// 数据获取函数
// ============================================

async function fetchRankings(
  platform?: string,
  timeRange?: string
): Promise<RankingsApiResponse> {
  const params = new URLSearchParams()
  if (platform) params.set('platform', platform)
  if (timeRange) params.set('time_range', timeRange)

  const response = await fetch(`/api/v2/rankings?${params.toString()}`)

  if (!response.ok) {
    throw new Error(`Failed to fetch rankings: ${response.status}`)
  }

  return response.json()
}

// ============================================
// 主组件
// ============================================

export function VirtualRankingListExample({
  initialData = [],
  platform,
  timeRange = '30d',
  height = 600,
  rowHeight = 64,
  onTraderClick,
}: RankingListExampleProps) {
  const listRef = useRef<VirtualRankingListRef>(null)
  const { isOnline } = useNetworkStatus()

  // ----------------------------------------
  // 1. 缓存优先数据获取
  // ----------------------------------------
  const {
    data: apiResponse,
    error,
    loadingState,
    isStale,
    isCached,
    lastUpdated,
    refetch,
  } = useRankingsWithCache<RankingsApiResponse>({
    cacheKey: `rankings_${platform || 'all'}_${timeRange}`,
    fetcher: () => fetchRankings(platform, timeRange),
    staleTime: 60 * 1000,       // 1 分钟后标记为 stale
    cacheTime: 5 * 60 * 1000,   // 5 分钟后缓存过期
    refetchInBackground: true,
    refetchInterval: 60 * 1000, // 每分钟自动刷新
    initialData: initialData.length > 0
      ? { traders: initialData, total: initialData.length, lastUpdated: new Date().toISOString() }
      : undefined,
  })

  // ----------------------------------------
  // 2. 数据差分更新管理
  // ----------------------------------------
  const {
    data: traders,
    updateData,
    handleWebSocketUpdate,
  } = useTraderDataDiff(apiResponse?.traders || initialData)

  // 当 API 数据更新时，应用差分更新
  useEffect(() => {
    if (apiResponse?.traders) {
      updateData(apiResponse.traders)
    }
  }, [apiResponse?.traders, updateData])

  // ----------------------------------------
  // 3. WebSocket 实时订阅
  // ----------------------------------------
  useEffect(() => {
    if (!isOnline) return

    // 订阅交易员快照更新
    const unsubscribe = channelPool.subscribe(
      {
        table: 'trader_snapshots',
        event: 'UPDATE',
        // 可选：根据平台筛选
        // filter: platform ? `platform=eq.${platform}` : undefined,
      },
      {
        onUpdate: ({ new: newRecord }) => {
          // 将数据库记录转换为 WebSocket 更新格式
          handleWebSocketUpdate({
            trader_id: newRecord.trader_id as string,
            roi: newRecord.roi as number | undefined,
            pnl: newRecord.pnl as number | undefined,
            arena_score: newRecord.arena_score as number | undefined,
          })
        },
      }
    )

    return () => {
      unsubscribe()
    }
  }, [isOnline, platform, handleWebSocketUpdate])

  // ----------------------------------------
  // 4. 骨架屏状态
  // ----------------------------------------
  const skeletonState = getSkeletonState(loadingState, isCached, isStale, isOnline)

  // Transform traders to VirtualTrader format
  const virtualTraders = useMemo(() => traders.map(toVirtualTrader), [traders])

  // ----------------------------------------
  // 5. 事件处理
  // ----------------------------------------
  const handleTraderClick = useCallback((trader: VirtualTrader) => {
    // Find the original TraderData to pass to onTraderClick
    const originalTrader = traders.find(t => t.id === trader.id)
    if (originalTrader) {
      onTraderClick?.(originalTrader)
    }
  }, [onTraderClick, traders])

  const handleScrollToTop = useCallback(() => {
    listRef.current?.scrollToIndex(0, 'start')
  }, [])

  const handleRefresh = useCallback(async () => {
    await refetch()
  }, [refetch])

  // ----------------------------------------
  // 6. 渲染
  // ----------------------------------------
  return (
    <div className="flex flex-col h-full">
      {/* 状态栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border-primary)]">
        <div className="flex items-center gap-2">
          {/* 网络状态指示器 */}
          <div
            className={`w-2 h-2 rounded-full ${
              isOnline ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-sm text-[var(--text-secondary)]">
            {isOnline ? '在线' : '离线'}
          </span>

          {/* 数据状态 */}
          {isStale && (
            <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-600">
              数据已陈旧
            </span>
          )}
          {isCached && !isStale && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-600">
              来自缓存
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* 上次更新时间 */}
          {lastUpdated && (
            <span className="text-xs text-[var(--text-tertiary)]">
              更新于 {lastUpdated.toLocaleTimeString()}
            </span>
          )}

          {/* 刷新按钮 */}
          <button
            onClick={handleRefresh}
            disabled={loadingState === 'loading'}
            className={`
              p-1.5 rounded-lg transition-colors
              ${loadingState === 'loading' || loadingState === 'revalidating'
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-[var(--bg-tertiary)] active:bg-[var(--bg-hover)]'
              }
            `}
          >
            <svg
              className={`w-4 h-4 text-[var(--text-secondary)] ${
                loadingState === 'revalidating' ? 'animate-spin' : ''
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>

          {/* 回到顶部 */}
          <button
            onClick={handleScrollToTop}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] active:bg-[var(--bg-hover)] transition-colors"
          >
            <svg
              className="w-4 h-4 text-[var(--text-secondary)]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 10l7-7m0 0l7 7m-7-7v18"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && skeletonState === 'error' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20">
          <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-red-500">{error.message}</span>
          <button
            onClick={handleRefresh}
            className="ml-auto text-sm text-red-500 underline"
          >
            重试
          </button>
        </div>
      )}

      {/* 虚拟列表 */}
      <VirtualRankingList
        ref={listRef}
        traders={virtualTraders}
        isLoading={loadingState === 'loading' && virtualTraders.length === 0}
        skeletonState={skeletonState}
        containerHeight={height}
        rowHeight={rowHeight}
        onTraderClick={handleTraderClick}
      />

      {/* 统计信息 */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--border-primary)] text-xs text-[var(--text-tertiary)]">
        <span>共 {traders.length} 位交易员</span>
        <span>虚拟列表 · 60 FPS 优化</span>
      </div>
    </div>
  )
}

// ============================================
// 页面集成示例
// ============================================

/**
 * 在页面中使用的示例：
 *
 * ```tsx
 * // app/rankings/page.tsx
 * import { VirtualRankingListExample } from '@/app/components/ranking/VirtualRankingListExample'
 *
 * // Server Component - 获取初始数据用于 SSR
 * export default async function RankingsPage() {
 *   const initialData = await fetch('https://api.example.com/rankings')
 *     .then(res => res.json())
 *     .then(data => data.traders)
 *     .catch(() => [])
 *
 *   return (
 *     <div className="h-screen">
 *       <VirtualRankingListExample
 *         initialData={initialData}
 *         platform="binance"
 *         timeRange="30d"
 *         height={800}
 *         rowHeight={64}
 *         onTraderClick={(trader) => {
 *           // 跳转到交易员详情页
 *           window.location.href = `/trader/${trader.handle || trader.id}`
 *         }}
 *       />
 *     </div>
 *   )
 * }
 * ```
 */

export default VirtualRankingListExample
