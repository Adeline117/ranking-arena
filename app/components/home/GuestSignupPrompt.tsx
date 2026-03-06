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
        zIndex: tokens.zIndex.modal,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-backdrop)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        animation: 'modalFadeIn 0.3s ease',
      }}
      onClick={handleDismiss}
    >
      <div
        style={{
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.xl,
          padding: `${tokens.spacing[10]} ${tokens.spacing[8]}`,
          maxWidth: 420,
          width: '90%',
          textAlign: 'center',
          position: 'relative',
          animation: 'modalSlideUp 0.3s ease',
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
            padding: 12,
            minWidth: 44,
            minHeight: 44,
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          aria-label="Close"
        >
          ×
        </button>

        <h2 style={{
          fontSize: tokens.typography.fontSize.xl,
          fontWeight: 800,
          color: tokens.colors.text.primary,
          margin: `0 0 ${tokens.spacing[2]}`,
        }}>
          {t('guestSignupTitle')}
        </h2>

        <p style={{
          fontSize: tokens.typography.fontSize.sm,
          color: tokens.colors.text.secondary,
          margin: `0 0 ${tokens.spacing[4]}`,
          lineHeight: 1.6,
        }}>
          {t('guestSignupSubtitle')}
        </p>

        <div style={{
          textAlign: 'left',
          margin: `0 0 ${tokens.spacing[5]}`,
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
              fontSize: tokens.typography.fontSize.md,
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
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
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

    </div>
  )
}
