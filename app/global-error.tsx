'use client'

/**
 * 全局错误处理页面
 * 捕获整个应用的未处理错误并上报到 Sentry
 */

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // 上报错误到 Sentry
    Sentry.captureException(error, {
      tags: {
        errorType: 'global',
        digest: error.digest,
      },
    })
  }, [error])

  return (
    <html>
      <body>
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            backgroundColor: '#0B0A10',
            color: '#EDEDED',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          }}
        >
          <div
            style={{
              maxWidth: '500px',
              textAlign: 'center',
              padding: '2rem',
              borderRadius: '12px',
              backgroundColor: '#14121C',
              border: '1px solid #2A2836',
            }}
          >
            <h1
              style={{
                fontSize: '1.5rem',
                fontWeight: 'bold',
                color: '#ff7c7c',
                marginBottom: '1rem',
              }}
            >
              出错了
            </h1>
            <p
              style={{
                fontSize: '0.875rem',
                color: '#A8A8B3',
                marginBottom: '1.5rem',
                lineHeight: 1.6,
              }}
            >
              应用发生了意外错误。我们已经收到错误报告，正在处理中。
            </p>
            {error.digest && (
              <p
                style={{
                  fontSize: '0.75rem',
                  color: '#6B6B7B',
                  marginBottom: '1.5rem',
                  fontFamily: 'monospace',
                }}
              >
                错误 ID: {error.digest}
              </p>
            )}
            <button
              onClick={reset}
              style={{
                padding: '0.75rem 1.5rem',
                fontSize: '0.875rem',
                fontWeight: '500',
                color: '#EDEDED',
                backgroundColor: '#8b6fa8',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'background-color 0.2s',
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.backgroundColor = '#9d84b5'
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.backgroundColor = '#8b6fa8'
              }}
            >
              重试
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
