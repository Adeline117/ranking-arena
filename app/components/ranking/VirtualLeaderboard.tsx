'use client'

/**
 * Virtual Leaderboard - 虚拟滚动排行榜
 * 
 * 只渲染视口内的 10-20 行数据
 * 配合 requestAnimationFrame 进行平滑滚动
 * 支持几百个交易员的丝滑浏览
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  memo
} from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export interface TraderRow {
  id: string
  rank: number
  name: string
  avatar?: string
  roi: number
  pnl?: number
  winRate?: number
  drawdown?: number
  followers?: number
  source: string
  trustTier?: 'high' | 'medium' | 'low'
}

interface VirtualLeaderboardProps {
  data: TraderRow[]
  rowHeight?: number
  overscan?: number
  onRowClick?: (trader: TraderRow) => void
  renderRow?: (trader: TraderRow, index: number, style: React.CSSProperties) => React.ReactNode
  className?: string
  isLoading?: boolean
}

interface RowProps {
  trader: TraderRow
  style: React.CSSProperties
  onClick?: (trader: TraderRow) => void
}

// 默认行渲染
const DefaultRow = memo(({ trader, style, onClick }: RowProps) => {
  const roiColor = trader.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <div
      className="ranking-row-hover"
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${tokens.spacing[4]}`,
        borderBottom: `1px solid ${tokens.colors.border.secondary}`,
        cursor: onClick ? 'pointer' : 'default',
      }}
      onClick={() => onClick?.(trader)}
    >
      {/* Rank */}
      <div style={{ width: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {trader.rank <= 3 ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28, height: 28, borderRadius: '50%',
              fontSize: 13, fontWeight: 700,
              background: trader.rank === 1
                ? `linear-gradient(135deg, ${tokens.colors.medal.gold}, ${tokens.colors.medal.goldEnd})`
                : trader.rank === 2
                ? `linear-gradient(135deg, ${tokens.colors.medal.silver}, ${tokens.colors.medal.silverEnd})`
                : `linear-gradient(135deg, ${tokens.colors.medal.bronze}, ${tokens.colors.medal.bronzeEnd})`,
              color: trader.rank === 1 ? tokens.colors.medal.goldText : tokens.colors.white,
            }}
          >
            {trader.rank}
          </span>
        ) : (
          <span style={{ fontWeight: 400, color: tokens.colors.text.secondary }}>
            #{trader.rank}
          </span>
        )}
      </div>

      {/* Avatar & Name */}
      <div style={{ 
        flex: 1, 
        display: 'flex', 
        alignItems: 'center', 
        gap: tokens.spacing[3],
        minWidth: 0,
      }}>
        {trader.avatar ? (
          <Image 
            src={trader.avatar} 
            alt={trader.name}
            width={32}
            height={32}
            style={{ 
              borderRadius: '50%',
              objectFit: 'cover',
            }}
            unoptimized
          />
        ) : (
          <div style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: `linear-gradient(135deg, ${tokens.colors.accent.brand}, ${tokens.colors.accent.brandHover})`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            fontSize: 14,
            fontWeight: 600,
          }}>
            {trader.name.charAt(0).toUpperCase()}
          </div>
        )}
        <span style={{ 
          overflow: 'hidden', 
          textOverflow: 'ellipsis', 
          whiteSpace: 'nowrap',
          fontWeight: 500,
        }}>
          {trader.name}
        </span>
      </div>

      {/* ROI */}
      <div style={{ 
        width: 100, 
        textAlign: 'right',
        fontWeight: 600,
        color: roiColor,
        fontFamily: 'var(--font-mono)',
      }}>
        {trader.roi >= 0 ? '+' : ''}{trader.roi.toFixed(2)}%
      </div>

      {/* PnL */}
      {trader.pnl !== undefined && (
        <div style={{ 
          width: 100, 
          textAlign: 'right',
          color: trader.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
          fontFamily: 'var(--font-mono)',
        }}>
          ${trader.pnl >= 0 ? '+' : ''}{trader.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </div>
      )}

      {/* Win Rate */}
      {trader.winRate !== undefined && (
        <div style={{ 
          width: 80, 
          textAlign: 'right',
          color: tokens.colors.text.secondary,
        }}>
          {trader.winRate.toFixed(1)}%
        </div>
      )}

      {/* Source Badge */}
      <div style={{
        width: 80,
        textAlign: 'right',
      }}>
        <span style={{
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 4,
          backgroundColor: tokens.colors.bg.tertiary,
          color: tokens.colors.text.secondary,
          textTransform: 'uppercase',
        }}>
          {trader.source}
        </span>
        {trader.trustTier && (
          <span style={{
            fontSize: 9,
            padding: '1px 5px',
            borderRadius: 3,
            backgroundColor: trader.trustTier === 'high' ? `${tokens.colors.accent.success}18`
              : trader.trustTier === 'medium' ? `${tokens.colors.accent.warning}18`
              : `${tokens.colors.accent.error}18`,
            color: trader.trustTier === 'high' ? tokens.colors.accent.success
              : trader.trustTier === 'medium' ? tokens.colors.accent.warning
              : tokens.colors.accent.error,
            fontWeight: 500,
          }}>
            {trader.trustTier === 'high' ? '可信' : trader.trustTier === 'medium' ? '一般' : '低信任'}
          </span>
        )}
      </div>
    </div>
  )
})

DefaultRow.displayName = 'DefaultRow'

export function VirtualLeaderboard({
  data,
  rowHeight = 56,
  overscan = 5,
  onRowClick,
  renderRow,
  className,
  isLoading,
}: VirtualLeaderboardProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const rafRef = useRef<number | null>(null)
  const { language } = useLanguage()

  // 计算可见范围
  const { startIndex, endIndex, visibleItems } = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    const visibleCount = Math.ceil(containerHeight / rowHeight)
    const end = Math.min(data.length - 1, start + visibleCount + overscan * 2)
    
    return {
      startIndex: start,
      endIndex: end,
      visibleItems: data.slice(start, end + 1),
    }
  }, [scrollTop, containerHeight, rowHeight, overscan, data])

  // 总高度
  const totalHeight = data.length * rowHeight

  // 滚动处理 (使用 RAF 优化)
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }

    rafRef.current = requestAnimationFrame(() => {
      setScrollTop(target.scrollTop)
    })
  }, [])

  // 监听容器大小
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height)
      }
    })

    observer.observe(container)
    setContainerHeight(container.clientHeight)

    return () => {
      observer.disconnect()
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [])

  // Loading 骨架屏
  if (isLoading) {
    return (
      <div 
        className={className}
        style={{ 
          height: '100%', 
          overflow: 'hidden',
          backgroundColor: tokens.colors.bg.primary,
        }}
      >
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            style={{
              height: rowHeight,
              display: 'flex',
              alignItems: 'center',
              padding: `0 ${tokens.spacing[4]}`,
              gap: tokens.spacing[3],
            }}
          >
            <div style={{ 
              width: 50, 
              height: 16, 
              borderRadius: 4,
              backgroundColor: tokens.colors.bg.tertiary,
              animation: 'pulse 1.5s infinite',
            }} />
            <div style={{ 
              width: 32, 
              height: 32, 
              borderRadius: '50%',
              backgroundColor: tokens.colors.bg.tertiary,
            }} />
            <div style={{ 
              flex: 1, 
              height: 16, 
              borderRadius: 4,
              backgroundColor: tokens.colors.bg.tertiary,
            }} />
            <div style={{ 
              width: 80, 
              height: 16, 
              borderRadius: 4,
              backgroundColor: tokens.colors.bg.tertiary,
            }} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={className}
      onScroll={handleScroll}
      style={{
        height: '100%',
        overflow: 'auto',
        position: 'relative',
        backgroundColor: tokens.colors.bg.primary,
      }}
    >
      {/* 撑起总高度的占位元素 */}
      <div style={{ height: totalHeight, position: 'relative' }}>
        {/* 只渲染可见行 */}
        {visibleItems.map((trader, i) => {
          const actualIndex = startIndex + i
          const style: React.CSSProperties = {
            position: 'absolute',
            top: actualIndex * rowHeight,
            left: 0,
            right: 0,
            height: rowHeight,
          }

          if (renderRow) {
            return (
              <div key={trader.id} style={style}>
                {renderRow(trader, actualIndex, style)}
              </div>
            )
          }

          return (
            <DefaultRow
              key={trader.id}
              trader={trader}
              style={style}
              onClick={onRowClick}
            />
          )
        })}
      </div>

      {/* 空状态 */}
      {data.length === 0 && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          color: tokens.colors.text.secondary,
        }}>
          <p>{language === 'zh' ? '暂无排行榜数据' : 'No leaderboard data'}</p>
        </div>
      )}
    </div>
  )
}

export default VirtualLeaderboard
