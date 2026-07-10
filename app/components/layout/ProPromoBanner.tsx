'use client'

/**
 * ProPromoBanner — labels the "Pro features free for a limited time" promo.
 *
 * Rendered globally in the root layout. Shown ONLY while `PRO_FREE_PROMO` is
 * true; when the owner flips that flag back to `false` (in lib/types/premium.ts)
 * this banner disappears together with the unlock — one flag controls everything.
 *
 * Dismissible: the choice is persisted in localStorage and the banner only
 * reappears for users who have not dismissed it. To avoid a flash for users who
 * already dismissed, we start hidden and reveal post-mount once we've checked.
 */

import { useState, useEffect } from 'react'
import { t as translate, getLanguage, loadTranslations } from '@/lib/i18n'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { tokens } from '@/lib/design-tokens'

const DISMISS_KEY = 'pro-free-promo-dismissed'

// English defaults so the banner NEVER renders a raw i18n key — this component
// is mounted in the ROOT layout, which (for homepage LCP) omits LanguageProvider,
// so it cannot use useLanguage(). It resolves the localized copy itself via the
// static lib/i18n dictionary, falling back to these strings if load fails.
const DEFAULT_TEXT =
  '🎉 Pro features are free for a limited time — enjoy everything, no upgrade needed.'
const DEFAULT_DISMISS = 'Dismiss'

export default function ProPromoBanner() {
  // Start hidden: avoids a flash for dismissed users and keeps SSR/first-render
  // output identical (both render null), so there is no hydration mismatch.
  const [visible, setVisible] = useState(false)
  const [text, setText] = useState(DEFAULT_TEXT)
  const [dismissLabel, setDismissLabel] = useState(DEFAULT_DISMISS)

  useEffect(() => {
    if (!PRO_FREE_PROMO) return
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return
    } catch {
      // localStorage unavailable (private mode) — still show the banner
    }
    let cancelled = false
    ;(async () => {
      try {
        await loadTranslations(getLanguage())
        if (cancelled) return
        const resolved = translate('proPromoBanner')
        // translate() returns the key itself when missing — guard against that.
        if (resolved && resolved !== 'proPromoBanner') setText(resolved)
        const d = translate('proPromoBannerDismiss')
        if (d && d !== 'proPromoBannerDismiss') setDismissLabel(d)
      } catch {
        // keep English defaults
      }
      if (!cancelled) setVisible(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // ignore — at worst the banner shows again next load
    }
    setVisible(false)
    // Single-banner rule: now that the promo banner is gone, reveal the
    // closed-beta notice in its place — unless the user already dismissed beta
    // itself (<30d ago). Its dismiss handler is always wired by BetaBanner's
    // pre-paint script, so the revealed banner is fully functional.
    try {
      const beta = document.getElementById('beta-banner')
      if (beta) {
        const d = localStorage.getItem('beta-banner-dismissed-at')
        if (!d || Date.now() - Number(d) >= 2_592_000_000) {
          beta.style.display = ''
        }
      }
    } catch {
      // localStorage/DOM unavailable — beta banner will appear on next load
    }
  }

  if (!PRO_FREE_PROMO || !visible) return null

  return (
    <div
      role="status"
      className="pro-promo-banner"
      style={{
        background: tokens.gradient.success,
        color: 'white',
        textAlign: 'center',
        padding: `${tokens.spacing[2.5]} ${tokens.spacing[12]} ${tokens.spacing[2.5]} ${tokens.spacing[4]}`,
        fontSize: tokens.typography.fontSize.base,
        fontWeight: tokens.typography.fontWeight.semibold,
        position: 'relative',
        zIndex: 1,
      }}
    >
      <span className="pro-promo-text">{text}</span>
      <button
        type="button"
        onClick={dismiss}
        aria-label={dismissLabel}
        style={{
          position: 'absolute',
          right: tokens.spacing[1],
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'transparent',
          border: 'none',
          color: 'white',
          fontSize: tokens.typography.fontSize.lg,
          cursor: 'pointer',
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          lineHeight: 1,
          opacity: 0.85,
          minWidth: 44,
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ✕
      </button>
    </div>
  )
}
