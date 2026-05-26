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
  traderCount?: number
  exchangeCount?: number
}

function formatCount(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K+`
  return `${n}+`
}

export default async function HomeHeroSSR({
  traderCount = 17000,
  exchangeCount = 27,
}: HomeHeroSSRProps) {
  const { t } = await getServerTranslation()
  const traderCountStr = formatCount(traderCount)
  const exchangeCountStr = `${exchangeCount}+`

  const headline = t('heroHeadline')
  const subtitle = t('heroSubtitle')
    .replace('{exchanges}', String(exchangeCount))
    .replace('{traders}', traderCountStr)

  const stats = [
    { value: traderCountStr, label: t('heroStatTraders') },
    { value: exchangeCountStr, label: t('heroStatExchanges') },
    { value: '30 min', label: t('heroStatUpdated') },
  ]

  return (
    <section
      style={{
        padding: `${tokens.spacing[8]} ${tokens.spacing[6]} ${tokens.spacing[6]}`,
        marginBottom: tokens.spacing[4],
        background:
          'linear-gradient(145deg, var(--color-bg-secondary) 0%, var(--color-bg-primary) 100%)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
        position: 'relative',
        overflow: 'hidden',
        minHeight: 120,
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
              fontSize: 'clamp(20px, 2.8vw, 28px)',
              fontWeight: 700,
              color: 'var(--color-text-primary, #fff)',
              marginBottom: tokens.spacing[2],
              lineHeight: 1.2,
              letterSpacing: '-0.02em',
            }}
          >
            {headline}
          </h1>
          <p
            style={{
              fontSize: '0.875rem',
              color: 'var(--color-text-tertiary, rgba(255,255,255,0.55))',
              lineHeight: 1.6,
              margin: 0,
              maxWidth: 500,
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
                  fontSize: '1.5rem',
                  fontWeight: 700,
                  color: 'var(--color-text-primary, #f0f0f0)',
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1.2,
                  minHeight: '1.2em',
                  letterSpacing: '-0.02em',
                }}
              >
                {stat.value}
              </div>
              <div
                style={{
                  fontSize: '0.6875rem',
                  color: 'var(--color-accent-secondary, #22d3ee)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontWeight: 500,
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
            fontWeight: 600,
            color: '#fff',
            background:
              'linear-gradient(135deg, var(--color-brand-hover, #a68ec5) 0%, var(--color-brand, #9373b5) 100%)',
            border: 'none',
            borderRadius: 9999,
            textDecoration: 'none',
            minHeight: 38,
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
            color: 'var(--color-pro-gradient-start, #a78bfa)',
            background: 'var(--color-pro-glow, rgba(167,139,250,0.1))',
            border: '1px solid var(--color-pro-border, rgba(167,139,250,0.25))',
            borderRadius: 9999,
            textDecoration: 'none',
            fontWeight: 500,
          }}
        >
          <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="var(--color-pro-gradient-start, #a78bfa)"
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
