'use client'

import { useState } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

const CheckIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17L4 12" />
  </svg>
)

const PRICING = {
  monthly: { price: 12.99, original: 15 },
  yearly: { price: 99, original: 155.88 },
}

export default function PricingPageClient() {
  const { email } = useAuthSession()
  const { t } = useLanguage()
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('yearly')

  const features = [
    t('featureCategoryRanking') || 'Category Rankings',
    t('featureTraderAlerts') || 'Trader Alerts',
    t('featureScoreBreakdown') || 'Score Breakdown',
    t('featureProBadge') || 'Pro Badge',
    t('featureAdvancedFilter') || 'Advanced Filters',
    t('featureTraderCompare') || 'Trader Compare',
    t('featureProGroups') || 'Pro Groups',
  ]

  const freeFeatures = [
    t('freeFeatureRankings') || 'Basic Rankings',
    t('freeFeaturePosts') || 'Community Posts',
    t('freeFeatureGroups') || 'Public Groups',
    t('freeFeatureLibrary') || 'Library Access',
  ]

  const currentPrice = PRICING[billing]
  const ctaHref = email ? '/user-center?tab=membership' : '/login'

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <div style={{ maxWidth: 960, margin: '0 auto', padding: `${tokens.spacing[10]} ${tokens.spacing[6]}`, textAlign: 'center' }}>
        <h1 style={{ fontSize: 36, fontWeight: 800, marginBottom: tokens.spacing[3] }}>
          {t('pricingTitle') || 'Choose Your Plan'}
        </h1>
        <p style={{ fontSize: 16, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[8] }}>
          {t('pricingSubtitle') || 'Unlock the full power of Arena trading analytics'}
        </p>

        {/* Billing toggle */}
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: tokens.radius.lg, background: tokens.colors.bg.secondary, marginBottom: tokens.spacing[10] }}>
          {(['monthly', 'yearly'] as const).map(b => (
            <button
              key={b}
              onClick={() => setBilling(b)}
              style={{
                padding: '8px 20px',
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
              {b === 'monthly' ? (t('monthly') || 'Monthly') : (t('yearly') || 'Yearly')}
              {b === 'yearly' && <span style={{ marginLeft: 6, fontSize: 12, color: billing === b ? '#ffd700' : tokens.colors.accent.brand }}>-33%</span>}
            </button>
          ))}
        </div>

        {/* Plans */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacing[6], maxWidth: 700, margin: '0 auto' }}>
          {/* Free */}
          <div style={{
            padding: tokens.spacing[8],
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
            textAlign: 'left',
          }}>
            <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: tokens.spacing[2] }}>Free</h3>
            <p style={{ fontSize: 32, fontWeight: 800, marginBottom: tokens.spacing[6] }}>
              $0<span style={{ fontSize: 14, fontWeight: 400, color: tokens.colors.text.secondary }}>/mo</span>
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, marginBottom: tokens.spacing[6] }}>
              {freeFeatures.map(f => (
                <li key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 14, color: tokens.colors.text.secondary }}>
                  <CheckIcon size={14} /> {f}
                </li>
              ))}
            </ul>
            <Link
              href={ctaHref}
              style={{
                display: 'block',
                padding: '12px 0',
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                textAlign: 'center',
                color: tokens.colors.text.primary,
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              {email ? (t('currentPlan') || 'Current Plan') : (t('getStarted') || 'Get Started')}
            </Link>
          </div>

          {/* Pro */}
          <div style={{
            padding: tokens.spacing[8],
            borderRadius: tokens.radius.lg,
            border: `2px solid ${tokens.colors.accent.brand}`,
            background: tokens.colors.bg.secondary,
            textAlign: 'left',
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute',
              top: -12,
              left: '50%',
              transform: 'translateX(-50%)',
              background: tokens.colors.accent.brand,
              color: '#fff',
              padding: '4px 16px',
              borderRadius: tokens.radius.full,
              fontSize: 12,
              fontWeight: 700,
            }}>
              {t('mostPopular') || 'MOST POPULAR'}
            </div>
            <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: tokens.spacing[2] }}>Pro</h3>
            <p style={{ fontSize: 32, fontWeight: 800, marginBottom: 0 }}>
              ${billing === 'yearly' ? (currentPrice.price / 12).toFixed(2) : currentPrice.price}
              <span style={{ fontSize: 14, fontWeight: 400, color: tokens.colors.text.secondary }}>/mo</span>
            </p>
            {billing === 'yearly' && (
              <p style={{ fontSize: 13, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[6] }}>
                ${currentPrice.price}/year · <s>${currentPrice.original.toFixed(2)}</s>
              </p>
            )}
            {billing === 'monthly' && <div style={{ marginBottom: tokens.spacing[6] }} />}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, marginBottom: tokens.spacing[6] }}>
              {features.map(f => (
                <li key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 14, color: tokens.colors.text.primary }}>
                  <span style={{ color: tokens.colors.accent.brand }}><CheckIcon size={14} /></span> {f}
                </li>
              ))}
            </ul>
            <Link
              href={ctaHref}
              style={{
                display: 'block',
                padding: '12px 0',
                borderRadius: tokens.radius.md,
                background: tokens.colors.accent.brand,
                textAlign: 'center',
                color: '#fff',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              {email ? (t('upgradeToPro') || 'Upgrade to Pro') : (t('signUpForPro') || 'Sign Up for Pro')}
            </Link>
          </div>
        </div>
      </div>
      <MobileBottomNav />
    </div>
  )
}
