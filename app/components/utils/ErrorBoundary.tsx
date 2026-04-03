'use client'

import React, { Component, ReactNode } from 'react'
import Link from 'next/link'
import { t } from '@/lib/i18n'
import { tokens } from '@/lib/design-tokens'
import { logger } from '@/lib/logger'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  /** 错误发生时的回调 */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  /** 是否显示错误详情（默认只在开发环境显示） */
  showDetails?: boolean
  /** 错误边界的级别 */
  level?: 'page' | 'section' | 'component'
  /** 页面类型标识（用于 Sentry 标签等） */
  pageType?: string
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
  showStack: boolean
  retryCount: number
}

/** Max auto-retries before showing error UI (Sentry recovery pattern) */
const MAX_AUTO_RETRIES = 1

/**
 * 全局错误边界组件
 * 捕获子组件树中的 JavaScript 错误，记录错误并显示降级 UI
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showStack: false,
      retryCount: 0,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // 更新 state 使下一次渲染能够显示降级后的 UI
    return {
      hasError: true,
      error,
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('ErrorBoundary 捕获到错误:', { errorInfo }, error)

    this.setState({
      error,
      errorInfo,
    })

    // Auto-retry once for transient errors (network, 5xx). Skip for 4xx (won't help).
    const status = (error as { status?: number })?.status
    const isRetryable = !status || status >= 500 || status === 429
    if (isRetryable && this.state.retryCount < MAX_AUTO_RETRIES) {
      logger.info(`ErrorBoundary: auto-retry ${this.state.retryCount + 1}/${MAX_AUTO_RETRIES}`)
      setTimeout(() => this.handleReset(), 500)
      return
    }

    // 调用自定义错误处理回调
    this.props.onError?.(error, errorInfo)

    // 将错误上报到 Sentry
    if (process.env.NODE_ENV === 'production') {
      import('@sentry/nextjs').then((Sentry) => {
        Sentry.captureException(error, {
          contexts: {
            react: { componentStack: errorInfo.componentStack || '' },
          },
          tags: { errorBoundary: true },
        })
      }).catch(() => { // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
        // Sentry 加载失败时静默降级
      })
    }
  }

  handleReset = () => {
    this.setState(prev => ({
      hasError: false,
      error: null,
      errorInfo: null,
      showStack: false,
      retryCount: prev.retryCount + 1,
    }))
  }

  toggleStack = () => {
    this.setState(prev => ({ showStack: !prev.showStack }))
  }

  render() {
    if (this.state.hasError) {
      // 如果提供了自定义 fallback，使用它
      if (this.props.fallback) {
        return this.props.fallback
      }

      const isDev = process.env.NODE_ENV === 'development'
      const showDetails = this.props.showDetails ?? isDev

      // 默认错误 UI
      return (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            minHeight: this.props.level === 'page' ? '100vh' : this.props.level === 'section' ? '300px' : '100px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            color: 'var(--color-text-primary, #EDEDED)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            background: this.props.level === 'page'
              ? 'var(--color-bg-primary, #0a0a0f)'
              : 'transparent',
          }}
        >
          <div style={{ textAlign: 'center', maxWidth: 500 }}>
            <div
              style={{
                width: this.props.level === 'component' ? 48 : 80,
                height: this.props.level === 'component' ? 48 : 80,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--color-accent-error-15) 0%, var(--color-accent-error-08) 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 24px',
              }}
            >
              <svg
                width={this.props.level === 'component' ? 24 : 40}
                height={this.props.level === 'component' ? 24 : 40}
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-accent-error)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>

            <h1
              style={{
                fontSize: this.props.level === 'component' ? 18 : 28,
                fontWeight: 700,
                marginBottom: 12,
                background: 'linear-gradient(135deg, var(--color-text-primary, #EDEDED) 0%, var(--color-brand) 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              {t('errorTitle')}
            </h1>

            <p style={{ opacity: 0.7, marginBottom: 8, fontSize: 16, lineHeight: 1.6 }}>
              {t('errorMessage')}
            </p>
            <p style={{ opacity: 0.5, fontSize: 14, marginBottom: 24 }}>
              {t('errorRefresh')}
            </p>

            {showDetails && this.state.error && (
              <details
                open={this.state.showStack}
                style={{
                  marginBottom: 24,
                  padding: 16,
                  background: 'var(--color-accent-error-10)',
                  borderRadius: tokens.radius.md,
                  border: '1px solid var(--color-accent-error-20)',
                  textAlign: 'left',
                  fontSize: 12,
                  fontFamily: 'monospace',
                }}
              >
                <summary
                  onClick={(e) => { e.preventDefault(); this.toggleStack(); }}
                  style={{ cursor: 'pointer', marginBottom: 8, color: 'var(--color-accent-error)' }}
                >
                  {t('errorDetails')} {this.state.showStack ? '▲' : '▼'}
                </summary>
                {this.state.showStack && (
                  <pre
                    style={{
                      overflow: 'auto',
                      color: 'var(--color-accent-error)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 200,
                    }}
                  >
                    {this.state.error.toString()}
                    {this.state.errorInfo?.componentStack}
                  </pre>
                )}
              </details>
            )}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={this.handleReset}
                aria-label={t('retryLoad')}
                style={{
                  padding: '12px 24px',
                  background: 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
                  color: tokens.colors.white,
                  borderRadius: tokens.radius.md,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
                {t('retryButton')}
              </button>

              <Link
                href="/"
                aria-label={t('backToHome')}
                style={{
                  padding: '12px 24px',
                  background: 'transparent',
                  color: 'var(--color-text-primary, #EDEDED)',
                  borderRadius: tokens.radius.md,
                  border: '1px solid var(--glass-border-medium, var(--glass-border-medium))',
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                  <polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
                {t('backToHome')}
              </Link>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

/**
 * 页面级错误边界 - 全屏样式
 */
export function PageErrorBoundary({
  children,
  onError
}: {
  children: ReactNode
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
}) {
  return (
    <ErrorBoundary level="page" onError={onError}>
      {children}
    </ErrorBoundary>
  )
}

/**
 * 区块级错误边界 - 中等大小
 */
export function SectionErrorBoundary({
  children,
  fallbackMessage
}: {
  children: ReactNode
  fallbackMessage?: string
}) {
  return (
    <ErrorBoundary
      level="section"
      fallback={
        <div
          role="alert"
          style={{
            minHeight: 200,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: 'var(--color-accent-error-08)',
            borderRadius: tokens.radius.lg,
            border: '1px solid var(--color-accent-error-10)',
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-accent-error)"
            strokeWidth="2"
            style={{ marginBottom: 12, opacity: 0.8 }}
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>{fallbackMessage || t('sectionLoadFailed')}</p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 12,
              padding: '8px 16px',
              background: 'var(--color-accent-primary-20)',
              color: 'var(--color-brand)',
              borderRadius: tokens.radius.sm,
              border: '1px solid var(--color-accent-primary-30)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {t('refreshPage')}
          </button>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  )
}

/**
 * 组件级错误边界 - 紧凑样式
 */
export function CompactErrorBoundary({
  children,
  message,
  onRetry
}: {
  children: ReactNode
  message?: string
  onRetry?: () => void
}) {
  return (
    <ErrorBoundary
      level="component"
      fallback={
        <div
          role="alert"
          style={{
            padding: '12px 16px',
            background: 'var(--color-accent-error-08)',
            borderRadius: tokens.radius.md,
            border: '1px solid var(--color-accent-error-15)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-accent-error)"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span style={{ color: 'var(--color-text-secondary)', fontSize: 13, flex: 1 }}>{message || t('loadFailed')}</span>
          <button
            onClick={onRetry || (() => window.location.reload())}
            style={{
              padding: '4px 10px',
              background: 'transparent',
              color: 'var(--color-brand)',
              borderRadius: tokens.radius.sm,
              border: '1px solid var(--color-accent-primary-30)',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {t('retryButton')}
          </button>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  )
}

/**
 * 错误边界 HOC
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  options?: {
    fallback?: ReactNode
    level?: 'page' | 'section' | 'component'
    onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  }
) {
  return function WithErrorBoundaryComponent(props: P) {
    return (
      <ErrorBoundary
        fallback={options?.fallback}
        level={options?.level}
        onError={options?.onError}
      >
        <Component {...props} />
      </ErrorBoundary>
    )
  }
}

export default ErrorBoundary
