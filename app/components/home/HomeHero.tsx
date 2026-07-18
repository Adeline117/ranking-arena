'use client'

import { lazy, Suspense } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { t } from '@/lib/i18n'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { PRODUCT_FACTS } from '@/lib/config/product-facts'

const NumberTicker = lazy(() => import('../ui/NumberTicker'))

function formatCount(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K+`
  return `${n}+`
}

export interface HomeHeroProps {
  /** Total trader count from server */
  traderCount?: number
  /** Total live ranking source-board count from server */
  sourceBoardCount?: number
}

export default function HomeHero({
  traderCount: traderCountProp,
  sourceBoardCount: sourceBoardCountProp,
}: HomeHeroProps) {
  useLanguage() // subscribe to language changes for re-render

  const traderNum = traderCountProp ?? PRODUCT_FACTS.fallbackRankedTraderCount
  const sourceBoardNum = sourceBoardCountProp ?? PRODUCT_FACTS.fallbackSourceBoardCount
  const traderCountStr = formatCount(traderNum)
  const sourceBoardCountStr = `${sourceBoardNum}+`

  const subtitle = t('heroSubtitle' as Parameters<typeof t>[0])
    .replace('{exchanges}', sourceBoardCountStr.replace('+', ''))
    .replace('{traders}', traderCountStr)

  return (
    <section
      className="home-hero home-hero-client"
      style={{
        padding: `${tokens.spacing[10]} ${tokens.spacing[8]} ${tokens.spacing[8]}`,
        marginBottom: tokens.spacing[5],
        background:
          'linear-gradient(145deg, var(--color-bg-secondary) 0%, var(--color-bg-primary) 100%)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary)',
        position: 'relative',
        overflow: 'hidden',
        minHeight: 200,
        contain: 'layout style',
      }}
    >
      {/* Mesh gradient — layered orbs for depth */}
      <div
        className="home-hero-main"
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
          zIndex: tokens.zIndex.dropdown,
        }}
      >
        {/* Left: Headline + subtitle */}
        <div className="home-hero-copy" style={{ flex: '1 1 400px', minWidth: 0 }}>
          <h1
            className="home-hero-title"
            style={{
              fontSize: 'clamp(30px, 4.6vw, 48px)',
              fontWeight: tokens.typography.fontWeight.black,
              color: 'var(--color-text-primary)',
              marginBottom: tokens.spacing[3],
              lineHeight: 1.08,
              letterSpacing: '-0.03em',
            }}
          >
            {t('heroHeadline' as Parameters<typeof t>[0])}
          </h1>

          <p
            className="home-hero-subtitle"
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
          {/* Score legibility + neutrality — the cross-exchange percentile moat.
              True and not number-specific (no contested exchange count). */}
          <p
            className="home-hero-explainer"
            style={{
              fontSize: '0.875rem',
              color: 'var(--color-text-tertiary)',
              lineHeight: 1.55,
              margin: `${tokens.spacing[3]} 0 0`,
              maxWidth: 540,
            }}
          >
            {t('heroScoreExplainer' as Parameters<typeof t>[0])}{' '}
            {t('heroNeutrality' as Parameters<typeof t>[0])}
          </p>
        </div>

        {/* Right: Stats row */}
        <div
          className="home-hero-stats"
          style={{
            display: 'flex',
            gap: 'clamp(16px, 3vw, 32px)',
            flexShrink: 0,
          }}
        >
          {[
            {
              num: sourceBoardNum,
              suffix: '+',
              fallback: sourceBoardCountStr,
              label: t('heroStatExchanges' as Parameters<typeof t>[0]),
              delay: 0.2,
            },
            {
              num: PRODUCT_FACTS.leaderboardRefreshHours,
              suffix: 'h',
              fallback: `${PRODUCT_FACTS.leaderboardRefreshHours}h`,
              label: t('heroStatUpdated' as Parameters<typeof t>[0]),
              delay: 0.4,
            },
          ].map((stat) => (
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
                <Suspense fallback={<span>{stat.fallback}</span>}>
                  <NumberTicker value={stat.num} suffix={stat.suffix} delay={stat.delay} />
                </Suspense>
              </div>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--color-text-tertiary)',
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

      {/* CTA row: Explore Rankings + Get Started + Pro badge */}
      <div
        className="home-hero-actions"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          marginTop: tokens.spacing[3],
          position: 'relative',
          zIndex: tokens.zIndex.dropdown,
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={() => {
            const el = document.querySelector('.home-ranking-section')
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 20px',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: 700,
            color: '#fff',
            background: tokens.gradient.primary,
            border: 'none',
            borderRadius: tokens.radius.full,
            cursor: 'pointer',
            transition: tokens.transition.fast,
            minHeight: 44,
          }}
        >
          {t('heroExploreRankings' as Parameters<typeof t>[0])}
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
        <Link
          href="/login"
          prefetch={false}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 16px',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: 600,
            color: 'var(--color-accent-primary, #8B6FA8)',
            background: 'transparent',
            border: '1px solid var(--color-accent-primary, #8B6FA8)',
            borderRadius: tokens.radius.full,
            textDecoration: 'none',
            transition: tokens.transition.fast,
            minHeight: 36,
          }}
        >
          {t('heroCTASignUp' as Parameters<typeof t>[0])}
        </Link>
        <Link
          href="/pricing"
          prefetch={false}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            fontSize: tokens.typography.fontSize.xs,
            color: 'var(--color-pro-gradient-start, #a78bfa)',
            background: 'var(--color-pro-glow, rgba(167,139,250,0.1))',
            border: '1px solid var(--color-pro-border, rgba(167,139,250,0.25))',
            borderRadius: tokens.radius.full,
            textDecoration: 'none',
            transition: tokens.transition.fast,
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
          <span className="shiny-text">
            {t((PRO_FREE_PROMO ? 'heroProBadgePromo' : 'heroProBadge') as Parameters<typeof t>[0])}
          </span>
        </Link>
      </div>
    </section>
  )
}
