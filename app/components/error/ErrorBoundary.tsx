'use client'

/**
 * 统一的错误边界组件
 * 为关键页面提供错误捕获和友好的错误展示
 */

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ComponentType<ErrorBoundaryFallbackProps>
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  // 为不同页面类型提供自定义错误信息
  pageType?: 'rankings' | 'trader' | 'library' | 'market' | 'profile' | 'general'
}

export interface ErrorBoundaryFallbackProps {
  error: Error | null
  pageType?: string
  onRetry?: () => void
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
      errorInfo: null,
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({
      hasError: true,
      error,
      errorInfo,
    })

    // 自定义错误处理回调
    if (this.props.onError) {
      this.props.onError(error, errorInfo)
    }

    // 上报到 Sentry（如果有的话）
    if (typeof window !== 'undefined') {
      import('@sentry/nextjs').then((Sentry) => {
        Sentry.captureException(error, {
          tags: {
            errorBoundary: true,
            pageType: this.props.pageType || 'unknown',
          },
          contexts: {
            react: {
              componentStack: errorInfo.componentStack,
            },
          },
        })
      }).catch(() => {
        // Sentry 加载失败时静默处理
        console.error('ErrorBoundary:', error, errorInfo)
      })
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
  }

  render() {
    if (this.state.hasError) {
      const FallbackComponent = this.props.fallback || DefaultErrorFallback
      return (
        <FallbackComponent
          error={this.state.error}
          pageType={this.props.pageType}
          onRetry={this.handleRetry}
        />
      )
    }

    return this.props.children
  }
}

// 默认错误展示组件
function DefaultErrorFallback({ error, pageType, onRetry }: ErrorBoundaryFallbackProps) {
  const getErrorMessage = () => {
    switch (pageType) {
      case 'rankings':
        return t('errorRanking')
      case 'trader':
        return t('errorTraderPage')
      case 'library':
        return t('errorLibraryPage')
      case 'market':
        return t('errorMarketPage')
      case 'profile':
        return t('errorUserPage')
      default:
        return t('errorMessage')
    }
  }

  const getErrorTitle = () => {
    switch (pageType) {
      case 'rankings':
        return t('errorRankingTitle')
      case 'trader':
        return t('errorTraderPageTitle')
      case 'library':
        return t('errorLibraryPageTitle')
      case 'market':
        return t('errorMarketPageTitle')
      case 'profile':
        return t('errorProfilePageTitle')
      default:
        return t('errorTitle')
    }
  }

  return (
    <div
      style={{
        minHeight: '50vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.spacing[6],
        textAlign: 'center',
      }}
    >
      <div
        style={{
          maxWidth: '420px',
          padding: tokens.spacing[8],
          background: tokens.glass.bg.medium,
          backdropFilter: tokens.glass.blur.lg,
          WebkitBackdropFilter: tokens.glass.blur.lg,
          border: tokens.glass.border.medium,
          borderRadius: tokens.radius['2xl'],
          boxShadow: tokens.shadow.lg,
        }}
      >
        {/* 错误图标 */}
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: tokens.radius.full,
            background: tokens.gradient.errorSubtle,
            border: `2px solid ${tokens.colors.accent.error}30`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 24px',
          }}
        >
          <svg 
            width="28" 
            height="28" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke={tokens.colors.accent.error} 
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
        </div>

        {/* 标题 */}
        <h2
          style={{
            fontSize: tokens.typography.fontSize.xl,
            fontWeight: tokens.typography.fontWeight.bold,
            color: tokens.colors.text.primary,
            marginBottom: tokens.spacing[2],
          }}
        >
          {getErrorTitle()}
        </h2>

        {/* 描述 */}
        <p
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.secondary,
            lineHeight: tokens.typography.lineHeight.normal,
            marginBottom: tokens.spacing[6],
          }}
        >
          {getErrorMessage()}
        </p>

        {/* 错误代码（仅开发环境显示） */}
        {process.env.NODE_ENV === 'development' && error && (
          <details
            style={{
              marginBottom: tokens.spacing[6],
              padding: tokens.spacing[4],
              background: tokens.colors.bg.tertiary,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.tertiary,
                marginBottom: tokens.spacing[2],
              }}
            >
              错误详情（开发环境）
            </summary>
            <code
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.secondary,
                whiteSpace: 'pre-wrap',
                fontFamily: tokens.typography.fontFamily.mono.join(', '),
              }}
            >
              {error.message}
              {error.stack && `\n\n${error.stack.slice(0, 1000)}`}
            </code>
          </details>
        )}

        {/* 操作按钮 */}
        <div
          style={{
            display: 'flex',
            gap: tokens.spacing[3],
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={onRetry}
            style={{
              padding: '12px 24px',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: tokens.colors.white,
              background: tokens.gradient.primary,
              border: 'none',
              borderRadius: tokens.radius.lg,
              cursor: 'pointer',
              transition: tokens.transition.base,
              boxShadow: `0 4px 12px ${tokens.colors.accent.primary}40`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)'
              e.currentTarget.style.boxShadow = `0 6px 20px ${tokens.colors.accent.primary}50`
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)'
              e.currentTarget.style.boxShadow = `0 4px 12px ${tokens.colors.accent.primary}40`
            }}
          >
            {t('retry')}
          </button>

          <button
            onClick={() => window.location.href = '/'}
            style={{
              padding: '12px 24px',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.medium,
              color: tokens.colors.text.primary,
              background: 'transparent',
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              cursor: 'pointer',
              transition: tokens.transition.base,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = tokens.colors.accent.brand
              e.currentTarget.style.color = tokens.colors.accent.brand
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = tokens.colors.border.primary
              e.currentTarget.style.color = tokens.colors.text.primary
            }}
          >
            {t('backToHome')}
          </button>
        </div>

        {/* 联系客服提示 */}
        <p
          style={{
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
            marginTop: tokens.spacing[6],
          }}
        >
          {t('errorPersist')}
        </p>
      </div>
    </div>
  )
}

// 高阶组件，包装页面以提供错误边界
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  options?: Omit<ErrorBoundaryProps, 'children'>
) {
  const WrappedComponent = (props: P) => (
    <ErrorBoundary {...options}>
      <Component {...props} />
    </ErrorBoundary>
  )
  
  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name})`
  
  return WrappedComponent
}

export default ErrorBoundary