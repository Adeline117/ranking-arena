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
 */

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'

interface HomeHeroSSRProps {
  traderCount?: number
  exchangeCount?: number
}

function formatCount(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K+`
  return `${n}+`
}

export default function HomeHeroSSR({ traderCount = 34000, exchangeCount = 27 }: HomeHeroSSRProps) {
  const traderCountStr = formatCount(traderCount)
  const exchangeCountStr = `${exchangeCount}+`

  const headline = "Track the World's Best Crypto Traders"
  const subtitle = `Real-time rankings across ${exchangeCount} exchanges. ${traderCountStr} traders ranked by Arena Score.`

  const stats = [
    { value: traderCountStr, label: 'Traders' },
    { value: exchangeCountStr, label: 'Exchanges' },
    { value: '30 min', label: 'Update Freq' },
  ]

  return (
    <section
      style={{
        padding: `${tokens.spacing[6]} ${tokens.spacing[6]} ${tokens.spacing[5]}`,
        marginBottom: tokens.spacing[3],
        background: 'linear-gradient(135deg, var(--color-accent-primary-08, rgba(139,111,168,0.08)) 0%, transparent 60%, var(--color-accent-primary-05, rgba(139,111,168,0.05)) 100%)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
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
          {/* LCP element: this headline is the largest above-fold text in the SSR HTML */}
          <h2 style={{
            fontSize: 'clamp(18px, 2.5vw, 24px)',
            fontWeight: 900,
            color: 'var(--color-text-primary, #fff)',
            marginBottom: tokens.spacing[1],
            lineHeight: 1.2,
          }}>
            {headline}
          </h2>
          <p style={{
            fontSize: '0.875rem',
            color: 'var(--color-text-secondary, rgba(255,255,255,0.7))',
            lineHeight: 1.5,
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
          {stats.map((stat) => (
            <div key={stat.label} style={{ textAlign: 'center', minWidth: 56 }}>
              <div style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: 'var(--color-accent-primary, #8B6FA8)',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1.2,
                minHeight: '1.2em',
              }}>
                {stat.value}
              </div>
              <div style={{
                fontSize: '0.75rem',
                color: 'var(--color-text-tertiary, rgba(255,255,255,0.45))',
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

      {/* Pro CTA badge */}
      <Link
        href="/pricing"
        prefetch={false}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginTop: tokens.spacing[3],
          padding: '4px 12px',
          fontSize: '0.75rem',
          color: 'var(--color-pro-gradient-start, #a78bfa)',
          background: 'var(--color-pro-glow, rgba(167,139,250,0.1))',
          border: '1px solid var(--color-pro-border, rgba(167,139,250,0.25))',
          borderRadius: 9999,
          textDecoration: 'none',
          position: 'relative',
          zIndex: 1,
          fontWeight: 500,
        }}
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="var(--color-pro-gradient-start, #a78bfa)" style={{ flexShrink: 0 }}>
          <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
        </svg>
        <span>Go Pro — Unlock All Traders &amp; Advanced Filters</span>
      </Link>
    </section>
  )
}
