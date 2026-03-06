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
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
        marginBottom: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        background: 'color-mix(in srgb, #f59e0b 8%, var(--color-bg-secondary, transparent))',
        border: '1px solid color-mix(in srgb, #f59e0b 30%, transparent)',
        fontSize: tokens.typography.fontSize.sm,
        lineHeight: 1.4,
        flexWrap: 'wrap',
      }}
    >
      {/* Star icon instead of emoji */}
      <span style={{ color: '#f59e0b', fontWeight: 900, fontSize: 14, letterSpacing: 0.5 }}>
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
        style={{
          padding: `2px ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          background: '#f59e0b',
          color: '#fff',
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
