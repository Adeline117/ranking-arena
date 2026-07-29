'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'
import { FOUNDING_MEMBER_BANNER_HEIGHT } from './founding-member-layout'

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
    try {
      if (localStorage.getItem(DISMISS_KEY)) setDismissed(true)
    } catch {
      /* localStorage unavailable */
    }
  }, [])

  // 2026-07-04 #6:promo 全免费期间隐藏"$49.99 终身·前 200 名"——一边喊全免费
  // 一边卖终身付费自相矛盾、伤信任。promo 结束(PRO_FREE_PROMO=false)自动恢复。
  if (BETA_PRO_FEATURES_FREE) return null
  if (dismissed) return null

  const text = t('foundingMemberBannerText')
  const cta = t('foundingMemberBannerCta')

  return (
    <div
      className="founding-member-banner"
      data-testid="founding-member-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'nowrap',
        gap: 6,
        padding: `4px ${tokens.spacing[3]}`,
        height: FOUNDING_MEMBER_BANNER_HEIGHT,
        borderRadius: tokens.radius.md,
        background: 'var(--color-founding-accent-muted)',
        border: '1px solid var(--color-founding-accent-border)',
        fontSize: tokens.typography.fontSize.xs,
        lineHeight: 1.4,
        flexShrink: 0,
        minWidth: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {/* Star icon instead of emoji */}
      <span
        data-testid="founding-member-star"
        aria-hidden="true"
        style={{
          color: 'var(--color-founding-accent)',
          fontWeight: 900,
          fontSize: 14,
          letterSpacing: 0.5,
          flexShrink: 0,
        }}
      >
        ★
      </span>
      <span
        className="fm-text"
        data-testid="founding-member-text"
        title={text}
        style={{
          color: 'var(--color-text-secondary)',
          fontWeight: 500,
          flex: '1 1 0%',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {text}
      </span>
      <span
        className="fm-sub"
        style={{
          color: 'var(--color-text-tertiary)',
          fontSize: tokens.typography.fontSize.xs,
          flexShrink: 0,
        }}
      >
        {t('foundingMemberFirst200')}
      </span>
      <Link
        href="/pricing#lifetime"
        prefetch={false}
        className="fm-cta"
        data-testid="founding-member-cta"
        title={cta}
        style={{
          padding: `2px ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          background: 'var(--color-founding-accent)',
          color: 'var(--color-on-accent, #fff)',
          textDecoration: 'none',
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          flex: '0 0 auto',
          minWidth: 0,
          maxWidth: '40%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          boxSizing: 'border-box',
          transition: 'opacity 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = '0.85'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = '1'
        }}
      >
        {cta}
      </Link>
      <button
        type="button"
        data-testid="founding-member-dismiss"
        onClick={() => {
          setDismissed(true)
          try {
            localStorage.setItem(DISMISS_KEY, '1')
          } catch {
            /* ignore */
          }
        }}
        aria-label={t('dismiss')}
        style={{
          marginLeft: 'auto',
          background: 'none',
          border: 'none',
          color: 'var(--color-text-tertiary)',
          cursor: 'pointer',
          padding: 0,
          width: 22,
          height: 22,
          fontSize: 14,
          lineHeight: 1,
          opacity: 0.6,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ✕
      </button>
    </div>
  )
}
