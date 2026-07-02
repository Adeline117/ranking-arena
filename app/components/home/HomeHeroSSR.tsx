/**
 * HomeHeroSSR — Server-rendered hero section for LCP optimization.
 *
 * Rendered as part of the SSR shell in page.tsx so it appears in the initial HTML
 * payload with zero JS dependency. This ensures the hero headline is the LCP element
 * and is visible as soon as the browser parses the HTML (~135ms TTFB).
 *
 * Hidden via CSS (#ssr-hero-shell) once the client HomeHero mounts inside HomePage.
 *
 * Key: No 'use client', no hooks — pure server component.
 * Uses getServerTranslation() to read language from cookie for i18n.
 */

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { getServerTranslation } from '@/lib/i18n/server'

interface HomeHeroSSRProps {
  exchangeCount?: number
}

export default async function HomeHeroSSR({ exchangeCount = 27 }: HomeHeroSSRProps) {
  const { t } = await getServerTranslation()
  const exchangeCountStr = `${exchangeCount}+`

  const headline = t('heroHeadline')
  const subtitle = t('heroSubtitle').replace('{exchanges}', String(exchangeCount))

  // Trader-count stat intentionally dropped — the hero leads with exchange
  // coverage; the trader total lives in the leaderboard itself.
  const stats = [
    { value: exchangeCountStr, label: t('heroStatExchanges') },
    { value: '30 min', label: t('heroStatUpdated') },
  ]

  return (
    <section
      style={{
        padding: `${tokens.spacing[10]} ${tokens.spacing[8]} ${tokens.spacing[8]}`,
        marginBottom: tokens.spacing[5],
        background:
          'linear-gradient(145deg, var(--color-bg-secondary) 0%, var(--color-bg-primary) 100%)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
        position: 'relative',
        overflow: 'hidden',
        minHeight: 200,
        contain: 'layout style',
      }}
    >
      {/* Mesh gradient — layered orbs for depth */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: `
            radial-gradient(ellipse 60% 50% at 15% 80%, rgba(147,115,181,0.12) 0%, transparent 70%),
            radial-gradient(ellipse 40% 60% at 85% 20%, rgba(34,211,238,0.06) 0%, transparent 60%),
            radial-gradient(ellipse 50% 40% at 50% 10%, rgba(147,115,181,0.08) 0%, transparent 60%)
          `,
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[6],
          flexWrap: 'wrap',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Left: Headline + subtitle */}
        <div style={{ flex: '1 1 400px', minWidth: 0 }}>
          {/* LCP element: this headline is the largest above-fold text in the SSR HTML */}
          <h1
            style={{
              fontSize: 'clamp(30px, 4.6vw, 48px)',
              fontWeight: tokens.typography.fontWeight.black,
              color: 'var(--color-text-primary)',
              marginBottom: tokens.spacing[3],
              lineHeight: 1.08,
              letterSpacing: '-0.03em',
            }}
          >
            {headline}
          </h1>
          <p
            style={{
              fontSize: '1.0625rem',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.6,
              margin: 0,
              maxWidth: 540,
            }}
          >
            {subtitle}
          </p>
        </div>

        {/* Right: Stats row */}
        <div
          style={{
            display: 'flex',
            gap: 'clamp(16px, 3vw, 32px)',
            flexShrink: 0,
          }}
        >
          {stats.map((stat) => (
            <div key={stat.label} style={{ textAlign: 'center', minWidth: 56 }}>
              <div
                style={{
                  fontSize: '2rem',
                  fontWeight: tokens.typography.fontWeight.black,
                  color: 'var(--color-text-primary)',
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1.1,
                  minHeight: '1.1em',
                  letterSpacing: '-0.02em',
                }}
              >
                {stat.value}
              </div>
              <div
                style={{
                  fontSize: '0.6875rem',
                  color: 'var(--color-text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontWeight: tokens.typography.fontWeight.medium,
                  whiteSpace: 'nowrap',
                  opacity: 0.7,
                }}
              >
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* CTA row: Get Started + Pro badge */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          marginTop: tokens.spacing[5],
          position: 'relative',
          zIndex: 1,
          flexWrap: 'wrap',
        }}
      >
        <Link
          href="/login"
          prefetch={false}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 20px',
            fontSize: '0.8125rem',
            fontWeight: tokens.typography.fontWeight.semibold,
            color: 'var(--color-on-accent)',
            background:
              'linear-gradient(135deg, var(--color-brand-hover) 0%, var(--color-brand) 100%)',
            border: 'none',
            borderRadius: tokens.radius.full,
            textDecoration: 'none',
            minHeight: 44, // WCAG 2.5.5 minimum touch target
            boxShadow: '0 4px 14px var(--color-accent-primary-30, rgba(147,115,181,0.3))',
          }}
        >
          {t('heroCTASignUp')}
        </Link>
        <Link
          href="/pricing"
          prefetch={false}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            fontSize: '0.75rem',
            color: 'var(--color-pro-gradient-start)',
            background: 'var(--color-pro-glow, rgba(167,139,250,0.1))',
            border: '1px solid var(--color-pro-border, rgba(167,139,250,0.25))',
            borderRadius: tokens.radius.full,
            textDecoration: 'none',
            fontWeight: tokens.typography.fontWeight.medium,
          }}
        >
          <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="var(--color-pro-gradient-start)"
            style={{ flexShrink: 0 }}
          >
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
          </svg>
          <span>{t('heroProBadge')}</span>
        </Link>
      </div>
    </section>
  )
}
