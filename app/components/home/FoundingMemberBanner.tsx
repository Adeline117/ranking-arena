'use client'

import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

/**
 * Founding Member Banner — subtle strip above the ranking table
 * Task 5: Pricing Conversion Path
 * Links to /pricing#lifetime
 */
export default function FoundingMemberBanner() {
  const { t } = useLanguage()

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
    </div>
  )
}
