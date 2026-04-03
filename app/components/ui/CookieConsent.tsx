'use client'

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'

const LS_KEY = 'cookie_consent'

/** Pages where the mobile bottom nav is hidden (must mirror MobileBottomNav.HIDDEN_PATHS) */
const NAV_HIDDEN_PATHS = ['/login', '/onboarding', '/reset-password', '/auth/callback']

export default function CookieConsent() {
  const [visible, setVisible] = useState(false)
  const pathname = usePathname()

  const isNavHidden = NAV_HIDDEN_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))

  useEffect(() => {
    try {
      if (localStorage.getItem(LS_KEY) !== 'accepted') {
        setVisible(true)
      }
    } catch {
      // localStorage unavailable
    }
  }, [])

  const handleAccept = () => {
    try {
      localStorage.setItem(LS_KEY, 'accepted')
    } catch {
      // localStorage unavailable
    }
    setVisible(false)
  }

  // Auto-dismiss after 8 seconds — continued browsing implies consent
  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(handleAccept, 8000)
    return () => clearTimeout(timer)
  }, [visible]) // handleAccept is stable (no deps)

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: isNavHidden ? 0 : 'var(--mobile-nav-height, 60px)',
        left: 0,
        right: 0,
        zIndex: tokens.zIndex.overlay,
        padding: tokens.spacing[4],
        background: tokens.glass.bg.darkHeavy,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        borderTop: tokens.glass.border.medium,
      }}
    >
      <div
        style={{
          maxWidth: 960,
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[4],
          flexWrap: 'wrap',
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5, flex: 1, minWidth: 200 }}>
          We use cookies to improve your experience. By continuing, you agree to our{' '}
          <Link href="/legal/privacy" style={{ color: tokens.colors.accent.brand, textDecoration: 'underline' }}>
            Privacy Policy
          </Link>.
        </p>
        <div style={{ display: 'flex', gap: tokens.spacing[2], flexShrink: 0 }}>
          <Link
            href="/legal/privacy"
            className="interactive-scale"
            style={{
              padding: '8px 16px',
              minHeight: 44,
              borderRadius: tokens.radius.md,
              border: tokens.glass.border.medium,
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-tertiary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            Manage
          </Link>
          <button
            onClick={handleAccept}
            className="interactive-scale"
            style={{
              padding: '8px 20px',
              minHeight: 44,
              borderRadius: tokens.radius.md,
              border: 'none',
              background: tokens.gradient.primary,
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85' }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
