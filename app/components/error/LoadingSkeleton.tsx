/**
 * 统一的 Loading Skeleton 组件
 * 为不同类型的内容提供加载占位符
 */

import React from 'react'
import { tokens } from '@/lib/design-tokens'

interface LoadingSkeletonProps {
  type?: 'card' | 'list' | 'table' | 'trader' | 'ranking' | 'text' | 'avatar' | 'custom'
  count?: number
  className?: string
  style?: React.CSSProperties
  width?: string | number
  height?: string | number
  borderRadius?: string | number
  animated?: boolean
}

// 基础骨架组件
function SkeletonBase({
  width = '100%',
  height = '16px',
  borderRadius = tokens.radius.md,
  animated = true,
  className = '',
  style = {},
}: {
  width?: string | number
  height?: string | number
  borderRadius?: string | number
  animated?: boolean
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      className={`${animated ? 'skeleton-animated' : ''} ${className}`}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: typeof borderRadius === 'number' ? `${borderRadius}px` : borderRadius,
        backgroundColor: tokens.colors.bg.tertiary,
        ...style,
      }}
    />
  )
}

// 卡片骨架
function CardSkeleton({ animated = true }: { animated?: boolean }) {
  return (
    <div
      style={{
        padding: tokens.spacing[6],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {/* 头像和标题 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
        <SkeletonBase width={40} height={40} borderRadius="50%" animated={animated} />
        <div style={{ flex: 1 }}>
          <SkeletonBase width="60%" height={16} animated={animated} style={{ marginBottom: tokens.spacing[2] }} />
          <SkeletonBase width="40%" height={12} animated={animated} />
        </div>
      </div>
      
      {/* 内容区域 */}
      <SkeletonBase width="100%" height={12} animated={animated} style={{ marginBottom: tokens.spacing[2] }} />
      <SkeletonBase width="80%" height={12} animated={animated} style={{ marginBottom: tokens.spacing[2] }} />
      <SkeletonBase width="90%" height={12} animated={animated} />
    </div>
  )
}

// 列表项骨架
function ListItemSkeleton({ animated = true }: { animated?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], padding: tokens.spacing[3] }}>
      <SkeletonBase width={32} height={32} borderRadius="50%" animated={animated} />
      <div style={{ flex: 1 }}>
        <SkeletonBase width="70%" height={14} animated={animated} style={{ marginBottom: tokens.spacing[1] }} />
        <SkeletonBase width="50%" height={12} animated={animated} />
      </div>
      <SkeletonBase width={60} height={14} animated={animated} />
    </div>
  )
}

// 表格行骨架
function TableRowSkeleton({ animated = true }: { animated?: boolean }) {
  return (
    <div style={{ 
      display: 'grid', 
      gridTemplateColumns: '1fr 120px 100px 100px 80px',
      gap: tokens.spacing[4],
      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
      alignItems: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        <SkeletonBase width={24} height={24} borderRadius="50%" animated={animated} />
        <SkeletonBase width="60%" height={14} animated={animated} />
      </div>
      <SkeletonBase width="80%" height={14} animated={animated} />
      <SkeletonBase width="100%" height={14} animated={animated} />
      <SkeletonBase width="100%" height={14} animated={animated} />
      <SkeletonBase width="100%" height={14} animated={animated} />
    </div>
  )
}

// 交易员卡片骨架
function TraderSkeleton({ animated = true }: { animated?: boolean }) {
  return (
    <div
      style={{
        padding: tokens.spacing[6],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {/* 头部信息 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginBottom: tokens.spacing[6] }}>
        <SkeletonBase width={60} height={60} borderRadius="50%" animated={animated} />
        <div style={{ flex: 1 }}>
          <SkeletonBase width="40%" height={18} animated={animated} style={{ marginBottom: tokens.spacing[2] }} />
          <SkeletonBase width="60%" height={14} animated={animated} style={{ marginBottom: tokens.spacing[2] }} />
          <SkeletonBase width="30%" height={12} animated={animated} />
        </div>
        <SkeletonBase width={80} height={32} borderRadius={tokens.radius.md} animated={animated} />
      </div>
      
      {/* 统计数据 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[4] }}>
        {[...Array(3)].map((_, i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <SkeletonBase width="100%" height={20} animated={animated} style={{ marginBottom: tokens.spacing[2] }} />
            <SkeletonBase width="60%" height={12} animated={animated} style={{ margin: '0 auto' }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// 排名表格骨架
function RankingSkeleton({ animated = true }: { animated?: boolean }) {
  return (
    <div style={{ background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg }}>
      {/* 表头 */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: '60px 1fr 120px 100px 100px 80px',
        gap: tokens.spacing[4],
        padding: tokens.spacing[4],
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
      }}>
        {['#', '交易员', 'ROI', '胜率', 'MDD', 'Score'].map((_, i) => (
          <SkeletonBase key={i} width="80%" height={12} animated={animated} />
        ))}
      </div>
      
      {/* 表格行 */}
      {[...Array(8)].map((_, i) => (
        <div key={i}>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: '60px 1fr 120px 100px 100px 80px',
            gap: tokens.spacing[4],
            padding: tokens.spacing[4],
            alignItems: 'center',
          }}>
            <SkeletonBase width={24} height={14} animated={animated} />
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <SkeletonBase width={32} height={32} borderRadius="50%" animated={animated} />
              <div style={{ flex: 1 }}>
                <SkeletonBase width="70%" height={14} animated={animated} style={{ marginBottom: tokens.spacing[1] }} />
                <SkeletonBase width="50%" height={12} animated={animated} />
              </div>
            </div>
            <SkeletonBase width="80%" height={14} animated={animated} />
            <SkeletonBase width="80%" height={14} animated={animated} />
            <SkeletonBase width="80%" height={14} animated={animated} />
            <SkeletonBase width={36} height={14} animated={animated} />
          </div>
          {i < 7 && <div style={{ height: 1, background: tokens.colors.border.primary, margin: `0 ${tokens.spacing[4]}` }} />}
        </div>
      ))}
    </div>
  )
}

// 主要组件
export default function LoadingSkeleton({
  type = 'text',
  count = 1,
  className = '',
  style = {},
  width,
  height,
  borderRadius,
  animated = true,
}: LoadingSkeletonProps) {
  // 注入CSS动画样式
  React.useEffect(() => {
    if (!animated || typeof window === 'undefined') return
    
    const styleId = 'skeleton-animations'
    if (document.getElementById(styleId)) return
    
    const styleElement = document.createElement('style')
    styleElement.id = styleId
    styleElement.textContent = `
      @keyframes skeleton-loading {
        0% {
          background-position: -200px 0;
        }
        100% {
          background-position: calc(200px + 100%) 0;
        }
      }
      
      .skeleton-animated {
        background: linear-gradient(
          90deg,
          ${tokens.colors.bg.tertiary} 0px,
          ${tokens.colors.bg.hover} 40px,
          ${tokens.colors.bg.tertiary} 80px
        ) !important;
        background-size: 200px 100% !important;
        animation: skeleton-loading 1.5s infinite !important;
      }
    `
    document.head.appendChild(styleElement)
  }, [animated])

  const renderSkeleton = () => {
    switch (type) {
      case 'card':
        return <CardSkeleton animated={animated} />
      case 'list':
        return <ListItemSkeleton animated={animated} />
      case 'table':
        return <TableRowSkeleton animated={animated} />
      case 'trader':
        return <TraderSkeleton animated={animated} />
      case 'ranking':
        return <RankingSkeleton animated={animated} />
      case 'avatar':
        return <SkeletonBase width={width || 40} height={height || 40} borderRadius="50%" animated={animated} />
      case 'custom':
        return (
          <SkeletonBase
            width={width}
            height={height}
            borderRadius={borderRadius}
            animated={animated}
            className={className}
            style={style}
          />
        )
      case 'text':
      default:
        return (
          <SkeletonBase
            width={width || '100%'}
            height={height || 16}
            borderRadius={borderRadius || tokens.radius.sm}
            animated={animated}
            className={className}
            style={style}
          />
        )
    }
  }

  if (count === 1) {
    return renderSkeleton()
  }

  return (
    <div className={className} style={style}>
      {[...Array(count)].map((_, index) => (
        <div key={index} style={{ marginBottom: tokens.spacing[2] }}>
          {renderSkeleton()}
        </div>
      ))}
    </div>
  )
}

// 导出具体的骨架组件以供直接使用
export {
  SkeletonBase,
  CardSkeleton,
  ListItemSkeleton,
  TableRowSkeleton,
  TraderSkeleton,
  RankingSkeleton,
}