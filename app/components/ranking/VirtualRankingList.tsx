'use client'

/**
 * VirtualRankingList - 高性能虚拟排行榜
 *
 * 性能目标：
 * - 500+ 交易员 @ 60 FPS 移动端滚动
 * - WebSocket 推送局部更新 (无整体重渲染)
 * - 骨架屏 + 离线优先
 */

import React, {
  memo,
  useRef,
  useState,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useVirtualScroll, FastScrollPlaceholder } from '@/lib/hooks/useVirtualScroll'
import { useROIMemo, useArenaScoreMemo } from '@/lib/hooks/useTraderDataDiff'
import { useNetworkStatus, type SkeletonState } from '@/lib/hooks/useRankingsWithCache'

// ============================================
// 类型定义
// ============================================

export interface VirtualTrader {
  id: string
  handle?: string | null
  roi: number
  pnl?: number | null
  arena_score?: number
  win_rate?: number | null
  max_drawdown?: number | null
  followers?: number
  source?: string
  avatar_url?: string | null
  rank_change?: number | null
}

export interface VirtualRankingListProps {
  traders: VirtualTrader[]
  isLoading?: boolean
  error?: string | null
  skeletonState?: SkeletonState
  rowHeight?: number
  containerHeight?: number
  overscan?: number
  onTraderClick?: (trader: VirtualTrader) => void
  onRetry?: () => void
  language?: 'zh' | 'en'
  showMiniChart?: boolean
}

export interface VirtualRankingListRef {
  scrollToTop: () => void
  scrollToIndex: (index: number, align?: 'start' | 'center' | 'end') => void
}

// ============================================
// Memoized 子组件
// ============================================

/**
 * ROI 显示组件 - 独立 memoize
 * WebSocket 更新 ROI 时只重渲染这个组件
 */
const ROIDisplay = memo(function ROIDisplay({
  roi,
  size = 'md',
}: {
  roi: number
  size?: 'sm' | 'md' | 'lg'
}) {
  const { formatted, color } = useROIMemo(roi)

  const fontSize = size === 'sm' ? 12 : size === 'lg' ? 16 : 14

  return (
    <span
      style={{
        color,
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        fontSize,
        whiteSpace: 'nowrap',
      }}
    >
      {formatted}
    </span>
  )
})

/**
 * Arena Score 显示组件 - 独立 memoize
 */
const ArenaScoreDisplay = memo(function ArenaScoreDisplay({
  score,
  size = 'md',
}: {
  score?: number | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const { display, tier, color } = useArenaScoreMemo(score)

  const fontSize = size === 'sm' ? 11 : size === 'lg' ? 14 : 12
  const padding = size === 'sm' ? '2px 6px' : '4px 8px'

  return (
    <span
      style={{
        color,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        fontSize,
        padding,
        borderRadius: 4,
        backgroundColor: tier !== 'none' ? `${color}15` : 'transparent',
      }}
    >
      {display}
    </span>
  )
})

/**
 * 排名显示组件
 */
const RankBadge = memo(function RankBadge({
  rank,
  rankChange,
}: {
  rank: number
  rankChange?: number | null
}) {
  const isTop3 = rank <= 3
  const medal = rank === 1 ? '#1' : rank === 2 ? '#2' : rank === 3 ? '#3' : null

  return (
    <div
      style={{
        width: 44,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {medal ? (
        <span style={{ fontSize: 18 }}>{medal}</span>
      ) : (
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: isTop3 ? tokens.colors.accent.primary : tokens.colors.text.secondary,
          }}
        >
          #{rank}
        </span>
      )}
      {rankChange !== null && rankChange !== undefined && rankChange !== 0 && (
        <span
          style={{
            fontSize: 9,
            color: rankChange > 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
          }}
        >
          {rankChange > 0 ? '↑' : '↓'}{Math.abs(rankChange)}
        </span>
      )}
    </div>
  )
})

/**
 * 交易员头像组件
 */
const TraderAvatar = memo(function TraderAvatar({
  url,
  name,
  size = 36,
}: {
  url?: string | null
  name: string
  size?: number
}) {
  const [error, setError] = useState(false)
  const initial = name.charAt(0).toUpperCase()

  if (!url || error) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: `linear-gradient(135deg, ${tokens.colors.accent.brand}, ${tokens.colors.accent.brandHover})`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontSize: size * 0.4,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {initial}
      </div>
    )
  }

  return (
    <img
      src={url}
      alt={name}
      loading="lazy"
      onError={() => setError(true)}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        objectFit: 'cover',
        flexShrink: 0,
      }}
    />
  )
})

/**
 * 虚拟列表行组件 - 完整 memoize
 */
interface VirtualRowProps {
  trader: VirtualTrader
  rank: number
  style: React.CSSProperties
  onClick?: (trader: VirtualTrader) => void
  isScrolling?: boolean
}

const VirtualRow = memo(function VirtualRow({
  trader,
  rank,
  style,
  onClick,
  isScrolling,
}: VirtualRowProps) {
  const displayName = trader.handle || trader.id
  const href = `/trader/${encodeURIComponent(displayName)}`

  // 快速滚动时显示简化行
  if (isScrolling) {
    return <FastScrollPlaceholder style={style} index={rank} />
  }

  return (
    <Link
      href={href}
      onClick={(e) => {
        if (onClick) {
          e.preventDefault()
          onClick(trader)
        }
      }}
      style={{
        ...style,
        textDecoration: 'none',
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${tokens.spacing[4]}`,
        gap: tokens.spacing[3],
        borderBottom: `1px solid ${tokens.colors.border.secondary}`,
        cursor: 'pointer',
        transition: 'background-color 0.1s',
        backgroundColor: 'transparent',
      }}
      className="virtual-row"
    >
      {/* 排名 */}
      <RankBadge rank={rank} rankChange={trader.rank_change} />

      {/* 头像 + 名字 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <TraderAvatar url={trader.avatar_url} name={displayName} size={36} />
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <div
            style={{
              fontWeight: 500,
              fontSize: 14,
              color: tokens.colors.text.primary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {displayName}
          </div>
          {trader.source && (
            <div
              style={{
                fontSize: 11,
                color: tokens.colors.text.tertiary,
                textTransform: 'uppercase',
              }}
            >
              {trader.source}
            </div>
          )}
        </div>
      </div>

      {/* Arena Score */}
      <div style={{ width: 60, textAlign: 'center' }}>
        <ArenaScoreDisplay score={trader.arena_score} size="sm" />
      </div>

      {/* ROI - 独立更新 */}
      <div style={{ width: 90, textAlign: 'right' }}>
        <ROIDisplay roi={trader.roi} size="md" />
      </div>

      {/* Win Rate */}
      {trader.win_rate !== null && trader.win_rate !== undefined && (
        <div
          style={{
            width: 60,
            textAlign: 'right',
            fontSize: 13,
            color: tokens.colors.text.secondary,
          }}
        >
          {trader.win_rate.toFixed(1)}%
        </div>
      )}
    </Link>
  )
}, (prevProps, nextProps) => {
  // 自定义比较：只在关键字段变化时重渲染
  if (prevProps.trader.id !== nextProps.trader.id) return false
  if (prevProps.rank !== nextProps.rank) return false
  if (prevProps.isScrolling !== nextProps.isScrolling) return false
  if (prevProps.trader.roi !== nextProps.trader.roi) return false
  if (prevProps.trader.arena_score !== nextProps.trader.arena_score) return false
  if (prevProps.trader.rank_change !== nextProps.trader.rank_change) return false
  return true
})

// ============================================
// 骨架屏组件
// ============================================

const SkeletonRow = memo(function SkeletonRow({
  style,
  index,
}: {
  style: React.CSSProperties
  index: number
}) {
  const delay = (index % 10) * 0.05

  return (
    <div
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${tokens.spacing[4]}`,
        gap: tokens.spacing[3],
      }}
    >
      {/* Rank skeleton */}
      <div
        style={{
          width: 44,
          height: 20,
          borderRadius: 4,
          backgroundColor: tokens.colors.bg.tertiary,
          animation: `pulse 1.5s ease-in-out infinite`,
          animationDelay: `${delay}s`,
        }}
      />
      {/* Avatar skeleton */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          backgroundColor: tokens.colors.bg.tertiary,
          animation: `pulse 1.5s ease-in-out infinite`,
          animationDelay: `${delay}s`,
        }}
      />
      {/* Name skeleton */}
      <div
        style={{
          flex: 1,
          height: 16,
          borderRadius: 4,
          backgroundColor: tokens.colors.bg.tertiary,
          animation: `pulse 1.5s ease-in-out infinite`,
          animationDelay: `${delay}s`,
        }}
      />
      {/* Score skeleton */}
      <div
        style={{
          width: 50,
          height: 20,
          borderRadius: 4,
          backgroundColor: tokens.colors.bg.tertiary,
          animation: `pulse 1.5s ease-in-out infinite`,
          animationDelay: `${delay}s`,
        }}
      />
      {/* ROI skeleton */}
      <div
        style={{
          width: 70,
          height: 16,
          borderRadius: 4,
          backgroundColor: tokens.colors.bg.tertiary,
          animation: `pulse 1.5s ease-in-out infinite`,
          animationDelay: `${delay}s`,
        }}
      />
    </div>
  )
})

// ============================================
// 主组件
// ============================================

export const VirtualRankingList = forwardRef<VirtualRankingListRef, VirtualRankingListProps>(
  function VirtualRankingList(
    {
      traders,
      isLoading = false,
      error,
      skeletonState = 'fresh',
      rowHeight = 64,
      containerHeight = 600,
      overscan = 5,
      onTraderClick,
      onRetry,
      language = 'zh',
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const { isOnline } = useNetworkStatus()

    // 虚拟滚动
    const virtualScroll = useVirtualScroll({
      itemCount: traders.length,
      estimatedItemHeight: rowHeight,
      fixedItemHeight: rowHeight,
      overscan,
      containerHeight,
      useGPU: true,
    })

    // 暴露给父组件的方法
    useImperativeHandle(ref, () => ({
      scrollToTop: () => {
        if (containerRef.current) {
          containerRef.current.scrollTo({ top: 0, behavior: 'smooth' })
        }
      },
      scrollToIndex: virtualScroll.scrollToIndex,
    }))

    // 可见的交易员
    const visibleTraders = useMemo(() => {
      return traders.slice(virtualScroll.startIndex, virtualScroll.endIndex + 1)
    }, [traders, virtualScroll.startIndex, virtualScroll.endIndex])

    // 骨架屏
    if (isLoading && traders.length === 0) {
      return (
        <div
          style={{
            height: containerHeight,
            overflow: 'hidden',
            backgroundColor: tokens.colors.bg.primary,
          }}
        >
          <style>{`
            @keyframes pulse {
              0%, 100% { opacity: 0.4; }
              50% { opacity: 0.8; }
            }
          `}</style>
          {Array.from({ length: Math.ceil(containerHeight / rowHeight) }).map((_, i) => (
            <SkeletonRow
              key={i}
              index={i}
              style={{
                position: 'relative',
                height: rowHeight,
              }}
            />
          ))}
        </div>
      )
    }

    // 错误状态
    if (error) {
      return (
        <div
          style={{
            height: containerHeight,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: tokens.spacing[4],
            backgroundColor: tokens.colors.bg.primary,
          }}
        >
          <div style={{ fontSize: 48, opacity: 0.5 }}>
            {isOnline ? '!' : 'X'}
          </div>
          <div style={{ color: tokens.colors.text.secondary, textAlign: 'center' }}>
            {isOnline
              ? (language === 'zh' ? '加载失败' : 'Failed to load')
              : (language === 'zh' ? '网络连接已断开' : 'You are offline')}
          </div>
          <div style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
            {error}
          </div>
          {onRetry && isOnline && (
            <button
              onClick={onRetry}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.md,
                backgroundColor: tokens.colors.accent.primary,
                color: 'white',
                border: 'none',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {language === 'zh' ? '重试' : 'Retry'}
            </button>
          )}
        </div>
      )
    }

    // 空状态
    if (traders.length === 0) {
      return (
        <div
          style={{
            height: containerHeight,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tokens.colors.text.secondary,
            backgroundColor: tokens.colors.bg.primary,
          }}
        >
          {language === 'zh' ? '暂无排行榜数据' : 'No leaderboard data'}
        </div>
      )
    }

    return (
      <div
        ref={containerRef}
        onScroll={virtualScroll.onScroll}
        style={{
          height: containerHeight,
          overflow: 'auto',
          position: 'relative',
          backgroundColor: tokens.colors.bg.primary,
          // 优化滚动性能
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <style>{`
          .virtual-row:hover {
            background-color: ${tokens.colors.bg.hover} !important;
          }
          @keyframes pulse {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 0.8; }
          }
        `}</style>

        {/* 状态指示条 */}
        {(skeletonState === 'stale' || skeletonState === 'offline') && (
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 10,
              padding: '4px 12px',
              fontSize: 11,
              textAlign: 'center',
              backgroundColor: skeletonState === 'offline'
                ? tokens.colors.accent.warning
                : tokens.colors.accent.primary,
              color: 'white',
            }}
          >
            {skeletonState === 'offline'
              ? (language === 'zh' ? '离线模式 - 显示缓存数据' : 'Offline - showing cached data')
              : (language === 'zh' ? '正在更新...' : 'Updating...')}
          </div>
        )}

        {/* 虚拟滚动容器 */}
        <div style={{ height: virtualScroll.totalHeight, position: 'relative' }}>
          {visibleTraders.map((trader, i) => {
            const actualIndex = virtualScroll.startIndex + i
            const rank = actualIndex + 1

            return (
              <VirtualRow
                key={trader.id}
                trader={trader}
                rank={rank}
                style={virtualScroll.getItemStyle(actualIndex)}
                onClick={onTraderClick}
                isScrolling={virtualScroll.isScrolling && virtualScroll.scrollDirection !== null}
              />
            )
          })}
        </div>
      </div>
    )
  }
)

export default VirtualRankingList
