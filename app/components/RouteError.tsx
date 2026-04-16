'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { parseError } from '@/lib/utils/error-messages'
import { logger } from '@/lib/logger'

const FEEDBACK_URL = '/u/adelinewen1107'

/**
 * 统一路由级错误组件
 * 在各路由 error.tsx 中使用，提供一致的中文错误体验
 *
 * - 不向用户暴露原始 error.message
 * - 开发模式下可展开错误详情
 * - 支持重试、返回首页、反馈问题
 */
export default function RouteError({
  error,
  reset,
  contextLabel,
}: {
  error: Error & { digest?: string }
  reset: () => void
  contextLabel?: string
}) {
  const { t } = useLanguage()
  const [showDetails, setShowDetails] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const isDev = process.env.NODE_ENV === 'development'
  const parsed = parseError(error)

  useEffect(() => {
    logger.error(`[${contextLabel || 'RouteError'}]`, error)
  }, [error, contextLabel])

  const handleRetry = () => {
    setIsRetrying(true)
    setTimeout(() => reset(), 300)
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      padding: tokens.spacing[6],
      textAlign: 'center',
    }}>
      {/* 错误图标 */}
      <div style={{
        width: 72,
        height: 72,
        borderRadius: '50%',
        background: 'var(--color-bg-error-subtle, var(--color-accent-error-10))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: tokens.spacing[5],
      }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-error, #ff7c7c)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>

      {/* 标题 */}
      <h2 style={{
        fontSize: 20,
        fontWeight: 600,
        marginBottom: tokens.spacing[2],
        color: 'var(--color-text-primary)',
      }}>
        {t('errorTitle') || '出了点问题'}
      </h2>

      {/* 用户友好消息 */}
      <p style={{
        color: 'var(--color-text-secondary)',
        marginBottom: tokens.spacing[4],
        maxWidth: 400,
        fontSize: 14,
        lineHeight: 1.6,
      }}>
        {parsed.retryable
          ? (t('errorRefresh') || '请刷新页面或稍后再试')
          : (parsed.message)}
      </p>

      {/* 错误代码 */}
      {error.digest && (
        <p style={{
          color: 'var(--color-text-tertiary)',
          fontSize: 12,
          marginBottom: tokens.spacing[4],
          fontFamily: '"SF Mono", Consolas, monospace',
          padding: `${tokens.spacing[1]} ${tokens.spacing[2.5]}`,
          background: 'var(--color-accent-error-08)',
          borderRadius: tokens.radius.sm,
          border: '1px solid var(--color-accent-error-12)',
        }}>
          {t('errorCode') || '错误代码'}: {error.digest}
        </p>
      )}

      {/* 开发模式错误详情 */}
      {isDev && (
        <div style={{ marginBottom: tokens.spacing[4], maxWidth: 500, width: '100%' }}>
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
            {showDetails ? t('collapse') : t('errorDetails')}
          </button>
          {showDetails && (
            <pre style={{
              marginTop: tokens.spacing[2],
              padding: tokens.spacing[3],
              background: 'var(--color-bg-tertiary, var(--color-overlay-medium))',
              borderRadius: tokens.radius.md,
              border: '1px solid var(--color-border-primary)',
              fontSize: 11,
              color: 'var(--color-text-secondary)',
              textAlign: 'left',
              overflow: 'auto',
              maxHeight: 200,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}>
              {`Type: ${parsed.type}\nRetryable: ${parsed.retryable}\nStatus: ${parsed.statusCode ?? 'N/A'}\n\n${error.stack || error.message}`}
            </pre>
          )}
        </div>
      )}

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: tokens.spacing[3], flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={handleRetry}
          disabled={isRetrying}
          style={{
            padding: `${tokens.spacing[2.5]} ${tokens.spacing[6]}`,
            background: tokens.colors.accent.brand,
            color: tokens.colors.white,
            border: 'none',
            borderRadius: tokens.radius.md,
            cursor: isRetrying ? 'wait' : 'pointer',
            fontSize: 14,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[1.5],
            opacity: isRetrying ? 0.7 : 1,
            transition: 'opacity 0.2s',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          {isRetrying ? t('globalErrorRetrying') : t('retry')}
        </button>
        <Link
          href="/"
          style={{
            padding: `${tokens.spacing[2.5]} ${tokens.spacing[6]}`,
            background: 'transparent',
            color: 'var(--color-text-tertiary)',
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.md,
            textDecoration: 'none',
            fontSize: 14,
          }}
        >
          {t('backToHome') || '返回首页'}
        </Link>
        <a
          href={FEEDBACK_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: `${tokens.spacing[2.5]} ${tokens.spacing[6]}`,
            background: 'transparent',
            color: 'var(--color-text-tertiary)',
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.md,
            textDecoration: 'none',
            fontSize: 14,
          }}
        >
          {t('helpFeedbackQ')}
        </a>
      </div>
    </div>
  )
}
