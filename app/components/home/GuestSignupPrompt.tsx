'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLoginModal } from '@/lib/hooks/useLoginModal'

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
        bottom: 60,
        left: 0,
        right: 0,
        zIndex: tokens.zIndex.sticky + 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '12px 16px',
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        borderTop: '1px solid var(--color-border-primary)',
        gap: 12,
        animation: 'modalSlideUp 0.3s ease',
      }}
    >
      <span style={{
        fontSize: 13,
        color: tokens.colors.text.secondary,
        flex: 1,
      }}>
        {t('guestSignupSubtitle')}
      </span>
      <button
        onClick={() => useLoginModal.getState().openLoginModal()}
        style={{
          padding: '8px 20px',
          borderRadius: tokens.radius.md,
          background: tokens.colors.accent.brand,
          color: tokens.colors.white,
          fontSize: 13,
          fontWeight: 700,
          border: 'none',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {t('guestSignupButton')}
      </button>
      <button
        onClick={handleDismiss}
        style={{
          background: 'none',
          border: 'none',
          color: tokens.colors.text.tertiary,
          fontSize: 18,
          cursor: 'pointer',
          padding: 8,
          lineHeight: 1,
        }}
        aria-label="Close"
      >
        ×
      </button>
    </div>
  )
}
