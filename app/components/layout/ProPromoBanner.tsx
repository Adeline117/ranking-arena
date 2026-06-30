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
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { tokens } from '@/lib/design-tokens'

const DISMISS_KEY = 'pro-free-promo-dismissed'

export default function ProPromoBanner() {
  const { t } = useLanguage()
  // Start hidden: avoids a flash for dismissed users and keeps SSR/first-render
  // output identical (both render null), so there is no hydration mismatch.
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!PRO_FREE_PROMO) return
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return
    } catch {
      // localStorage unavailable (private mode) — still show the banner
    }
    setVisible(true)
  }, [])

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // ignore — at worst the banner shows again next load
    }
    setVisible(false)
  }

  if (!PRO_FREE_PROMO || !visible) return null

  return (
    <div
      role="status"
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
      <span>{t('proPromoBanner')}</span>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('proPromoBannerDismiss')}
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
