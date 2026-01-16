'use client'

import React, { Component, ReactNode } from 'react'
import * as Sentry from '@sentry/nextjs'
import { Box, Text, Button } from '../Base'
import { tokens } from '@/lib/design-tokens'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  /** 错误上下文信息 */
  context?: string
}

interface State {
  hasError: boolean
  error: Error | null
  eventId: string | null
}

/**
 * 错误边界组件
 * 捕获子组件的错误并显示友好的错误信息
 * 同时上报错误到 Sentry
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, eventId: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] 捕获到错误:', error, errorInfo)
    
    // 上报错误到 Sentry
    const eventId = Sentry.captureException(error, {
      tags: {
        errorBoundary: true,
        context: this.props.context || 'unknown',
      },
      extra: {
        componentStack: errorInfo.componentStack,
      },
    })
    
    this.setState({ eventId })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <Box
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: tokens.spacing[4],
            background: tokens.colors.bg.primary,
          }}
        >
          <Box
            bg="secondary"
            p={6}
            radius="xl"
            border="primary"
            style={{
              maxWidth: 600,
              textAlign: 'center',
              background: `rgba(255, 68, 68, 0.1)`,
              borderColor: `rgba(255, 68, 68, 0.3)`,
            }}
          >
            <Text size="xl" weight="black" style={{ color: tokens.colors.accent.error, marginBottom: tokens.spacing[3] }}>
              出错了
            </Text>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {this.state.error?.message || '发生了未知错误'}
            </Text>
            <Button variant="primary" onClick={this.handleReset}>
              刷新页面
            </Button>
          </Box>
        </Box>
      )
    }

    return this.props.children
  }
}

