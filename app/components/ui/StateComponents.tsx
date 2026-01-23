'use client'

import React, { ReactNode } from 'react'
import { RefreshCw, AlertCircle, AlertTriangle, Search, Inbox, WifiOff, Clock, Lock } from 'lucide-react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { t } from '@/lib/i18n'

// ============================================
// 类型定义
// ============================================

type Size = 'sm' | 'md' | 'lg'
type Variant = 'default' | 'compact' | 'card' | 'inline'

interface BaseStateProps {
  /** 标题 */
  title: string
  /** 描述文本 */
  description?: string
  /** 自定义图标 */
  icon?: ReactNode
  /** 操作按钮 */
  action?: ReactNode
  /** 尺寸 */
  size?: Size
  /** 变体样式 */
  variant?: Variant
  /** 额外的 className */
  className?: string
}

// ============================================
// 基础状态容器
// ============================================

function StateContainer({
  children,
  size = 'md',
  variant = 'default',
  className,
}: {
  children: ReactNode
  size?: Size
  variant?: Variant
  className?: string
}) {
  const isCard = variant === 'card'
  const isInline = variant === 'inline'
  const isCompact = variant === 'compact' || size === 'sm'

  const padding = isInline
    ? `${tokens.spacing[3]} ${tokens.spacing[4]}`
    : isCompact
      ? `${tokens.spacing[8]} ${tokens.spacing[4]}`
      : `${tokens.spacing[16]} ${tokens.spacing[6]}`

  return (
    <Box
      className={className}
      role="status"
      style={{
        padding,
        textAlign: isInline ? 'left' : 'center',
        borderRadius: isCard ? tokens.radius.xl : tokens.radius.lg,
        background: isCard ? tokens.glass.bg.light : isInline ? tokens.colors.bg.secondary : 'transparent',
        border: isCard || isInline ? `1px solid ${tokens.colors.border.primary}` : undefined,
        display: isInline ? 'flex' : 'block',
        alignItems: isInline ? 'center' : undefined,
        gap: isInline ? tokens.spacing[3] : undefined,
      }}
    >
      {children}
    </Box>
  )
}

// ============================================
// 图标容器
// ============================================

function IconContainer({
  icon,
  color,
  size = 'md',
  variant = 'default',
}: {
  icon: ReactNode
  color: string
  size?: Size
  variant?: Variant
}) {
  const isInline = variant === 'inline'
  const sizes = {
    sm: { container: 40, icon: 18 },
    md: { container: 56, icon: 24 },
    lg: { container: 72, icon: 32 },
  }
  const s = sizes[size]

  if (isInline) {
    return (
      <Box
        style={{
          width: s.container,
          height: s.container,
          borderRadius: tokens.radius.lg,
          background: `${color}15`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Box style={{ color, width: s.icon, height: s.icon }}>
          {icon}
        </Box>
      </Box>
    )
  }

  return (
    <Box
      style={{
        marginBottom: tokens.spacing[4],
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <Box
        style={{
          width: s.container,
          height: s.container,
          borderRadius: tokens.radius.full,
          background: `${color}15`,
          border: `1px solid ${color}30`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Box style={{ color, width: s.icon, height: s.icon }}>
          {icon}
        </Box>
      </Box>
    </Box>
  )
}

// ============================================
// 加载状态
// ============================================

interface LoadingStateProps extends Omit<BaseStateProps, 'icon'> {
  /** 是否显示旋转动画 */
  spinning?: boolean
}

export function LoadingState({
  title,
  description,
  action,
  size = 'md',
  variant = 'default',
  spinning = true,
  className,
}: LoadingStateProps) {
  const displayTitle = title || t('loadingShort')
  const color = tokens.colors.accent.primary

  return (
    <StateContainer size={size} variant={variant} className={className}>
      <IconContainer
        icon={
          <RefreshCw
            style={{
              animation: spinning ? 'spin 1s linear infinite' : undefined,
            }}
          />
        }
        color={color}
        size={size}
        variant={variant}
      />
      <Box style={{ flex: variant === 'inline' ? 1 : undefined }}>
        <Text
          size={size === 'sm' ? 'sm' : 'md'}
          weight="bold"
          color="primary"
          style={{ marginBottom: description ? tokens.spacing[1] : 0 }}
        >
          {displayTitle}
        </Text>
        {description && (
          <Text size={size === 'sm' ? 'xs' : 'sm'} color="tertiary">
            {description}
          </Text>
        )}
      </Box>
      {action && <Box style={{ marginTop: variant === 'inline' ? 0 : tokens.spacing[4] }}>{action}</Box>}
    </StateContainer>
  )
}

// ============================================
// 空状态
// ============================================

type EmptyType = 'default' | 'search' | 'inbox' | 'filter'

interface EmptyStateProps extends BaseStateProps {
  /** 空状态类型 */
  type?: EmptyType
}

const EMPTY_ICONS: Record<EmptyType, ReactNode> = {
  default: <Inbox />,
  search: <Search />,
  inbox: <Inbox />,
  filter: <Search />,
}

const getEmptyTitle = (type: EmptyType): string => {
  const titles: Record<EmptyType, string> = {
    default: t('noData'),
    search: t('noResults'),
    inbox: t('inboxEmpty'),
    filter: t('noMatchingResults'),
  }
  return titles[type]
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  size = 'md',
  variant = 'default',
  type = 'default',
  className,
}: EmptyStateProps) {
  const color = tokens.colors.text.tertiary

  return (
    <StateContainer size={size} variant={variant} className={className}>
      <IconContainer
        icon={icon || EMPTY_ICONS[type]}
        color={color}
        size={size}
        variant={variant}
      />
      <Box style={{ flex: variant === 'inline' ? 1 : undefined }}>
        <Text
          size={size === 'sm' ? 'sm' : 'md'}
          weight="bold"
          color="primary"
          style={{ marginBottom: description ? tokens.spacing[1] : 0 }}
        >
          {title || getEmptyTitle(type)}
        </Text>
        {description && (
          <Text
            size={size === 'sm' ? 'xs' : 'sm'}
            color="tertiary"
            style={{ maxWidth: 320, margin: '0 auto', lineHeight: 1.6 }}
          >
            {description}
          </Text>
        )}
      </Box>
      {action && <Box style={{ marginTop: variant === 'inline' ? 0 : tokens.spacing[4] }}>{action}</Box>}
    </StateContainer>
  )
}

// ============================================
// 错误状态
// ============================================

type ErrorType = 'default' | 'network' | 'server' | 'notFound' | 'forbidden' | 'timeout'

interface ErrorStateProps extends BaseStateProps {
  /** 错误类型 */
  type?: ErrorType
  /** 重试回调 */
  onRetry?: () => void
  /** 错误详情（开发环境显示） */
  errorDetails?: string
}

const ERROR_ICONS: Record<ErrorType, ReactNode> = {
  default: <AlertCircle />,
  network: <WifiOff />,
  server: <AlertTriangle />,
  notFound: <Search />,
  forbidden: <Lock />,
  timeout: <Clock />,
}

const getErrorTitle = (type: ErrorType): string => {
  const titles: Record<ErrorType, string> = {
    default: t('errorOccurred'),
    network: t('networkError'),
    server: t('serverError'),
    notFound: t('notFound'),
    forbidden: t('noPermission'),
    timeout: t('requestTimeout'),
  }
  return titles[type]
}

const getErrorDescription = (type: ErrorType): string => {
  const descriptions: Record<ErrorType, string> = {
    default: t('unknownErrorOccurred'),
    network: t('checkNetworkAndRetry'),
    server: t('serverUnavailable'),
    notFound: t('resourceNotFound'),
    forbidden: t('noAccessPermission'),
    timeout: t('requestTimeoutRetry'),
  }
  return descriptions[type]
}

export function ErrorState({
  title,
  description,
  icon,
  action,
  size = 'md',
  variant = 'default',
  type = 'default',
  onRetry,
  errorDetails,
  className,
}: ErrorStateProps) {
  const color = tokens.colors.accent?.error || '#ff7c7c'
  const isDev = process.env.NODE_ENV === 'development'

  return (
    <StateContainer size={size} variant={variant} className={className}>
      <IconContainer
        icon={icon || ERROR_ICONS[type]}
        color={color}
        size={size}
        variant={variant}
      />
      <Box style={{ flex: variant === 'inline' ? 1 : undefined }}>
        <Text
          size={size === 'sm' ? 'sm' : 'md'}
          weight="bold"
          color="primary"
          style={{ marginBottom: description ? tokens.spacing[1] : 0 }}
        >
          {title || getErrorTitle(type)}
        </Text>
        <Text
          size={size === 'sm' ? 'xs' : 'sm'}
          color="tertiary"
          style={{ maxWidth: 320, margin: '0 auto', lineHeight: 1.6 }}
        >
          {description || getErrorDescription(type)}
        </Text>

        {/* 开发环境显示错误详情 */}
        {isDev && errorDetails && (
          <Box
            style={{
              marginTop: tokens.spacing[3],
              padding: tokens.spacing[3],
              background: `${color}10`,
              borderRadius: tokens.radius.md,
              fontSize: 11,
              fontFamily: 'monospace',
              color: color,
              textAlign: 'left',
              maxHeight: 100,
              overflow: 'auto',
            }}
          >
            {errorDetails}
          </Box>
        )}
      </Box>

      <Box style={{ marginTop: variant === 'inline' ? 0 : tokens.spacing[4], display: 'flex', gap: tokens.spacing[2], justifyContent: 'center' }}>
        {onRetry && (
          <Button
            variant="primary"
            size={size === 'sm' ? 'sm' : 'md'}
            onClick={onRetry}
            style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}
          >
            <RefreshCw size={16} />
            {t('retry')}
          </Button>
        )}
        {action}
      </Box>
    </StateContainer>
  )
}

// ============================================
// 骨架屏加载器
// ============================================

interface SkeletonProps {
  /** 宽度 */
  width?: number | string
  /** 高度 */
  height?: number | string
  /** 圆角 */
  borderRadius?: number | string
  /** 是否为圆形 */
  circle?: boolean
  /** 行数（用于文本骨架） */
  lines?: number
  /** 自定义类名 */
  className?: string
}

export function Skeleton({
  width = '100%',
  height = 16,
  borderRadius = 4,
  circle = false,
  lines,
  className,
}: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <Box className={className} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Array.from({ length: lines }).map((_, i) => (
          <Box
            key={i}
            className="skeleton"
            style={{
              width: i === lines - 1 ? '60%' : '100%',
              height,
              borderRadius,
              backgroundImage: 'linear-gradient(90deg, var(--color-bg-tertiary) 0%, var(--color-bg-hover) 50%, var(--color-bg-tertiary) 100%)',
              backgroundSize: '200% 100%',
            }}
          />
        ))}
      </Box>
    )
  }

  return (
    <Box
      className={`skeleton ${className || ''}`}
      style={{
        width: circle ? height : width,
        height,
        borderRadius: circle ? '50%' : borderRadius,
        backgroundImage: 'linear-gradient(90deg, var(--color-bg-tertiary) 0%, var(--color-bg-hover) 50%, var(--color-bg-tertiary) 100%)',
        backgroundSize: '200% 100%',
      }}
    />
  )
}

// ============================================
// 卡片骨架屏
// ============================================

export function CardSkeleton({ count = 1 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Box
          key={i}
          style={{
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[3] }}>
            <Skeleton circle height={40} />
            <Box style={{ flex: 1 }}>
              <Skeleton width="60%" height={14} />
              <Box style={{ height: 4 }} />
              <Skeleton width="40%" height={12} />
            </Box>
          </Box>
          <Skeleton lines={2} />
        </Box>
      ))}
    </>
  )
}

// ============================================
// 表格行骨架屏
// ============================================

export function TableRowSkeleton({ columns = 5, rows = 5 }: { columns?: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <Box
          key={rowIndex}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[4],
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          {Array.from({ length: columns }).map((_, colIndex) => (
            <Box key={colIndex} style={{ flex: colIndex === 0 ? 2 : 1 }}>
              <Skeleton height={colIndex === 0 ? 16 : 14} width={colIndex === 0 ? '70%' : '50%'} />
            </Box>
          ))}
        </Box>
      ))}
    </>
  )
}

// ============================================
// 导出
// ============================================

export default {
  LoadingState,
  EmptyState,
  ErrorState,
  Skeleton,
  CardSkeleton,
  TableRowSkeleton,
}
