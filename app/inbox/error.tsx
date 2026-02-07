'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function InboxError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useLanguage()

  useEffect(() => {
    console.error('[InboxPage Error]', error)
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
      <div style={{ fontSize: 48, marginBottom: 16 }}>!</div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
        {t('errorInboxPage')}
      </h2>
      <p style={{ color: '#888', marginBottom: 24, maxWidth: 400 }}>
        {t('errorRefresh')}
      </p>
      {error.digest && (
        <p style={{ color: '#666', fontSize: 12, marginBottom: 16, fontFamily: 'monospace' }}>
          {t('errorCode')}: {error.digest}
        </p>
      )}
      <div style={{ display: 'flex', gap: 12 }}>
        <button
          onClick={reset}
          style={{
            padding: '10px 24px',
            background: '#8b6fa8',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {t('retry')}
        </button>
        <Link
          href="/"
          style={{
            padding: '10px 24px',
            background: 'transparent',
            color: '#ccc',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 8,
            textDecoration: 'none',
            fontSize: 14,
          }}
        >
          {t('backToHome')}
        </Link>
      </div>
    </div>
  )
}
