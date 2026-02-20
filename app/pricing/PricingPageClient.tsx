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

const PRICING = {
  monthly: { price: 12.99, original: 15 },
  yearly: { price: 99, original: 155.88 },
}

/* Helper: t() returns the key itself when missing — treat that as a miss */
function resolved(value: string, key: string, fallback: string): string {
  return value === key ? fallback : value
}

export default function PricingPageClient() {
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
                  -33%
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
                <s style={{ opacity: 0.6 }}>${currentPrice.original.toFixed(2)}</s>
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
              background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 30%, transparent)',
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
      </div>
      <MobileBottomNav />
    </div>
  )
}
