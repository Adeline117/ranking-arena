'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { parseError } from '@/lib/utils/error-messages'

/**
 * 通用错误回退组件
 * 可作为 ErrorBoundary 的 fallback 或独立使用
 *
 * - 中文优先
 * - 开发模式下显示错误详情
 * - 可选重试按钮和返回首页链接
 * - 可选 "反馈问题" 链接
 */
interface ErrorFallbackProps {
  error: Error & { digest?: string }
  reset?: () => void
  /** 错误来源标签，用于日志 */
  contextLabel?: string
  /** 是否显示紧凑布局（嵌入在页面局部） */
  compact?: boolean
  /** 反馈链接地址 */
  feedbackUrl?: string
}

export default function ErrorFallback({
  error,
  reset,
  contextLabel,
  compact = false,
  feedbackUrl,
}: ErrorFallbackProps) {
  const { t } = useLanguage()
  const [showDetails, setShowDetails] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const isDev = process.env.NODE_ENV === 'development'
  const parsed = parseError(error)

  useEffect(() => {
    console.error(`[${contextLabel || 'ErrorFallback'}]`, error)
  }, [error, contextLabel])

  const handleRetry = () => {
    if (!reset) return
    setIsRetrying(true)
    setTimeout(() => reset(), 300)
  }

  const containerStyle: React.CSSProperties = compact
    ? {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: 24,
        textAlign: 'center',
      }
    : {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        padding: 24,
        textAlign: 'center',
      }

  return (
    <div style={containerStyle}>
      {/* 错误图标 */}
      <div
        style={{
          width: compact ? 56 : 72,
          height: compact ? 56 : 72,
          borderRadius: '50%',
          background: 'var(--color-bg-error-subtle, rgba(255, 124, 124, 0.1))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: compact ? 14 : 20,
        }}
      >
        <svg
          width={compact ? 28 : 36}
          height={compact ? 28 : 36}
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-accent-error, #ff7c7c)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>

      {/* 标题 */}
      <h2
        style={{
          fontSize: compact ? 17 : 20,
          fontWeight: 600,
          marginBottom: 8,
          color: 'var(--color-text-primary)',
        }}
      >
        {t('errorTitle') || '出了点问题'}
      </h2>

      {/* 用户友好消息 */}
      <p
        style={{
          color: 'var(--color-text-secondary)',
          marginBottom: 16,
          maxWidth: 400,
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        {parsed.message}
      </p>

      {/* 错误代码 */}
      {error.digest && (
        <p
          style={{
            color: 'var(--color-text-tertiary)',
            fontSize: 12,
            marginBottom: 16,
            fontFamily: '"SF Mono", Consolas, monospace',
            padding: '4px 10px',
            background: 'rgba(255, 124, 124, 0.08)',
            borderRadius: 6,
            border: '1px solid rgba(255, 124, 124, 0.12)',
          }}
        >
          {t('errorCode') || '错误代码'}: {error.digest}
        </p>
      )}

      {/* 开发模式错误详情 */}
      {isDev && (
        <div style={{ marginBottom: 16, maxWidth: 500, width: '100%' }}>
          <button
            onClick={() => setShowDetails(!showDetails)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            {showDetails ? '收起详情' : '展开错误详情（仅开发环境可见）'}
          </button>
          {showDetails && (
            <pre
              style={{
                marginTop: 8,
                padding: 12,
                background: 'var(--color-bg-tertiary, rgba(0,0,0,0.3))',
                borderRadius: 8,
                border: '1px solid var(--color-border-primary)',
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                textAlign: 'left',
                overflow: 'auto',
                maxHeight: 200,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {`类型: ${parsed.type}\n可重试: ${parsed.retryable ? '是' : '否'}\n\n${error.stack || error.message}`}
            </pre>
          )}
        </div>
      )}

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        {reset && (
          <button
            onClick={handleRetry}
            disabled={isRetrying}
            style={{
              padding: '10px 24px',
              background: tokens.colors.accent.brand,
              color: tokens.colors.white,
              border: 'none',
              borderRadius: 8,
              cursor: isRetrying ? 'wait' : 'pointer',
              fontSize: 14,
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              opacity: isRetrying ? 0.7 : 1,
              transition: 'opacity 0.2s',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {isRetrying ? '重试中...' : (t('retry') || '重试')}
          </button>
        )}
        <Link
          href="/"
          style={{
            padding: '10px 24px',
            background: 'transparent',
            color: 'var(--color-text-tertiary)',
            border: '1px solid var(--color-border-primary)',
            borderRadius: 8,
            textDecoration: 'none',
            fontSize: 14,
          }}
        >
          {t('backToHome') || '返回首页'}
        </Link>
        {feedbackUrl && (
          <a
            href={feedbackUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: '10px 24px',
              background: 'transparent',
              color: 'var(--color-text-tertiary)',
              border: '1px solid var(--color-border-primary)',
              borderRadius: 8,
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            反馈问题
          </a>
        )}
      </div>
    </div>
  )
}
