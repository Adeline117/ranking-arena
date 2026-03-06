'use client'

import { useState } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

const CheckIcon = ({ size = 16, color }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M20 6L9 17L4 12" />
  </svg>
)

const LockIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

const PRICING = {
  monthly: { price: 4.99, original: null },
  yearly: { price: 29.99, original: 59.88 },
  lifetime: { price: 49.99, spots: 200 },
}

/* Helper: t() returns the key itself when missing — treat that as a miss */
function resolved(value: string, key: string, fallback: string): string {
  return value === key ? fallback : value
}

interface PricingPageClientProps {
  lifetimeCount?: number
}

export default function PricingPageClient({ lifetimeCount = 0 }: PricingPageClientProps) {
  const { email } = useAuthSession()
  const { t, language: locale } = useLanguage()
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('yearly')

  const features = [
    resolved(t('featureCategoryRanking'), 'featureCategoryRanking', 'Category Rankings'),
    resolved(t('featureTraderAlerts'), 'featureTraderAlerts', 'Trader Alerts'),
    resolved(t('featureScoreBreakdown'), 'featureScoreBreakdown', 'Arena Score Details'),
    resolved(t('featureProBadge'), 'featureProBadge', 'Pro Badge'),
    resolved(t('featureAdvancedFilter'), 'featureAdvancedFilter', 'Advanced Filters'),
    resolved(t('featureTraderCompare'), 'featureTraderCompare', 'Trader Comparison'),
    resolved(t('featureProGroups'), 'featureProGroups', 'Pro Groups'),
  ]

  const freeFeatures = [
    resolved(t('freeFeatureRankings'), 'freeFeatureRankings', 'Basic Rankings'),
    resolved(t('freeFeaturePosts'), 'freeFeaturePosts', 'Community Posts'),
    resolved(t('freeFeatureGroups'), 'freeFeatureGroups', 'Public Groups'),
    resolved(t('freeFeatureLibrary'), 'freeFeatureLibrary', 'Library Access'),
  ]

  const currentPrice = PRICING[billing]
  const yearlySavings = Math.round((1 - (PRICING.yearly.price / 12) / PRICING.monthly.price) * 100)
  const ctaHref = email ? '/user-center?tab=membership' : '/login'

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <div style={{ maxWidth: 960, margin: '0 auto', padding: `${tokens.spacing[10]} ${tokens.spacing[6]}`, textAlign: 'center' }}>
        {/* Header */}
        <h1 style={{ fontSize: 40, fontWeight: 800, marginBottom: tokens.spacing[3], letterSpacing: '-0.02em' }}>
          {resolved(t('pricingTitle'), 'pricingTitle', 'Upgrade to Pro')}
        </h1>
        <p style={{ fontSize: 17, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[8], lineHeight: 1.5 }}>
          {resolved(t('pricingSubtitle'), 'pricingSubtitle', 'Unlock all premium features')}
        </p>

        {/* Billing toggle */}
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: tokens.radius.lg, background: tokens.colors.bg.secondary, marginBottom: tokens.spacing[10] }}>
          {(['monthly', 'yearly'] as const).map(b => (
            <button
              key={b}
              onClick={() => setBilling(b)}
              style={{
                padding: '10px 24px',
                borderRadius: tokens.radius.md,
                border: 'none',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: 14,
                background: billing === b ? tokens.colors.accent.brand : 'transparent',
                color: billing === b ? '#fff' : tokens.colors.text.secondary,
                transition: 'all 0.2s',
              }}
            >
              {b === 'monthly'
                ? resolved(t('monthly'), 'monthly', 'Monthly')
                : resolved(t('yearly'), 'yearly', 'Yearly')}
              {b === 'yearly' && (
                <span style={{
                  marginLeft: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  color: billing === b ? '#ffd700' : tokens.colors.accent.brand,
                }}>
                  -{yearlySavings}%
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Plans grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacing[8], maxWidth: 720, margin: '0 auto', alignItems: 'stretch', overflow: 'visible' }}>
          {/* Free Plan */}
          <div style={{
            padding: tokens.spacing[8],
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
            textAlign: 'left',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: tokens.spacing[2], color: tokens.colors.text.secondary }}>Free</h3>
            <p style={{ fontSize: 40, fontWeight: 800, marginBottom: tokens.spacing[6], letterSpacing: '-0.02em' }}>
              $0<span style={{ fontSize: 15, fontWeight: 400, color: tokens.colors.text.secondary }}>/mo</span>
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1 }}>
              {freeFeatures.map(f => (
                <li key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', fontSize: 14, color: tokens.colors.text.secondary }}>
                  <CheckIcon size={15} /> {f}
                </li>
              ))}
              {features.map(f => (
                <li key={`locked-${f}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', fontSize: 14, color: tokens.colors.text.tertiary, opacity: 0.55 }}>
                  <LockIcon size={14} /> {f}
                </li>
              ))}
            </ul>
            <Link
              href={ctaHref}
              style={{
                display: 'block',
                padding: '14px 0',
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                textAlign: 'center',
                color: tokens.colors.text.primary,
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: 15,
                marginTop: tokens.spacing[6],
                transition: 'all 0.2s',
              }}
            >
              {email
                ? resolved(t('currentPlan'), 'currentPlan', 'Current Plan')
                : resolved(t('getStarted'), 'getStarted', 'Get Started')}
            </Link>
          </div>

          {/* Pro Plan */}
          <div style={{
            padding: tokens.spacing[8],
            paddingTop: tokens.spacing[10],
            borderRadius: tokens.radius.lg,
            border: `2px solid ${tokens.colors.accent.brand}`,
            background: tokens.colors.bg.secondary,
            textAlign: 'left',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            marginTop: 4,
          }}>
            {/* Badge */}
            <div style={{
              position: 'absolute',
              top: -13,
              left: '50%',
              transform: 'translateX(-50%)',
              background: tokens.colors.accent.brand,
              color: '#fff',
              padding: '5px 18px',
              borderRadius: tokens.radius.full,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
            }}>
              {resolved(t('mostPopular'), 'mostPopular', 'MOST POPULAR')}
            </div>

            <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: tokens.spacing[2] }}>Pro</h3>
            <p style={{ fontSize: 44, fontWeight: 800, marginBottom: 0, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              ${billing === 'yearly' ? (currentPrice.price / 12).toFixed(2) : currentPrice.price}
              <span style={{ fontSize: 15, fontWeight: 400, color: tokens.colors.text.secondary }}>/mo</span>
            </p>
            {billing === 'yearly' && (
              <p style={{ fontSize: 13, color: tokens.colors.text.secondary, marginTop: 6, marginBottom: tokens.spacing[6] }}>
                ${currentPrice.price}/year{' '}
                {'original' in currentPrice && currentPrice.original ? <s style={{ opacity: 0.6 }}>${currentPrice.original.toFixed(2)}</s> : null}
              </p>
            )}
            {billing === 'monthly' && <div style={{ marginBottom: tokens.spacing[6] }} />}

            <ul style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1 }}>
              {features.map(f => (
                <li key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', fontSize: 14, color: tokens.colors.text.primary }}>
                  <CheckIcon size={15} color={tokens.colors.accent.brand} /> {f}
                </li>
              ))}
            </ul>

            <Link
              href={ctaHref}
              style={{
                display: 'block',
                padding: '14px 0',
                borderRadius: tokens.radius.md,
                background: tokens.colors.accent.brand,
                textAlign: 'center',
                color: '#fff',
                textDecoration: 'none',
                fontWeight: 700,
                fontSize: 15,
                marginTop: tokens.spacing[6],
                transition: 'all 0.2s',
                boxShadow: '0 4px 14px color-mix(in srgb, var(--color-brand) 35%, transparent)',
              }}
            >
              {email
                ? resolved(t('upgradeToPro'), 'upgradeToPro', 'Upgrade to Pro')
                : resolved(t('signUpForPro'), 'signUpForPro', 'Sign Up for Pro')}
            </Link>

            <div style={{
              marginTop: tokens.spacing[4],
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: 'color-mix(in srgb, var(--color-accent-primary) 8%, var(--color-bg-secondary))',
              border: '1px solid color-mix(in srgb, var(--color-accent-primary) 20%, transparent)',
              borderRadius: 8,
              fontSize: 13,
              color: 'var(--color-text-secondary)',
              textAlign: 'center' as const,
            }}>
              {locale === 'zh'
                ? '当前为测试环境（Sandbox），支付功能尚未正式上线，请勿使用真实信用卡。'
                : 'Currently in Sandbox mode. Payment is not live yet — do not use real credit cards.'}
            </div>
          </div>
        </div>

        {/* Founding Member Lifetime Card */}
        <div style={{ maxWidth: 720, margin: `${tokens.spacing[6]} auto 0`, padding: `0 ${tokens.spacing[0]}` }}>
          <div style={{
            padding: tokens.spacing[8],
            borderRadius: tokens.radius.lg,
            border: '2px solid #f59e0b',
            background: 'color-mix(in srgb, #f59e0b 6%, var(--color-bg-secondary))',
            position: 'relative',
            textAlign: 'left',
          }}>
            {/* Badge */}
            <div style={{
              position: 'absolute',
              top: -13,
              left: '50%',
              transform: 'translateX(-50%)',
              background: '#f59e0b',
              color: '#fff',
              padding: '5px 18px',
              borderRadius: tokens.radius.full,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
            }}>
              {locale === 'zh' ? '创始会员 · 仅限前200名' : 'FOUNDING MEMBER · FIRST 200 ONLY'}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 24 }}>
              <div style={{ flex: 1 }}>
                <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6, color: '#f59e0b' }}>
                  {locale === 'zh' ? '终身会员' : 'Lifetime Pro'}
                </h3>
                <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginBottom: 0, lineHeight: 1.6 }}>
                  {locale === 'zh'
                    ? '一次付款，永久享有所有 Pro 功能。价格以后不会再有，早期用户专属。'
                    : 'One-time payment. All Pro features, forever. This price will never be available again.'}
                </p>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <p style={{ fontSize: 44, fontWeight: 800, marginBottom: 0, letterSpacing: '-0.02em', color: '#f59e0b', lineHeight: 1.1 }}>
                  ${PRICING.lifetime.price}
                </p>
                <p style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginTop: 2 }}>
                  {locale === 'zh' ? '一次性 · 永久有效' : 'one-time · forever'}
                </p>
              </div>
            </div>

            {/* Founding member progress bar */}
            {(() => {
              const TOTAL_SPOTS = 200
              const taken = Math.min(lifetimeCount, TOTAL_SPOTS)
              const remaining = TOTAL_SPOTS - taken
              const pct = Math.max(2, (taken / TOTAL_SPOTS) * 100)
              return (
                <div style={{ marginTop: tokens.spacing[6] }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#f59e0b' }}>
                      {taken} / {TOTAL_SPOTS} spots taken
                    </span>
                    <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                      {remaining} remaining
                    </span>
                  </div>
                  <div style={{
                    height: 6,
                    borderRadius: 999,
                    background: 'color-mix(in srgb, #f59e0b 18%, var(--color-bg-primary))',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${pct}%`,
                      borderRadius: 999,
                      background: 'linear-gradient(90deg, #f59e0b, #fbbf24)',
                      transition: 'width 0.6s ease',
                    }} />
                  </div>
                </div>
              )
            })()}

            <Link
              href={ctaHref}
              style={{
                display: 'block',
                padding: '14px 0',
                borderRadius: tokens.radius.md,
                background: '#f59e0b',
                textAlign: 'center',
                color: '#fff',
                textDecoration: 'none',
                fontWeight: 700,
                fontSize: 15,
                marginTop: tokens.spacing[6],
                transition: 'all 0.2s',
                boxShadow: '0 4px 14px rgba(245, 158, 11, 0.3)',
              }}
            >
              {locale === 'zh' ? '立即成为创始会员' : 'Get Founding Member Access'}
            </Link>
          </div>
        </div>
      </div>
      <MobileBottomNav />
    </div>
  )
}
