'use client'

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'

const LS_KEY = 'cookie_consent'

/** Pages where the mobile bottom nav is hidden (must mirror MobileBottomNav.HIDDEN_PATHS) */
const NAV_HIDDEN_PATHS = ['/login', '/onboarding', '/reset-password', '/auth/callback', '/quiz']

export default function CookieConsent() {
  const [visible, setVisible] = useState(false)
  const pathname = usePathname()

  const isNavHidden = NAV_HIDDEN_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))

  useEffect(() => {
    try {
      const consent = localStorage.getItem(LS_KEY)
      if (consent !== 'accepted' && consent !== 'rejected') {
        // Delay showing banner — don't fight with LCP on first paint
        const t = setTimeout(() => setVisible(true), 2000)
        return () => clearTimeout(t)
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

  const handleReject = () => {
    try {
      localStorage.setItem(LS_KEY, 'rejected')
    } catch {
      // localStorage unavailable
    }
    setVisible(false)
  }

  if (!visible) return null

  // Mobile: ultra-slim single-line bar (36px vs ~95px before)
  // Desktop: standard two-button layout
  return (
    <div
      style={{
        position: 'fixed',
        bottom: isNavHidden ? 'env(safe-area-inset-bottom, 0px)' : 'var(--mobile-nav-height, 60px)',
        left: 0,
        right: 0,
        zIndex: tokens.zIndex.overlay,
        padding: '4px 12px',
        background: tokens.glass.bg.heavy,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        borderTop: `1px solid ${tokens.colors.border.primary}`,
        animation: 'fadeIn 0.3s ease-out',
      }}
    >
      <div
        style={{
          maxWidth: 960,
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 11,
            color: 'var(--color-text-tertiary)',
            lineHeight: 1.3,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          We use cookies.{' '}
          <Link
            href="/legal/privacy"
            style={{ color: tokens.colors.accent.brand, textDecoration: 'underline' }}
          >
            Privacy
          </Link>
        </p>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            onClick={handleReject}
            style={{
              padding: '4px 10px',
              minHeight: 24,
              borderRadius: 6,
              border: '1px solid var(--glass-border-light)',
              background: 'transparent',
              color: 'var(--color-text-tertiary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reject
          </button>
          <button
            onClick={handleAccept}
            style={{
              padding: '4px 12px',
              minHeight: 24,
              borderRadius: 6,
              border: 'none',
              background: tokens.gradient.primary,
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
