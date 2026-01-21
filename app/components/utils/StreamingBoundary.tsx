'use client'

/**
 * 流式渲染边界组件
 * 为服务端组件提供优雅的加载状态
 */

import { Suspense, ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

// ============================================
// 类型定义
// ============================================

interface StreamingBoundaryProps {
  /** 子组件 */
  children: ReactNode
  /** 加载时显示的内容 */
  fallback?: ReactNode
  /** 最小高度 */
  minHeight?: number | string
  /** 骨架屏类型 */
  skeleton?: 'card' | 'list' | 'table' | 'text' | 'custom'
  /** 骨架屏数量 */
  skeletonCount?: number
  /** 延迟显示加载状态（毫秒） */
  delay?: number
}

// ============================================
// 骨架屏组件
// ============================================

function SkeletonPulse({ className = '' }: { className?: string }) {
  return (
    <Box
      className={className}
      style={{
        background: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, ${tokens.colors.bg.secondary} 50%, ${tokens.colors.bg.tertiary} 100%)`,
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite',
        borderRadius: tokens.radius.md,
      }}
    />
  )
}

function CardSkeleton() {
  return (
    <Box
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        padding: tokens.spacing[4],
      }}
    >
      <SkeletonPulse className="h-4 w-1/3 mb-3" />
      <SkeletonPulse className="h-3 w-full mb-2" />
      <SkeletonPulse className="h-3 w-2/3" />
    </Box>
  )
}

function ListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {Array.from({ length: count }).map((_, i) => (
        <Box
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[3],
            padding: tokens.spacing[3],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.md,
          }}
        >
          <SkeletonPulse className="w-10 h-10 rounded-full flex-shrink-0" />
          <Box style={{ flex: 1 }}>
            <SkeletonPulse className="h-4 w-1/3 mb-2" />
            <SkeletonPulse className="h-3 w-1/2" />
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function TableSkeleton({ count = 5 }: { count?: number }) {
  return (
    <Box
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        overflow: 'hidden',
      }}
    >
      {/* 表头 */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: '60px 1fr 100px 100px',
          gap: tokens.spacing[2],
          padding: tokens.spacing[3],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.tertiary,
        }}
      >
        <SkeletonPulse className="h-4" />
        <SkeletonPulse className="h-4" />
        <SkeletonPulse className="h-4" />
        <SkeletonPulse className="h-4" />
      </Box>
      {/* 表体 */}
      {Array.from({ length: count }).map((_, i) => (
        <Box
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '60px 1fr 100px 100px',
            gap: tokens.spacing[2],
            padding: tokens.spacing[3],
            borderBottom: i < count - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
          }}
        >
          <SkeletonPulse className="h-4" />
          <SkeletonPulse className="h-4" />
          <SkeletonPulse className="h-4" />
          <SkeletonPulse className="h-4" />
        </Box>
      ))}
    </Box>
  )
}

function TextSkeleton({ count = 3 }: { count?: number }) {
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonPulse
          key={i}
          className={`h-4 ${i === count - 1 ? 'w-2/3' : 'w-full'}`}
        />
      ))}
    </Box>
  )
}

// ============================================
// 默认 Fallback
// ============================================

function DefaultFallback({
  skeleton,
  skeletonCount,
  minHeight,
}: {
  skeleton: StreamingBoundaryProps['skeleton']
  skeletonCount: number
  minHeight?: number | string
}) {
  const content = (() => {
    switch (skeleton) {
      case 'card':
        return <CardSkeleton />
      case 'list':
        return <ListSkeleton count={skeletonCount} />
      case 'table':
        return <TableSkeleton count={skeletonCount} />
      case 'text':
        return <TextSkeleton count={skeletonCount} />
      default:
        return (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: minHeight || 200,
            }}
          >
            <Box
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                border: `2px solid ${tokens.colors.border.primary}`,
                borderTopColor: tokens.colors.accent.primary,
                animation: 'spin 1s linear infinite',
              }}
            />
          </Box>
        )
    }
  })()

  return (
    <Box style={{ minHeight }}>
      {content}
    </Box>
  )
}

// ============================================
// 主组件
// ============================================

/**
 * 流式渲染边界组件
 * 包装需要流式渲染的服务端组件
 */
export default function StreamingBoundary({
  children,
  fallback,
  minHeight,
  skeleton = 'custom',
  skeletonCount = 3,
}: StreamingBoundaryProps) {
  const fallbackContent = fallback || (
    <DefaultFallback
      skeleton={skeleton}
      skeletonCount={skeletonCount}
      minHeight={minHeight}
    />
  )

  return (
    <Suspense fallback={fallbackContent}>
      {children}
    </Suspense>
  )
}

// ============================================
// 导出骨架屏组件
// ============================================

export {
  CardSkeleton,
  ListSkeleton,
  TableSkeleton,
  TextSkeleton,
  SkeletonPulse,
}
