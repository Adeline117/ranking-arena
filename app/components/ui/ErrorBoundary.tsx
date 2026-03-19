'use client'

import { Component, ReactNode } from 'react'
import { logger } from '@/lib/logger'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  /** Optional name for logging context */
  name?: string
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

/**
 * React Error Boundary for client components.
 * Catches rendering errors and displays a fallback UI instead of crashing the page.
 *
 * Usage:
 *   <ErrorBoundary name="rankings">
 *     <ExchangeRankingClient ... />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: undefined }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    logger.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}] Caught render error: ${error.message}`)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h2 style={{ marginBottom: 16 }}>Something went wrong</h2>
          <p style={{ marginBottom: 16, opacity: 0.7 }}>
            An unexpected error occurred while rendering this section.
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: undefined })}
            style={{
              padding: '10px 24px',
              borderRadius: 8,
              border: '1px solid #555',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
