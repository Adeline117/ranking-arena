'use client'

import { useState, useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const LS_KEY = 'cookie_consent'

/** Pages where the mobile bottom nav is hidden (must mirror MobileBottomNav.HIDDEN_PATHS) */
const NAV_HIDDEN_PATHS = ['/login', '/onboarding', '/reset-password', '/auth/callback', '/quiz']

export default function CookieConsent() {
  const [visible, setVisible] = useState(false)
  const bannerRef = useRef<HTMLElement>(null)
  const pathname = usePathname()
  const { t } = useLanguage()

  const isNavHidden = NAV_HIDDEN_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const consent = localStorage.getItem(LS_KEY)
      if (consent !== 'accepted' && consent !== 'rejected') {
        // Delay showing banner — don't fight with LCP on first paint
        timer = setTimeout(() => setVisible(true), 2000)
      }
    } catch {
      // Private browsing/storage denial must not silently suppress consent.
      timer = setTimeout(() => setVisible(true), 2000)
    }
    return () => {
      if (timer) clearTimeout(timer)
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

  // Publish the measured height rather than a guessed constant. Copy wraps
  // differently by viewport and language, so a fixed 44px offset still let the
  // sheet cover FABs and the last page controls.
  useEffect(() => {
    const root = document.documentElement
    const banner = bannerRef.current
    if (!visible || !banner) return

    const publishHeight = () => {
      const height = Math.ceil(banner.getBoundingClientRect().height)
      if (height <= 0) return
      root.style.setProperty('--cookie-consent-height', `${height}px`)
      root.style.setProperty('--transient-bottom-offset', `${height}px`)
    }

    root.classList.add('has-cookie-consent')
    publishHeight()

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publishHeight)
    observer?.observe(banner)
    window.addEventListener('resize', publishHeight)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', publishHeight)
      root.classList.remove('has-cookie-consent')
      root.style.removeProperty('--cookie-consent-height')
      root.style.removeProperty('--transient-bottom-offset')
    }
  }, [visible])

  if (!visible) return null

  return (
    <>
      <div className="cookie-consent-spacer" aria-hidden="true" />
      <section
        ref={bannerRef}
        role="region"
        aria-live="polite"
        aria-labelledby="cookie-consent-title"
        aria-describedby="cookie-consent-description"
        className="cookie-consent"
        style={{
          bottom: isNavHidden
            ? 'env(safe-area-inset-bottom, 0px)'
            : 'var(--mobile-nav-height, 60px)',
          zIndex: tokens.zIndex.overlay,
        }}
      >
        <div className="cookie-consent-inner">
          <div className="cookie-consent-copy">
            <span className="cookie-consent-icon" aria-hidden="true">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </span>
            <div>
              <h2 id="cookie-consent-title" className="cookie-consent-title">
                {t('cookieSettings')}
              </h2>
              <p id="cookie-consent-description" className="cookie-consent-description">
                {t('cookieBannerShort')}{' '}
                <Link href="/privacy" prefetch={false} className="cookie-consent-privacy-link">
                  {t('privacyPolicy')}
                </Link>
              </p>
            </div>
          </div>
          <div className="cookie-consent-actions">
            <button
              type="button"
              onClick={handleReject}
              className="cookie-consent-action cookie-consent-action-secondary"
            >
              {t('necessaryOnly')}
            </button>
            <button
              type="button"
              onClick={handleAccept}
              className="cookie-consent-action cookie-consent-action-primary"
            >
              {t('acceptAll')}
            </button>
          </div>
        </div>
      </section>
    </>
  )
}
