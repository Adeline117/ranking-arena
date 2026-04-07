'use client'

import { lazy, Suspense } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { t } from '@/lib/i18n'

const NumberTicker = lazy(() => import('../ui/NumberTicker'))

function formatCount(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K+`
  return `${n}+`
}

export interface HomeHeroProps {
  /** Total trader count from server */
  traderCount?: number
  /** Total exchange count from server */
  exchangeCount?: number
}

export default function HomeHero({ traderCount: traderCountProp, exchangeCount: exchangeCountProp }: HomeHeroProps) {
  useLanguage() // subscribe to language changes for re-render

  const traderNum = traderCountProp ?? 34000
  const exchangeNum = exchangeCountProp ?? 27
  const traderCountStr = formatCount(traderNum)
  const exchangeCountStr = `${exchangeNum}+`

  const subtitle = t('heroSubtitle' as Parameters<typeof t>[0])
    .replace('{exchanges}', exchangeCountStr.replace('+', ''))
    .replace('{traders}', traderCountStr)

  return (
    <section
      style={{
        padding: `${tokens.spacing[6]} ${tokens.spacing[6]} ${tokens.spacing[5]}`,
        marginBottom: tokens.spacing[3],
        background: 'linear-gradient(135deg, var(--color-accent-primary-08) 0%, transparent 60%, var(--color-accent-primary-05, rgba(139,111,168,0.05)) 100%)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary)',
        position: 'relative',
        overflow: 'hidden',
        minHeight: 120,
        contain: 'layout style',
      }}
    >
      {/* Subtle decorative gradient orb */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: -60,
          right: -40,
          width: 200,
          height: 200,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(139,111,168,0.12) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacing[6],
        flexWrap: 'wrap',
        position: 'relative',
        zIndex: 1,
      }}>
        {/* Left: Headline + subtitle */}
        <div style={{ flex: '1 1 400px', minWidth: 0 }}>
          <h1 style={{
            fontSize: 'clamp(18px, 2.5vw, 24px)',
            fontWeight: tokens.typography.fontWeight.black,
            color: 'var(--color-text-primary)',
            marginBottom: tokens.spacing[1],
            lineHeight: tokens.typography.lineHeight.tight,
          }}>
            {t('heroHeadline' as Parameters<typeof t>[0])}
          </h1>

          <p style={{
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-secondary)',
            lineHeight: tokens.typography.lineHeight.normal,
            margin: 0,
            maxWidth: 480,
          }}>
            {subtitle}
          </p>
        </div>

        {/* Right: Stats row */}
        <div style={{
          display: 'flex',
          gap: 'clamp(16px, 3vw, 32px)',
          flexShrink: 0,
        }}>
          {[
            { num: Math.floor(traderNum / 1000), suffix: 'K+', fallback: traderCountStr, label: t('heroStatTraders' as Parameters<typeof t>[0]), delay: 0 },
            { num: exchangeNum, suffix: '+', fallback: exchangeCountStr, label: t('heroStatExchanges' as Parameters<typeof t>[0]), delay: 0.2 },
            { num: 30, suffix: ' min', fallback: '30 min', label: t('heroStatUpdated' as Parameters<typeof t>[0]), delay: 0.4 },
          ].map((stat) => (
            <div key={stat.label} style={{ textAlign: 'center', minWidth: 56 }}>
              <div style={{
                fontSize: tokens.typography.fontSize.xl,
                fontWeight: tokens.typography.fontWeight.bold,
                color: 'var(--color-accent-primary)',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1.2,
                minHeight: '1.2em',
              }}>
                <Suspense fallback={<span>{stat.fallback}</span>}>
                  <NumberTicker value={stat.num} suffix={stat.suffix} delay={stat.delay} />
                </Suspense>
              </div>
              <div style={{
                fontSize: tokens.typography.fontSize.xs,
                color: 'var(--color-text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* CTA row: Explore Rankings + Pro badge */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
        marginTop: tokens.spacing[3],
        position: 'relative',
        zIndex: 1,
        flexWrap: 'wrap',
      }}>
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
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
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
          <svg width={12} height={12} viewBox="0 0 24 24" fill="var(--color-pro-gradient-start, #a78bfa)" style={{ flexShrink: 0 }}>
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
          </svg>
          <span className="shiny-text">{t('heroProBadge' as Parameters<typeof t>[0])}</span>
        </Link>
      </div>
    </section>
  )
}
