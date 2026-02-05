'use client'

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
        return {
          backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light, rgba(255, 255, 255, 0.08)) 50%, ${tokens.colors.bg.tertiary} 100%)`,
          backgroundSize: '200% 100%',
          backgroundRepeat: 'no-repeat',
          backgroundColor: tokens.colors.bg.tertiary,
          animation: 'shimmer 1.5s ease-in-out infinite',
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

export function RankingSkeleton() {
  return (
    <Box 
      className="stagger-children"
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <Box
          key={i}
          className="glass-card-hover"
          p={3}
          radius="lg"
          style={{
            display: 'grid',
            gridTemplateColumns: '40px 1fr 60px 80px 60px',
            alignItems: 'center',
            gap: tokens.spacing[3],
          }}
        >
          {/* Rank */}
          <Skeleton width="28px" height="28px" variant="circular" />
          
          {/* Trader Info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <SkeletonAvatar size={36} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
              <Skeleton width="80px" height="14px" />
              <Skeleton width="50px" height="10px" />
            </div>
          </div>
          
          {/* Score */}
          <Skeleton width="48px" height="24px" variant="rounded" />
          
          {/* ROI */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: tokens.spacing[1] }}>
            <Skeleton width="60px" height="16px" />
            <Skeleton width="40px" height="10px" />
          </div>
          
          {/* Win Rate */}
          <Skeleton width="40px" height="14px" />
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