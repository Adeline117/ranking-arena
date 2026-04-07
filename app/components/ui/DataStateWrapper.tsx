'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getErrorMessage, isRetryableError } from '@/lib/utils/error-handling'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'
import Button from '@/app/components/base/Button'

interface EmptyAction {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary'
}

interface DataStateWrapperProps<T = unknown> {
  // 兼容旧 API
  isLoading?: boolean
  error?: Error | string | null | undefined
  isEmpty?: boolean
  children: React.ReactNode
  loadingComponent?: React.ReactNode
  emptyMessage?: string
  emptyActions?: EmptyAction[]
  onRetry?: () => void
  
  // 新增的增强属性
  loading?: boolean  // 备用的加载状态名
  data?: T
  customIsEmpty?: (data: T) => boolean
  loadingType?: 'card' | 'list' | 'table' | 'trader' | 'ranking' | 'text'
  loadingCount?: number
  showRetry?: boolean
  minHeight?: string | number
  errorComponent?: React.ReactNode
  emptyComponent?: React.ReactNode
}

/**
 * Wraps content with proper loading/error/empty states.
 * Ensures no "click with no response" or infinite loading.
 */
export default function DataStateWrapper({
  // 兼容旧 API
  isLoading: legacyIsLoading,
  error: legacyError,
  isEmpty: legacyIsEmpty,
  children,
  loadingComponent,
  emptyMessage,
  emptyActions,
  onRetry,
  
  // 新增属性
  loading,
  data,
  customIsEmpty,
  loadingType = 'card',
  loadingCount = 3,
  showRetry = true,
  minHeight,
  errorComponent,
  emptyComponent,
}: DataStateWrapperProps) {
  const { t } = useLanguage()
  
  // 兼容旧 API：合并新旧加载状态
  const isLoading = legacyIsLoading ?? loading ?? false
  const error = legacyError
  
  // 计算是否为空状态
  const isEmpty = React.useMemo(() => {
    if (legacyIsEmpty !== undefined) return legacyIsEmpty
    if (customIsEmpty && data !== undefined) return customIsEmpty(data)
    
    // 默认空判断逻辑
    if (data === null || data === undefined) return true
    if (Array.isArray(data)) return data.length === 0
    if (typeof data === 'object') return Object.keys(data).length === 0
    if (typeof data === 'string') return data.trim().length === 0
    
    return false
  }, [legacyIsEmpty, data, customIsEmpty])

  // 容器样式
  const containerStyle: React.CSSProperties = {
    minHeight: typeof minHeight === 'number' ? `${minHeight}px` : minHeight,
  }

  if (isLoading) {
    if (loadingComponent) return <div style={containerStyle}>{loadingComponent}</div>
    
    // 使用新的 LoadingSkeleton 组件
    return (
      <div style={containerStyle}>
        <LoadingSkeleton type={loadingType} count={loadingCount} />
      </div>
    )
  }

  if (error) {
    if (errorComponent) return <div style={containerStyle}>{errorComponent}</div>
    
    const errorMsg = getErrorMessage(error)
    const canRetry = onRetry && showRetry && isRetryableError(error)
    
    return (
      <div style={containerStyle} className="flex items-center justify-center py-12">
        <div className="flex flex-col items-center gap-3 text-center max-w-sm">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center"
            style={{ backgroundColor: `${tokens.colors.accent.error}15` }}
          >
            <svg className="h-6 w-6" style={{ color: tokens.colors.accent.error }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <p className="text-sm" style={{ color: tokens.colors.text.secondary }}>
            {errorMsg}
          </p>
          {canRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  if (isEmpty) {
    if (emptyComponent) return <div style={containerStyle}>{emptyComponent}</div>
    
    return (
      <div style={containerStyle} className="flex items-center justify-center py-12">
        <div className="flex flex-col items-center gap-3 text-center max-w-sm">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center"
            style={{ backgroundColor: tokens.colors.bg.secondary }}
          >
            <svg className="h-6 w-6" style={{ color: tokens.colors.text.tertiary }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
          </div>
          <p className="text-sm" style={{ color: tokens.colors.text.secondary }}>
            {emptyMessage || t('noDataAvailable')}
          </p>
          {emptyActions && emptyActions.length > 0 && (
            <div className="flex gap-2 mt-2">
              {emptyActions.map((action, i) => (
                <Button
                  key={i}
                  onClick={action.onClick}
                  variant={action.variant === 'primary' ? 'primary' : 'secondary'}
                  size="sm"
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return <div style={containerStyle} className="content-appear">{children}</div>
}
