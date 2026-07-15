'use client'

import { useState, useEffect, useCallback, memo } from 'react'
import { usePathname } from 'next/navigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { isFloatingActionRoute } from '@/lib/features'

export default memo(function ScrollToTop() {
  const [visible, setVisible] = useState(false)
  const { t } = useLanguage()
  const pathname = usePathname()

  // Pages that render the FloatingActionButton — keep scroll-to-top from
  // overlapping it (it must sit ABOVE the FAB). The old whitelist was just
  // ['/','/groups'] and missed every real FAB route (/hot, /market/*,
  // /watchlist, /saved, /referral) → scroll-to-top landed on top of the FAB
  // on mobile. Match the actual FAB-rendering routes here.
  const hasFab = isFloatingActionRoute(pathname)

  useEffect(() => {
    const handleScroll = () => {
      setVisible(window.scrollY > 500)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  return (
    <button
      onClick={scrollToTop}
      aria-label={t('scrollToTop')}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className="scroll-to-top-btn"
      style={{
        position: 'fixed',
        // +var(--transient-bottom-bar): lift clear of the cookie / guest-signup bar.
        bottom: hasFab
          ? // Clear the 56px FAB (bottom+20) plus its drop shadow with a real gap,
            // so scroll-to-top no longer visually overlaps the FAB (U9-5).
            'calc(var(--mobile-nav-height, 60px) + env(safe-area-inset-bottom, 0px) + 96px + var(--transient-bottom-bar, 0px))'
          : 'calc(var(--mobile-nav-height, 60px) + env(safe-area-inset-bottom, 0px) + 16px + var(--transient-bottom-bar, 0px))',
        right: 16,
        zIndex: tokens.zIndex.sticky + 1,
        width: 44,
        height: 44,
        borderRadius: '50%',
        border: '1px solid var(--color-border-secondary, var(--glass-border-light))',
        background: 'var(--color-bg-secondary, #14121C)',
        color: 'var(--color-text-secondary, #A8A8B3)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: 'var(--shadow-sm-dark)',
        opacity: visible ? 1 : 0,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition:
          'opacity 0.3s ease, visibility 0.3s ease, transform 0.3s ease, background 0.2s ease, border-color 0.2s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-brand, #8b6fa8)'
        e.currentTarget.style.color = 'var(--color-brand, #8b6fa8)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor =
          'var(--color-border-secondary, var(--glass-border-light))'
        e.currentTarget.style.color = 'var(--color-text-secondary, #A8A8B3)'
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="18 15 12 9 6 15" />
      </svg>
    </button>
  )
})
