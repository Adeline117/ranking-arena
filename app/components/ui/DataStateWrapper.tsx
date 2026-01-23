'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface DataStateWrapperProps {
  isLoading: boolean
  error: Error | string | null | undefined
  isEmpty: boolean
  children: React.ReactNode
  loadingComponent?: React.ReactNode
  emptyMessage?: string
  onRetry?: () => void
}

/**
 * Wraps content with proper loading/error/empty states.
 * Ensures no "click with no response" or infinite loading.
 */
export default function DataStateWrapper({
  isLoading,
  error,
  isEmpty,
  children,
  loadingComponent,
  emptyMessage,
  onRetry,
}: DataStateWrapperProps) {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  if (isLoading) {
    if (loadingComponent) return <>{loadingComponent}</>
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin h-8 w-8" style={{ color: tokens.colors.text.tertiary }} viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm" style={{ color: tokens.colors.text.tertiary }}>
            {isZh ? '加载中...' : 'Loading...'}
          </span>
        </div>
      </div>
    )
  }

  if (error) {
    const errorMsg = typeof error === 'string' ? error : error.message
    return (
      <div className="flex items-center justify-center py-12">
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
            {errorMsg || (isZh ? '加载失败' : 'Failed to load')}
          </p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                backgroundColor: tokens.colors.accent.brand + '15',
                color: tokens.colors.accent.brand,
              }}
            >
              {isZh ? '重试' : 'Retry'}
            </button>
          )}
        </div>
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className="flex items-center justify-center py-12">
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
            {emptyMessage || (isZh ? '暂无数据' : 'No data available')}
          </p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
