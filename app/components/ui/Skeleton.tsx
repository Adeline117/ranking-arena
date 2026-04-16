
import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'

interface SkeletonProps {
  width?: string | number
  height?: string | number
  variant?: 'text' | 'circular' | 'rectangular' | 'rounded'
  animation?: 'pulse' | 'shimmer' | 'none'
  className?: string
  style?: React.CSSProperties
}

// Helper to convert number to px string
const toPx = (value: string | number): string => {
  if (typeof value === 'number') return `${value}px`
  return value
}

export function Skeleton({
  width = '100%',
  height = '16px',
  variant = 'rounded',
  animation = 'shimmer',
  className = '',
  style,
}: SkeletonProps) {
  const getBorderRadius = () => {
    switch (variant) {
      case 'circular':
        return tokens.radius.full
      case 'rectangular':
        return tokens.radius.none
      case 'text':
        return tokens.radius.sm
      case 'rounded':
      default:
        return tokens.radius.md
    }
  }

  const getAnimationStyle = (): React.CSSProperties => {
    switch (animation) {
      case 'shimmer':
        // Uses .skeleton CSS class with ::after pseudo-element for GPU-composited animation
        // (transform: translateX instead of background-position)
        return {
          backgroundColor: tokens.colors.bg.tertiary,
        }
      case 'pulse':
        return {
          backgroundColor: tokens.colors.bg.tertiary,
          animation: 'skeletonPulse 1.5s ease-in-out infinite',
        }
      case 'none':
      default:
        return {
          backgroundColor: tokens.colors.bg.tertiary,
        }
    }
  }

  return (
    <div
      className={`skeleton ${className}`}
      aria-busy="true"
      aria-label="Loading"
      style={{
        width: toPx(width),
        height: toPx(height),
        borderRadius: getBorderRadius(),
        ...getAnimationStyle(),
        ...style,
      }}
    />
  )
}

export function SkeletonLine({ width = '100%', height = '16px' }: { width?: string | number; height?: string | number }) {
  return <Skeleton width={width} height={height} variant="rounded" animation="shimmer" />
}

export function SkeletonText({ lines = 3, spacing = 8 }: { lines?: number; spacing?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton 
          key={i} 
          width={i === lines - 1 ? '60%' : '100%'} 
          height="14px" 
          variant="text"
        />
      ))}
    </div>
  )
}

export function SkeletonAvatar({ size = 40 }: { size?: number }) {
  return <Skeleton width={`${size}px`} height={`${size}px`} variant="circular" />
}

export function SkeletonButton({ width = '80px', height = '36px' }: { width?: string; height?: string }) {
  return <Skeleton width={width} height={height} variant="rounded" />
}

export function SkeletonCard() {
  return (
    <Box
      className="glass-card"
      p={4}
      radius="xl"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[3],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
        <SkeletonAvatar size={48} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          <Skeleton width="60%" height="16px" />
          <Skeleton width="40%" height="12px" />
        </div>
      </div>
      <SkeletonText lines={2} />
      <div style={{ display: 'flex', gap: tokens.spacing[2], marginTop: tokens.spacing[2] }}>
        <SkeletonButton width="100px" height="32px" />
        <SkeletonButton width="100px" height="32px" />
      </div>
    </Box>
  )
}

/**
 * ChartSkeleton — structured skeleton for dynamic chart fallbacks.
 *
 * Replaces bare animated divs (`<div style={{minHeight:200}}/>`) on
 * Suspense fallbacks for EquityCurveSection, DailyReturnsChart, etc.
 * Hints at chart structure (title + gridlines + wave) so users know
 * it's a chart loading, not just a blank box.
 */
export function ChartSkeleton({
  height = 200,
  showTitle = true,
  variant = 'line',
}: {
  height?: number
  showTitle?: boolean
  variant?: 'line' | 'bar'
} = {}) {
  const plotHeight = height - (showTitle ? 48 : 16)
  const gridLines = 4

  return (
    <Box
      role="status"
      aria-label="Loading chart"
      style={{
        minHeight: height,
        borderRadius: tokens.radius.lg,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {showTitle && (
        <div style={{ padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Skeleton width="120px" height="14px" variant="rounded" animation="pulse" />
          <Skeleton width="60px" height="12px" variant="rounded" animation="pulse" />
        </div>
      )}
      {/* Plot area with gridlines */}
      <div
        style={{
          position: 'relative',
          height: plotHeight,
          margin: `0 ${tokens.spacing[4]} ${tokens.spacing[3]}`,
        }}
      >
        {/* Horizontal gridlines */}
        {Array.from({ length: gridLines }).map((_, i) => (
          <div
            key={`grid-${i}`}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${((i + 1) / (gridLines + 1)) * 100}%`,
              height: 1,
              background: tokens.colors.border.primary,
              opacity: 0.3,
            }}
          />
        ))}
        {/* Wave/bar shape to hint at data */}
        {variant === 'line' ? (
          <svg
            width="100%"
            height="100%"
            viewBox="0 0 400 100"
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, animation: 'skeletonPulse 1.5s ease-in-out infinite' }}
            aria-hidden="true"
          >
            <path
              d="M0,70 C60,40 100,80 160,50 C220,20 260,60 320,30 C360,10 380,25 400,15 L400,100 L0,100 Z"
              fill={tokens.colors.bg.tertiary}
              opacity="0.6"
            />
            <path
              d="M0,70 C60,40 100,80 160,50 C220,20 260,60 320,30 C360,10 380,25 400,15"
              fill="none"
              stroke={tokens.colors.bg.tertiary}
              strokeWidth="2"
            />
          </svg>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 4, animation: 'skeletonPulse 1.5s ease-in-out infinite' }} aria-hidden="true">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: `${30 + Math.sin(i * 0.8) * 30 + 20}%`,
                  background: tokens.colors.bg.tertiary,
                  borderRadius: `${tokens.radius.sm} ${tokens.radius.sm} 0 0`,
                  opacity: 0.6,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </Box>
  )
}

export function RankingSkeleton({ rows = 10 }: { rows?: number } = {}) {
  return (
    <Box 
      className="stagger-children"
      role="status"
      aria-label="Loading rankings"
      style={{ display: 'flex', flexDirection: 'column', gap: 0 }}
    >
      {/* Skeleton header */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: '40px minmax(140px, 1.5fr) 58px 96px 80px 64px 64px',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}30`,
        }}
      >
        <Skeleton width="20px" height="12px" variant="rounded" animation="pulse" />
        <Skeleton width="60px" height="12px" variant="rounded" animation="pulse" />
        <Skeleton width="30px" height="12px" variant="rounded" animation="pulse" style={{ marginLeft: 'auto' }} />
        <Skeleton width="30px" height="12px" variant="rounded" animation="pulse" style={{ marginLeft: 'auto' }} />
        <Skeleton width="30px" height="12px" variant="rounded" animation="pulse" style={{ marginLeft: 'auto' }} />
        <Skeleton width="30px" height="12px" variant="rounded" animation="pulse" style={{ marginLeft: 'auto' }} />
        <Skeleton width="36px" height="12px" variant="rounded" animation="pulse" style={{ marginLeft: 'auto' }} />
      </Box>
      {Array.from({ length: rows }).map((_, i) => (
        <Box
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '40px minmax(140px, 1.5fr) 58px 96px 80px 64px 64px',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `10px ${tokens.spacing[4]}`,
            minHeight: 56,
            borderBottom: `1px solid ${tokens.colors.border.primary}15`,
            animationDelay: `${i * 50}ms`,
          }}
        >
          {/* Rank */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            {i < 3 ? (
              <Skeleton width="30px" height="30px" variant="circular" />
            ) : (
              <Skeleton width="24px" height="14px" variant="rounded" />
            )}
          </div>
          
          {/* Trader Info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], minWidth: 0 }}>
            <Skeleton width="36px" height="36px" variant="circular" style={{ flexShrink: 0 }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
              <Skeleton width={`${60 + (i * 17 % 40)}%`} height="14px" />
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Skeleton width="14px" height="14px" variant="circular" />
                <Skeleton width="50px" height="10px" />
              </div>
            </div>
          </div>
          
          {/* ROI */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Skeleton width="64px" height="16px" variant="rounded" />
          </div>
          
          {/* PnL */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }} className="col-pnl">
            <Skeleton width="56px" height="14px" variant="rounded" />
          </div>
          
          {/* Win% */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }} className="col-winrate">
            <Skeleton width="40px" height="14px" variant="rounded" />
          </div>
          
          {/* MDD */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }} className="col-mdd">
            <Skeleton width="40px" height="14px" variant="rounded" />
          </div>
          
          {/* Score */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }} className="col-score">
            <Skeleton width="56px" height="24px" variant="rounded" />
          </div>
        </Box>
      ))}
    </Box>
  )
}

export function TraderCardSkeleton() {
  return (
    <Box
      className="glass-card"
      p={5}
      radius="xl"
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <SkeletonAvatar size={56} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            <Skeleton width="120px" height="20px" />
            <Skeleton width="80px" height="14px" />
          </div>
        </div>
        <SkeletonButton width="80px" height="32px" />
      </div>
      
      {/* Stats Grid */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(4, 1fr)', 
        gap: tokens.spacing[3],
        padding: tokens.spacing[3],
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.lg,
      }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1], alignItems: 'center' }}>
            <Skeleton width="50px" height="24px" />
            <Skeleton width="40px" height="10px" />
          </div>
        ))}
      </div>
      
      {/* Chart Area */}
      <Skeleton width="100%" height="120px" variant="rounded" />
    </Box>
  )
}

export function PostSkeleton() {
  return (
    <Box
      className="glass-card"
      p={4}
      radius="xl"
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}
    >
      {/* Author */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
        <SkeletonAvatar size={40} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          <Skeleton width="100px" height="14px" />
          <Skeleton width="60px" height="10px" />
        </div>
      </div>
      
      {/* Content */}
      <SkeletonText lines={3} />
      
      {/* Actions */}
      <div style={{ display: 'flex', gap: tokens.spacing[4], paddingTop: tokens.spacing[2] }}>
        <Skeleton width="50px" height="20px" />
        <Skeleton width="50px" height="20px" />
        <Skeleton width="50px" height="20px" />
      </div>
    </Box>
  )
}

export function ProfileSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
      {/* Header */}
      <Box
        className="glass-card"
        p={6}
        radius="xl"
        style={{ display: 'flex', gap: tokens.spacing[6], alignItems: 'center' }}
      >
        <SkeletonAvatar size={96} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          <Skeleton width="200px" height="28px" />
          <Skeleton width="150px" height="16px" />
          <div style={{ display: 'flex', gap: tokens.spacing[4], marginTop: tokens.spacing[2] }}>
            <Skeleton width="80px" height="14px" />
            <Skeleton width="80px" height="14px" />
            <Skeleton width="80px" height="14px" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: tokens.spacing[2] }}>
          <SkeletonButton width="100px" height="40px" />
          <SkeletonButton width="100px" height="40px" />
        </div>
      </Box>
      
      {/* Stats Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[4] }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Box key={i} className="glass-card" p={4} radius="xl">
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], alignItems: 'center' }}>
              <Skeleton width="60px" height="32px" />
              <Skeleton width="80px" height="12px" />
            </div>
          </Box>
        ))}
      </div>
    </div>
  )
}

// 通知列表骨架屏
export function NotificationSkeleton() {
  return (
    <Box
      className="glass-card"
      p={3}
      radius="lg"
      style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3] }}
    >
      <SkeletonAvatar size={40} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        <Skeleton width="80%" height="14px" />
        <Skeleton width="60%" height="12px" />
        <Skeleton width="40%" height="10px" />
      </div>
    </Box>
  )
}

// 小组卡片骨架屏
export function GroupCardSkeleton() {
  return (
    <Box
      className="glass-card"
      p={4}
      radius="xl"
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
        <SkeletonAvatar size={48} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          <Skeleton width="70%" height="16px" />
          <Skeleton width="40%" height="12px" />
        </div>
      </div>
      <Skeleton width="100%" height="40px" />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Skeleton width="60px" height="12px" />
        <Skeleton width="60px" height="12px" />
      </div>
    </Box>
  )
}

// 列表加载骨架屏 (通用)
export function ListSkeleton({ count = 5, gap = 12 }: { count?: number; gap?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: count }).map((_, i) => (
        <Box
          key={i}
          className="glass-card"
          p={3}
          radius="lg"
          style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}
        >
          <SkeletonAvatar size={40} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
            <Skeleton width="60%" height="14px" />
            <Skeleton width="40%" height="10px" />
          </div>
          <Skeleton width="50px" height="24px" />
        </Box>
      ))}
    </div>
  )
}

// 表格骨架屏
export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {/* 表头 */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: tokens.spacing[3],
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.md,
      }}>
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} width="60%" height="12px" />
        ))}
      </div>
      
      {/* 表行 */}
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div 
          key={rowIndex}
          style={{ 
            display: 'grid', 
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
            gap: tokens.spacing[3],
            padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.md,
          }}
        >
          {Array.from({ length: columns }).map((_, colIndex) => (
            <Skeleton 
              key={colIndex} 
              width={colIndex === 0 ? '40px' : '80%'} 
              height="16px" 
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export default Skeleton