
import { tokens } from '@/lib/design-tokens'

interface LoadingSpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  color?: string
  className?: string
  style?: React.CSSProperties
}

const sizeMap = {
  xs: 12,
  sm: 16,
  md: 24,
  lg: 32,
  xl: 48,
}

const strokeWidthMap = {
  xs: 2,
  sm: 2.5,
  md: 3,
  lg: 3.5,
  xl: 4,
}

/**
 * 统一的加载指示器组件
 * 支持多种尺寸和自定义颜色
 */
export function LoadingSpinner({ 
  size = 'md', 
  color,
  className,
  style,
}: LoadingSpinnerProps) {
  const dimension = sizeMap[size]
  const strokeWidth = strokeWidthMap[size]
  const radius = (dimension - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius

  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox={`0 0 ${dimension} ${dimension}`}
      fill="none"
      role="status"
      aria-label="Loading"
      className={className}
      style={{
        animation: 'spinner-rotate 1s linear infinite',
        ...style,
      }}
    >
      {/* 背景圆 */}
      <circle
        cx={dimension / 2}
        cy={dimension / 2}
        r={radius}
        stroke={color || tokens.colors.border.primary}
        strokeWidth={strokeWidth}
        opacity={0.25}
      />
      {/* 旋转的弧 */}
      <circle
        cx={dimension / 2}
        cy={dimension / 2}
        r={radius}
        stroke={color || tokens.colors.accent.primary}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * 0.75}
        style={{
          transformOrigin: 'center',
        }}
      />
      <style>{`
        @keyframes spinner-rotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </svg>
  )
}

/**
 * 全屏加载状态
 */
export function FullPageSpinner({ message }: { message?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 400,
        gap: tokens.spacing[4],
      }}
    >
      <LoadingSpinner size="xl" />
      {message && (
        <p style={{
          color: tokens.colors.text.secondary,
          fontSize: tokens.typography.fontSize.sm,
        }}>
          {message}
        </p>
      )}
    </div>
  )
}

/**
 * 按钮内置加载指示器
 */
export function ButtonSpinner({ size = 'sm' }: { size?: 'xs' | 'sm' | 'md' }) {
  return <LoadingSpinner size={size} color="currentColor" />
}

/**
 * 骨架屏加载
 */
export function SkeletonLoader({ 
  width = '100%', 
  height = 20,
  borderRadius = 8,
}: { 
  width?: string | number
  height?: string | number
  borderRadius?: number
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius,
        background: tokens.colors.bg.secondary,
        position: 'relative' as const,
        overflow: 'hidden',
      }}
      className="skeleton"
    >
    </div>
  )
}

/**
 * 列表项骨架屏
 */
export function ListItemSkeleton() {
  return (
    <div
      style={{
        display: 'flex',
        gap: tokens.spacing[3],
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <SkeletonLoader width={48} height={48} borderRadius={12} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        <SkeletonLoader width="60%" height={16} />
        <SkeletonLoader width="90%" height={14} />
        <SkeletonLoader width="40%" height={12} />
      </div>
    </div>
  )
}

/**
 * 卡片骨架屏
 */
export function CardSkeleton() {
  return (
    <div
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[3],
      }}
    >
      <SkeletonLoader width="70%" height={20} />
      <SkeletonLoader width="100%" height={60} />
      <div style={{ display: 'flex', gap: tokens.spacing[2] }}>
        <SkeletonLoader width={80} height={28} borderRadius={14} />
        <SkeletonLoader width={80} height={28} borderRadius={14} />
        <SkeletonLoader width={80} height={28} borderRadius={14} />
      </div>
    </div>
  )
}

export default LoadingSpinner
