'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

const DISMISS_KEY = 'founding-banner-dismissed'

/**
 * Founding Member Banner — subtle strip above the ranking table
 * Task 5: Pricing Conversion Path
 * Links to /pricing#lifetime
 */
export default function FoundingMemberBanner() {
  const { t } = useLanguage()
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    try { if (localStorage.getItem(DISMISS_KEY)) setDismissed(true) } catch {}
  }, [])

  if (dismissed) return null

  const text = t('foundingMemberBannerText')
  const cta = t('foundingMemberBannerCta')

  return (
    <div
      className="founding-member-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `4px ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        background: 'var(--color-founding-accent-muted)',
        border: '1px solid var(--color-founding-accent-border)',
        fontSize: tokens.typography.fontSize.xs,
        lineHeight: 1.4,
        flexShrink: 0,
      }}
    >
      {/* Star icon instead of emoji */}
      <span style={{ color: 'var(--color-founding-accent)', fontWeight: 900, fontSize: 14, letterSpacing: 0.5 }}>
        ★
      </span>
      <span style={{ color: 'var(--color-text-secondary)', fontWeight: 500 }}>
        {text}
      </span>
      <span style={{ color: 'var(--color-text-tertiary)', fontSize: tokens.typography.fontSize.xs }}>
        {t('foundingMemberFirst200')}
      </span>
      <Link
        href="/pricing#lifetime"
        prefetch={false}
        style={{
          padding: `2px ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          background: 'var(--color-founding-accent)',
          color: 'var(--color-on-accent, #fff)',
          textDecoration: 'none',
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          transition: 'opacity 0.15s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85' }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}
      >
        {cta}
      </Link>
      <button
        onClick={() => { setDismissed(true); try { localStorage.setItem(DISMISS_KEY, '1') } catch {} }}
        aria-label="Dismiss"
        style={{
          marginLeft: 'auto',
          background: 'none',
          border: 'none',
          color: 'var(--color-text-tertiary)',
          cursor: 'pointer',
          padding: '2px 4px',
          fontSize: 14,
          lineHeight: 1,
          opacity: 0.6,
        }}
      >
        ✕
      </button>
    </div>
  )
}
