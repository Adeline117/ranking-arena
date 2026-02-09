'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

export default function RankingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useLanguage()

  useEffect(() => {
    logger.error('[Rankings Error]', error)
  }, [error])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      padding: 24,
      textAlign: 'center',
    }}>
      <div style={{
        width: 72,
        height: 72,
        borderRadius: '50%',
        background: 'rgba(255, 124, 124, 0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
      }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-error, #ff7c7c)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8, color: tokens.colors.text.primary }}>
        {t('errorLoadingRankings') || '排行榜加载失败'}
      </h2>
      <p style={{ color: tokens.colors.text.secondary, marginBottom: 24, maxWidth: 400, fontSize: 14, lineHeight: 1.6 }}>
        {t('errorRefresh') || '请刷新页面或稍后再试'}
      </p>
      {error.digest && (
        <p style={{ color: tokens.colors.text.tertiary, fontSize: 12, marginBottom: 16, fontFamily: 'monospace' }}>
          {t('errorCode') || '错误代码'}: {error.digest}
        </p>
      )}
      <div style={{ display: 'flex', gap: 12 }}>
        <button
          onClick={reset}
          style={{
            padding: '10px 24px',
            background: tokens.colors.accent.brand,
            color: tokens.colors.white,
            border: 'none',
            borderRadius: tokens.radius.md,
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          {t('retry') || '重试'}
        </button>
        <Link
          href="/"
          style={{
            padding: '10px 24px',
            background: 'transparent',
            color: tokens.colors.text.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            textDecoration: 'none',
            fontSize: 14,
          }}
        >
          {t('backToHome') || '返回首页'}
        </Link>
      </div>
    </div>
  )
}
