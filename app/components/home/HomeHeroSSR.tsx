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
import { getStaticTranslation } from '@/lib/i18n/server'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { PRODUCT_FACTS } from '@/lib/config/product-facts'

interface HomeHeroSSRProps {
  sourceBoardCount?: number
}

export default async function HomeHeroSSR({
  sourceBoardCount = PRODUCT_FACTS.fallbackSourceBoardCount,
}: HomeHeroSSRProps) {
  // 2026-07-12 ISR 根因修复:getServerTranslation 的 cookies() 把 `/` 判为动态
  // (revalidate=300 失效,宣传第一落点零边缘缓存)。静态壳固定英文,客户端
  // Phase 2 水合后换语言 —— 与本页"SSR 恒默认视图"决策一致。
  const { t } = getStaticTranslation()
  const sourceBoardCountStr = `${sourceBoardCount}+`

  const headline = t('heroHeadline')
  const subtitle = t('heroSubtitle').replace('{exchanges}', String(sourceBoardCount))

  // Trader-count stat intentionally dropped — the hero leads with exchange
  // coverage; the trader total lives in the leaderboard itself.
  const stats = [
    { value: sourceBoardCountStr, label: t('heroStatExchanges') },
    // Real cadence: the leaderboard recomputes every 2h (worker scheduler
    // SCORE_INTERVALS_MS). "30 min" overstated it (that's only the warm-cache
    // cron, which re-warms Redis but doesn't make data fresher) — a freshness
    // claim a savvy crypto user can disprove costs more trust than an honest one.
    {
      value: `${PRODUCT_FACTS.leaderboardRefreshHours}h`,
      label: t('heroStatUpdated'),
    },
  ]

  return (
    <section
      className="home-hero home-hero-ssr"
      style={{
        // Tighter vertical padding so the box hugs its content (heading +
        // subtitle + CTA) instead of leaving a large empty band below.
        padding: `${tokens.spacing[8]} ${tokens.spacing[8]} ${tokens.spacing[6]}`,
        marginBottom: tokens.spacing[5],
        background:
          'linear-gradient(145deg, var(--color-bg-secondary) 0%, var(--color-bg-primary) 100%)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
        position: 'relative',
        overflow: 'hidden',
        minHeight: 160,
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
        className="home-hero-main"
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
        <div className="home-hero-copy" style={{ flex: '1 1 400px', minWidth: 0 }}>
          {/* LCP element: this headline is the largest above-fold text in the SSR HTML */}
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
            {headline}
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
              fontSize: tokens.typography.fontSize.base,
              color: 'var(--color-text-tertiary)',
              lineHeight: 1.55,
              margin: `${tokens.spacing[3]} 0 0`,
              maxWidth: 540,
            }}
          >
            {t('heroScoreExplainer')} {t('heroNeutrality')}
          </p>
          {/* Trust affordance: put "how is this ranked / where's the data from"
              next to the hero, not buried in the footer — a first-time airdrop
              visitor judges credibility in seconds and should be able to inspect
              the methodology in one click. */}
          <Link
            className="home-hero-methodology"
            href="/methodology"
            style={{
              display: 'inline-block',
              marginTop: tokens.spacing[3],
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: 'var(--color-accent-primary)',
              textDecoration: 'none',
            }}
          >
            {t('heroHowRanked')}
          </Link>
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
        className="home-hero-actions"
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
            fontSize: tokens.typography.fontSize.sm,
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
            fontSize: tokens.typography.fontSize.xs,
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
          <span>{PRO_FREE_PROMO ? t('heroProBadgePromo') : t('heroProBadge')}</span>
        </Link>
      </div>
    </section>
  )
}
