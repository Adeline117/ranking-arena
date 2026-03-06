'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

/**
 * Full-screen signup prompt for guest users.
 * Triggers after scrolling or clicking around (3 interactions or 30s browsing).
 */
export default function GuestSignupPrompt() {
  const { isLoggedIn, user } = useAuthSession()
  const session = isLoggedIn && user
  const loading = false
  const { t } = useLanguage()
  const [show, setShow] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  // Check if already dismissed this session
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const d = sessionStorage.getItem('guest-signup-dismissed')
      if (d) setDismissed(true)
    }
  }, [])

  const trigger = useCallback(() => {
    if (!dismissed && !session && !loading) {
      setShow(true)
    }
  }, [dismissed, session, loading])

  // Track scroll depth - trigger after scrolling 800px
  useEffect(() => {
    if (session || loading || dismissed) return

    let scrollTriggered = false
    const handleScroll = () => {
      if (scrollTriggered) return
      if (window.scrollY > 800) {
        scrollTriggered = true
        trigger()
      }
    }

    // Also trigger after 45 seconds of browsing
    const timer = setTimeout(trigger, 45000)

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      clearTimeout(timer)
    }
  }, [session, loading, dismissed, trigger])

  const handleDismiss = () => {
    setShow(false)
    setDismissed(true)
    sessionStorage.setItem('guest-signup-dismissed', '1')
  }

  if (!show || session || loading) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-backdrop)',
        backdropFilter: 'blur(4px)',
        animation: 'fadeIn 0.3s ease',
      }}
      onClick={handleDismiss}
    >
      <div
        style={{
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.xl,
          padding: '40px 32px',
          maxWidth: 420,
          width: '90%',
          textAlign: 'center',
          position: 'relative',
          animation: 'slideUp 0.3s ease',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={handleDismiss}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: tokens.colors.text.tertiary,
            fontSize: 20,
            cursor: 'pointer',
            padding: 8,
            lineHeight: 1.2,
          }}
          aria-label="Close"
        >
          ×
        </button>

        <h2 style={{
          fontSize: 24,
          fontWeight: 800,
          color: tokens.colors.text.primary,
          margin: '0 0 8px',
        }}>
          {t('guestSignupTitle')}
        </h2>

        <p style={{
          fontSize: 14,
          color: tokens.colors.text.secondary,
          margin: '0 0 16px',
          lineHeight: 1.6,
        }}>
          {t('guestSignupSubtitle')}
        </p>

        <div style={{
          textAlign: 'left',
          margin: '0 0 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          {[t('guestSignupFeature1'), t('guestSignupFeature2'), t('guestSignupFeature3')].map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: tokens.colors.text.secondary }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.brand} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {item}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Link
            href="/login"
            style={{
              display: 'block',
              padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
              borderRadius: tokens.radius.lg,
              background: tokens.colors.accent.brand,
              color: tokens.colors.white,
              fontSize: 16,
              fontWeight: 700,
              textDecoration: 'none',
              textAlign: 'center',
            }}
          >
            {t('guestSignupButton')}
          </Link>

          <button
            onClick={handleDismiss}
            style={{
              padding: '10px 24px',
              borderRadius: tokens.radius.lg,
              background: 'transparent',
              color: tokens.colors.text.tertiary,
              fontSize: 13,
              fontWeight: 500,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {t('guestSignupDismiss')}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
