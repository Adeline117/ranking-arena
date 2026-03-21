'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLoginModal } from '@/lib/hooks/useLoginModal'

/**
 * Full-screen signup prompt for guest users.
 * Triggers after scrolling or clicking around (3 interactions or 30s browsing).
 * Uses IntersectionObserver instead of scroll listener to reduce TBT.
 */
export default function GuestSignupPrompt() {
  const { isLoggedIn, user } = useAuthSession()
  const session = isLoggedIn && user
  const loading = false
  const { t } = useLanguage()
  const [show, setShow] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

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

  // Use IntersectionObserver instead of scroll listener to reduce main thread blocking.
  // A sentinel div is placed ~800px down the page; when it enters the viewport, we trigger.
  useEffect(() => {
    if (session || loading || dismissed) return

    // Also trigger after 45 seconds of browsing
    const timer = setTimeout(trigger, 45000)

    // Create sentinel element positioned ~800px from top
    const sentinel = document.createElement('div')
    sentinel.style.position = 'absolute'
    sentinel.style.top = '800px'
    sentinel.style.height = '1px'
    sentinel.style.width = '1px'
    sentinel.style.pointerEvents = 'none'
    sentinel.style.opacity = '0'
    document.body.appendChild(sentinel)
    sentinelRef.current = sentinel

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          trigger()
          observer.disconnect()
        }
      },
      { threshold: 0 }
    )
    observer.observe(sentinel)

    return () => {
      observer.disconnect()
      clearTimeout(timer)
      if (sentinelRef.current && sentinelRef.current.parentNode) {
        sentinelRef.current.parentNode.removeChild(sentinelRef.current)
        sentinelRef.current = null
      }
    }
  }, [session, loading, dismissed, trigger])

  const handleDismiss = useCallback(() => {
    setShow(false)
    setDismissed(true)
    sessionStorage.setItem('guest-signup-dismissed', '1')
  }, [])

  // Escape key dismisses the prompt
  useEffect(() => {
    if (!show) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleDismiss()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [show, handleDismiss])

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
        background: 'var(--color-bg-secondary, #14121C)',
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
          minHeight: 44,
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
          width: 44,
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
        }}
        aria-label="Close"
      >
        ×
      </button>
    </div>
  )
}
