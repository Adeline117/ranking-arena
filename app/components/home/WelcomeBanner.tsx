'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

function WelcomeBannerInner() {
  const [show, setShow] = useState(false)
  const { t } = useLanguage()
  const searchParams = useSearchParams()

  useEffect(() => {
    if (searchParams.get('welcome') !== '1') return
    if (sessionStorage.getItem('welcome-shown')) return
    sessionStorage.setItem('welcome-shown', '1')
    setShow(true)
    const timer = setTimeout(() => setShow(false), 8000)
    return () => clearTimeout(timer)
  }, [searchParams])

  if (!show) return null

  return (
    <div style={{
      margin: '0 auto',
      maxWidth: 1400,
      padding: '0 16px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        background: 'color-mix(in srgb, var(--color-accent-success, #16c784) 10%, var(--color-bg-secondary))',
        border: '1px solid color-mix(in srgb, var(--color-accent-success, #16c784) 25%, transparent)',
        borderRadius: tokens.radius.lg,
        marginTop: 8,
        fontSize: 14,
        color: 'var(--color-text-primary)',
      }}>
        <span style={{ fontWeight: 600 }}>
          {t('welcomeMessage') || 'Welcome! Browse the leaderboard to find traders you\'re interested in and follow them.'}
        </span>
        <button
          onClick={() => setShow(false)}
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            color: 'var(--color-text-tertiary)',
            cursor: 'pointer',
            padding: '2px 6px',
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

/** WelcomeBanner — shown once after registration via ?welcome=1 param. */
export default function WelcomeBanner() {
  return (
    <Suspense fallback={null}>
      <WelcomeBannerInner />
    </Suspense>
  )
}
