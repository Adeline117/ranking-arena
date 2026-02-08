'use client'

import { t } from '@/lib/i18n'

/**
 * 离线页面
 * 当用户离线且没有缓存时显示
 */

export default function OfflinePage() {
  const handleRetry = () => {
    window.location.reload()
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        backgroundColor: 'var(--color-bg-primary, #0B0A10)',
        color: 'var(--color-text-primary, #EDEDED)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: '400px',
          textAlign: 'center',
          padding: '2rem',
        }}
      >
        {/* 离线图标 */}
        <div
          style={{
            fontSize: '4rem',
            marginBottom: '1.5rem',
          }}
        >
          --
        </div>

        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 'bold',
            marginBottom: '1rem',
          }}
        >
          {t('youAreOffline')}
        </h1>

        <p
          style={{
            fontSize: '0.875rem',
            color: 'var(--color-text-secondary, #A8A8B3)',
            marginBottom: '2rem',
            lineHeight: 1.6,
          }}
        >
          {t('checkNetworkAndRetryOffline')}
        </p>

        <button
          onClick={handleRetry}
          style={{
            padding: '0.75rem 2rem',
            fontSize: '0.875rem',
            fontWeight: '500',
            color: '#FFFFFF',
            backgroundColor: 'var(--color-brand)',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            transition: 'background-color 0.2s',
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.backgroundColor = '#9d84b5'
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-brand)'
          }}
        >
          {t('retryConnection')}
        </button>

        <p
          style={{
            fontSize: '0.75rem',
            color: 'var(--color-text-tertiary, #6B6B7B)',
            marginTop: '2rem',
          }}
        >
          {t('arenaTagline')}
        </p>
      </div>
    </div>
  )
}
