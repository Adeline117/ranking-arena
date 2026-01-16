'use client'

/**
 * 错误边界组件
 * 捕获子组件的 JavaScript 错误，提供优雅的降级 UI
 */

import React, { Component, ReactNode, ErrorInfo } from 'react'
import * as Sentry from '@sentry/nextjs'
import { Box, Text, Button } from '../Base'
import { tokens } from '@/lib/design-tokens'

// ============================================
// 类型定义
// ============================================

interface ErrorBoundaryProps {
  /** 子组件 */
  children: ReactNode
  /** 自定义错误 UI */
  fallback?: ReactNode | ((error: Error, resetError: () => void) => ReactNode)
  /** 错误回调 */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  /** 是否上报到 Sentry */
  reportToSentry?: boolean
  /** 错误边界名称（用于追踪） */
  name?: string
  /** 是否显示详细错误信息（开发模式） */
  showDetails?: boolean
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

// ============================================
// 错误边界组件
// ============================================

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static defaultProps = {
    reportToSentry: true,
    showDetails: process.env.NODE_ENV === 'development',
  }

  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo })

    // 调用错误回调
    this.props.onError?.(error, errorInfo)

    // 上报到 Sentry
    if (this.props.reportToSentry) {
      Sentry.withScope((scope) => {
        scope.setTag('errorBoundary', this.props.name || 'unknown')
        scope.setExtra('componentStack', errorInfo.componentStack)
        Sentry.captureException(error)
      })
    }

    // 开发模式下输出到控制台
    if (process.env.NODE_ENV === 'development') {
      console.error('[ErrorBoundary] 捕获到错误:', error)
      console.error('[ErrorBoundary] 组件栈:', errorInfo.componentStack)
    }
  }

  resetError = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    })
  }

  render() {
    const { hasError, error, errorInfo } = this.state
    const { children, fallback, showDetails } = this.props

    if (hasError && error) {
      // 自定义 fallback
      if (fallback) {
        if (typeof fallback === 'function') {
          return fallback(error, this.resetError)
        }
        return fallback
      }

      // 默认错误 UI
      return (
        <DefaultErrorFallback
          error={error}
          errorInfo={errorInfo}
          onReset={this.resetError}
          showDetails={showDetails}
        />
      )
    }

    return children
  }
}

// ============================================
// 默认错误 UI
// ============================================

interface DefaultErrorFallbackProps {
  error: Error
  errorInfo: ErrorInfo | null
  onReset: () => void
  showDetails?: boolean
}

function DefaultErrorFallback({
  error,
  errorInfo,
  onReset,
  showDetails,
}: DefaultErrorFallbackProps) {
  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.spacing[8],
        minHeight: '200px',
        backgroundColor: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        gap: tokens.spacing[4],
      }}
      role="alert"
      aria-live="assertive"
    >
      {/* 图标 */}
      <Box
        style={{
          width: '64px',
          height: '64px',
          borderRadius: '50%',
          backgroundColor: 'rgba(255, 82, 82, 0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ff5252"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </Box>

      {/* 标题 */}
      <Text size="lg" weight="bold" style={{ textAlign: 'center' }}>
        出了点问题
      </Text>

      {/* 描述 */}
      <Text size="sm" color="secondary" style={{ textAlign: 'center', maxWidth: '400px' }}>
        页面加载时遇到了一些问题。您可以尝试刷新页面或返回首页。
      </Text>

      {/* 操作按钮 */}
      <Box style={{ display: 'flex', gap: tokens.spacing[3], marginTop: tokens.spacing[2] }}>
        <Button variant="primary" size="md" onClick={onReset}>
          重试
        </Button>
        <Button
          variant="secondary"
          size="md"
          onClick={() => (window.location.href = '/')}
        >
          返回首页
        </Button>
      </Box>

      {/* 详细错误信息（开发模式） */}
      {showDetails && (
        <Box
          style={{
            marginTop: tokens.spacing[4],
            padding: tokens.spacing[4],
            backgroundColor: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.md,
            width: '100%',
            maxWidth: '600px',
            overflow: 'auto',
          }}
        >
          <Text size="sm" weight="bold" style={{ color: '#ff5252', marginBottom: tokens.spacing[2] }}>
            错误详情（仅开发模式可见）
          </Text>
          <pre
            style={{
              fontSize: '12px',
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              color: tokens.colors.text.secondary,
            }}
          >
            {error.message}
            {errorInfo?.componentStack && (
              <>
                {'\n\n组件栈:\n'}
                {errorInfo.componentStack}
              </>
            )}
          </pre>
        </Box>
      )}

      {/* 错误 ID（用于支持） */}
      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
        错误 ID: {generateErrorId()}
      </Text>
    </Box>
  )
}

// ============================================
// 预设错误边界
// ============================================

/**
 * 页面级错误边界
 */
export function PageErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      name="PageErrorBoundary"
      fallback={(error, resetError) => (
        <Box
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: tokens.spacing[4],
          }}
        >
          <DefaultErrorFallback
            error={error}
            errorInfo={null}
            onReset={resetError}
            showDetails={process.env.NODE_ENV === 'development'}
          />
        </Box>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

/**
 * 组件级错误边界（静默降级）
 */
export function SilentErrorBoundary({
  children,
  fallback = null,
}: {
  children: ReactNode
  fallback?: ReactNode
}) {
  return (
    <ErrorBoundary
      name="SilentErrorBoundary"
      fallback={fallback}
      showDetails={false}
    >
      {children}
    </ErrorBoundary>
  )
}

/**
 * 卡片错误边界
 */
export function CardErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      name="CardErrorBoundary"
      fallback={
        <Box
          style={{
            padding: tokens.spacing[4],
            backgroundColor: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            textAlign: 'center',
          }}
        >
          <Text size="sm" color="secondary">
            加载失败
          </Text>
        </Box>
      }
    >
      {children}
    </ErrorBoundary>
  )
}

// ============================================
// 工具函数
// ============================================

/**
 * 生成错误 ID
 */
function generateErrorId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 8)
  return `ERR-${timestamp}-${random}`.toUpperCase()
}

/**
 * 错误边界 HOC
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  options: Omit<ErrorBoundaryProps, 'children'> = {}
): React.FC<P> {
  const WrappedComponent: React.FC<P> = (props) => (
    <ErrorBoundary {...options}>
      <Component {...props} />
    </ErrorBoundary>
  )

  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name || 'Component'})`

  return WrappedComponent
}

// ============================================
// 导出
// ============================================

export type { ErrorBoundaryProps, ErrorBoundaryState }
