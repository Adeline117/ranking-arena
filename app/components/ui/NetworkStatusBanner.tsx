'use client'

import { useEffect, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function NetworkStatusBanner() {
  const [isOffline, setIsOffline] = useState(false)
  const [show, setShow] = useState(false)
  const { t } = useLanguage()

  useEffect(() => {
    const handleOffline = () => { setIsOffline(true); setShow(true) }
    const handleOnline = () => {
      setIsOffline(false)
      setTimeout(() => setShow(false), 2000)
    }

    if (!navigator.onLine) { setIsOffline(true); setShow(true) }

    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  const handleRetry = useCallback(() => {
    if (navigator.onLine) {
      setIsOffline(false)
      setTimeout(() => setShow(false), 1000)
      window.location.reload()
    }
  }, [])

  if (!show) return null

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: tokens.zIndex.toast,
        padding: '10px 16px',
        textAlign: 'center',
        fontSize: 13,
        fontWeight: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        background: isOffline
          ? tokens.colors.accent.error
          : tokens.colors.accent.success,
        color: tokens.colors.white,
        transition: `all ${tokens.transition.slow}`,
      }}
    >
      {isOffline ? (
        <>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          <span>{t('networkDisconnected')}</span>
          <button
            onClick={handleRetry}
            style={{
              background: 'rgba(255,255,255,0.2)',
              border: '1px solid rgba(255,255,255,0.4)',
              color: tokens.colors.white,
              borderRadius: tokens.radius.sm,
              padding: '3px 10px',
              fontSize: 12,
              cursor: 'pointer',
              marginLeft: 4,
            }}
          >
            {t('retry')}
          </button>
        </>
      ) : (
        <>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {t('networkReconnected')}
        </>
      )}
    </div>
  )
}
