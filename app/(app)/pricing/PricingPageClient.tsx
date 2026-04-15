'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { trackEvent } from '@/lib/analytics/track'

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
  const [billing, setBillingRaw] = useState<'monthly' | 'yearly'>(() => {
    // Persist billing selection across React re-mounts caused by Suspense/streaming
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('pricing-billing')
      if (saved === 'monthly' || saved === 'yearly') return saved
    }
    return 'yearly'
  })
  const setBilling = (b: 'monthly' | 'yearly') => {
    sessionStorage.setItem('pricing-billing', b)
    setBillingRaw(b)
  }

  useEffect(() => {
    trackEvent('view_pricing')
  }, [])

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
    resolved(t('freeFeatureMarket'), 'freeFeatureMarket', 'Market Overview'),
  ]

  const currentPrice = PRICING[billing]
  const yearlySavings = Math.round((1 - (PRICING.yearly.price / 12) / PRICING.monthly.price) * 100)
  const ctaHref = email ? '/user-center?tab=membership' : '/login'

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <div style={{ maxWidth: 960, margin: '0 auto', padding: `${tokens.spacing[10]} ${tokens.spacing[6]}`, textAlign: 'center' }}>
        {/* Header */}
        <h1 style={{ fontSize: 36, fontWeight: 800, marginBottom: tokens.spacing[3], letterSpacing: '-0.02em' }}>
          {resolved(t('pricingTitle'), 'pricingTitle', 'Upgrade to Pro')}
        </h1>
        <p style={{ fontSize: 17, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[6], lineHeight: 1.5 }}>
          {resolved(t('pricingSubtitle'), 'pricingSubtitle', 'Unlock all premium features')}
        </p>

        {/* Limited-time free banner — prominent top placement */}
        <div style={{
          maxWidth: 560,
          margin: `0 auto ${tokens.spacing[8]}`,
          padding: `${tokens.spacing[4]} ${tokens.spacing[6]}`,
          background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-accent-success, #16c784) 12%, var(--color-bg-secondary)) 0%, color-mix(in srgb, var(--color-accent-success, #16c784) 6%, var(--color-bg-secondary)) 100%)',
          border: '1px solid color-mix(in srgb, var(--color-accent-success, #16c784) 25%, transparent)',
          borderRadius: tokens.radius.lg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing[3],
        }}>
          <span style={{ fontSize: 18 }} aria-hidden="true">🎉</span>
          <span style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--color-accent-success, #16c784)',
            letterSpacing: '-0.01em',
          }}>
            {locale === 'zh'
              ? '限时优惠：所有 Pro 功能目前免费开放！'
              : 'Limited Time: All Pro features are currently free!'}
          </span>
        </div>

        {/* Social proof stats */}
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          gap: tokens.spacing[8],
          flexWrap: 'wrap',
          marginBottom: tokens.spacing[10],
        }}>
          {[
            { value: '34,000+', label: locale === 'zh' ? '\u4EA4\u6613\u5458\u5DF2\u6392\u540D' : 'Traders Ranked' },
            { value: '27+', label: locale === 'zh' ? '\u4EA4\u6613\u6240\u8986\u76D6' : 'Exchanges Tracked' },
            { value: '30min', label: locale === 'zh' ? '\u6570\u636E\u66F4\u65B0\u9891\u7387' : 'Update Frequency' },
          ].map((stat) => (
            <div key={stat.label} style={{ textAlign: 'center', minWidth: 120 }}>
              <div style={{
                fontSize: 28,
                fontWeight: 800,
                background: tokens.gradient.primary,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                letterSpacing: '-0.02em',
                lineHeight: 1.2,
              }}>
                {stat.value}
              </div>
              <div style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginTop: 4 }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>

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
                color: billing === b ? 'var(--color-on-accent, #fff)' : tokens.colors.text.secondary,
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
              onClick={() => trackEvent('click_upgrade_cta', { plan: 'free', billing })}
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

          {/* Pro Plan — elevated with shadow + scale */}
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
            transform: 'scale(1.03)',
            boxShadow: `0 20px 40px -15px rgba(139, 111, 168, 0.2), 0 0 0 1px ${tokens.colors.accent.brand}20`,
          }}>
            {/* Badge */}
            <div style={{
              position: 'absolute',
              top: -13,
              left: '50%',
              transform: 'translateX(-50%)',
              background: tokens.colors.accent.brand,
              color: 'var(--color-on-accent, #fff)',
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
              onClick={() => trackEvent('click_upgrade_cta', { plan: 'pro', billing })}
              style={{
                display: 'block',
                padding: '14px 0',
                borderRadius: tokens.radius.md,
                background: tokens.colors.accent.brand,
                textAlign: 'center',
                color: 'var(--color-on-accent, #fff)',
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
              background: 'color-mix(in srgb, var(--color-accent-success, #16c784) 8%, var(--color-bg-secondary))',
              border: '1px solid color-mix(in srgb, var(--color-accent-success, #16c784) 20%, transparent)',
              borderRadius: 8,
              fontSize: 13,
              color: 'var(--color-text-secondary)',
              textAlign: 'center' as const,
              fontWeight: 600,
            }}>
              {locale === 'zh'
                ? '所有功能限时免费'
                : 'All features are free for a limited time'}
            </div>
          </div>
        </div>

        {/* Founding Member Lifetime Card */}
        <div style={{ maxWidth: 720, margin: `${tokens.spacing[6]} auto 0`, padding: `0 ${tokens.spacing[0]}` }}>
          <div style={{
            padding: tokens.spacing[8],
            borderRadius: tokens.radius.lg,
            border: '2px solid var(--color-founding-accent)',
            background: 'color-mix(in srgb, var(--color-founding-accent) 6%, var(--color-bg-secondary))',
            position: 'relative',
            textAlign: 'left',
          }}>
            {/* Badge */}
            <div style={{
              position: 'absolute',
              top: -13,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--color-founding-accent)',
              color: 'var(--color-on-accent, #fff)',
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
                <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6, color: 'var(--color-founding-accent)' }}>
                  {locale === 'zh' ? '终身会员' : 'Lifetime Pro'}
                </h3>
                <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginBottom: 0, lineHeight: 1.6 }}>
                  {locale === 'zh'
                    ? '一次付款，永久享有所有 Pro 功能。价格以后不会再有，早期用户专属。'
                    : 'One-time payment. All Pro features, forever. This price will never be available again.'}
                </p>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <p style={{ fontSize: 44, fontWeight: 800, marginBottom: 0, letterSpacing: '-0.02em', color: 'var(--color-founding-accent)', lineHeight: 1.1 }}>
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
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-founding-accent)' }}>
                      {taken} / {TOTAL_SPOTS} spots taken
                    </span>
                    <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                      {remaining} remaining
                    </span>
                  </div>
                  <div style={{
                    height: 6,
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--color-founding-accent) 18%, var(--color-bg-primary))',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${pct}%`,
                      borderRadius: 999,
                      background: 'linear-gradient(90deg, var(--color-founding-accent), #fbbf24)',
                      transition: 'width 0.6s ease',
                    }} />
                  </div>
                </div>
              )
            })()}

            <Link
              href={ctaHref}
              onClick={() => trackEvent('click_upgrade_cta', { plan: 'lifetime' })}
              style={{
                display: 'block',
                padding: '14px 0',
                borderRadius: tokens.radius.md,
                background: 'var(--color-founding-accent)',
                textAlign: 'center',
                color: 'var(--color-on-accent, #fff)',
                textDecoration: 'none',
                fontWeight: 700,
                fontSize: 15,
                marginTop: tokens.spacing[6],
                transition: 'all 0.2s',
                boxShadow: '0 4px 14px var(--color-founding-accent-shadow)',
              }}
            >
              {locale === 'zh' ? '立即成为创始会员' : 'Get Founding Member Access'}
            </Link>
          </div>
        </div>
        {/* Feature Comparison Table */}
        <div style={{ maxWidth: 720, margin: `${tokens.spacing[10]} auto 0`, textAlign: 'left' }}>
          <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: tokens.spacing[6], textAlign: 'center' }}>
            {locale === 'zh' ? '功能对比' : 'Feature Comparison'}
          </h2>
          <div style={{
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
          }}>
            {/* Header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 80px 80px',
              minWidth: 360,
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
              background: tokens.colors.bg.tertiary,
              fontWeight: 700,
              fontSize: 13,
              color: tokens.colors.text.secondary,
            }}>
              <span>{locale === 'zh' ? '功能' : 'Feature'}</span>
              <span style={{ textAlign: 'center' }}>Free</span>
              <span style={{ textAlign: 'center', color: tokens.colors.accent.brand }}>Pro</span>
            </div>
            {/* Rows */}
            {[
              { feature: locale === 'zh' ? '交易员排行榜' : 'Trader Rankings', free: 'Top 100', pro: true },
              { feature: locale === 'zh' ? '高级筛选' : 'Advanced Filters', free: false, pro: true },
              { feature: locale === 'zh' ? 'Arena Score 详情' : 'Score Breakdown', free: false, pro: true },
              { feature: locale === 'zh' ? '交易员对比' : 'Trader Comparison', free: false, pro: true },
              { feature: locale === 'zh' ? '分类排行' : 'Category Rankings', free: false, pro: true },
              { feature: locale === 'zh' ? 'CSV 导出' : 'CSV Export', free: false, pro: true },
              { feature: locale === 'zh' ? '交易提醒' : 'Trader Alerts', free: false, pro: true },
              { feature: locale === 'zh' ? 'API 访问' : 'API Access', free: false, pro: true },
              { feature: locale === 'zh' ? '社区帖子' : 'Community Posts', free: true, pro: true },
              { feature: locale === 'zh' ? '资源库' : 'Library Access', free: true, pro: true },
              { feature: locale === 'zh' ? '公共群组' : 'Public Groups', free: true, pro: true },
              { feature: locale === 'zh' ? '市场概览' : 'Market Overview', free: true, pro: true },
            ].map((row, i) => (
              <div key={i} style={{
                display: 'grid',
                gridTemplateColumns: '1fr 80px 80px',
                minWidth: 360,
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                borderTop: `1px solid ${tokens.colors.border.primary}`,
                fontSize: 14,
                color: tokens.colors.text.primary,
              }}>
                <span>{row.feature}</span>
                <span style={{ textAlign: 'center', color: row.free === false ? tokens.colors.text.tertiary : tokens.colors.text.primary }}>
                  {row.free === true ? <CheckIcon size={16} color={tokens.colors.accent.success} /> : row.free === false ? '—' : <span style={{ fontSize: 12 }}>{row.free}</span>}
                </span>
                <span style={{ textAlign: 'center' }}>
                  {row.pro === true ? <CheckIcon size={16} color={tokens.colors.accent.brand} /> : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* What Pro Unlocks */}
        <div style={{ maxWidth: 720, margin: `${tokens.spacing[10]} auto 0`, textAlign: 'left' }}>
          <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: tokens.spacing[6], textAlign: 'center' }}>
            {resolved(t('pricingProUnlockTitle'), 'pricingProUnlockTitle', 'What Pro unlocks')}
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: tokens.spacing[4],
          }}>
            {[
              { text: resolved(t('pricingProDetailedAnalytics'), 'pricingProDetailedAnalytics', 'Detailed trader analytics & score breakdowns') },
              { text: resolved(t('pricingProAlerts'), 'pricingProAlerts', 'Real-time trader alerts & notifications') },
              { text: resolved(t('pricingProCsvExport'), 'pricingProCsvExport', 'CSV data export') },
              { text: resolved(t('pricingProAdvancedFilters'), 'pricingProAdvancedFilters', 'Advanced multi-condition filters') },
              { text: resolved(t('pricingProTraderCompare'), 'pricingProTraderCompare', 'Side-by-side trader comparison') },
              { text: resolved(t('pricingProPriority'), 'pricingProPriority', 'Priority support & early access to new features') },
              { text: resolved(t('pricingProApiAccess'), 'pricingProApiAccess', 'API access (coming soon)') },
            ].map((item) => (
              <div
                key={item.text}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                  padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                <CheckIcon size={16} color={tokens.colors.accent.brand} />
                <span style={{ fontSize: 14, color: tokens.colors.text.primary, lineHeight: 1.5 }}>
                  {item.text}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* FAQ Section */}
        <div style={{ maxWidth: 720, margin: `${tokens.spacing[10]} auto`, textAlign: 'left' }}>
          <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: tokens.spacing[6], textAlign: 'center' }}>
            FAQ
          </h2>
          {[
            {
              q: locale === 'zh' ? '可以随时取消吗？' : 'Can I cancel anytime?',
              a: locale === 'zh' ? '当然！月付用户可以随时取消，当期剩余时间仍然有效。' : 'Yes! Monthly subscribers can cancel anytime. You keep access until the end of your billing period.',
            },
            {
              q: locale === 'zh' ? '年付如何退款？' : 'What about refunds for yearly plans?',
              a: locale === 'zh' ? '年付用户在首7天内可以全额退款。' : 'Yearly subscribers can get a full refund within the first 7 days.',
            },
            {
              q: locale === 'zh' ? '终身会员是什么意思？' : 'What does Lifetime mean?',
              a: locale === 'zh' ? '一次付款，永久享有所有 Pro 功能。即使未来涨价或增加新功能，都自动包含。' : 'Pay once, access all Pro features forever. Includes all future features and price increases.',
            },
            {
              q: resolved(t('pricingFaqPaymentQ'), 'pricingFaqPaymentQ', 'What payment methods do you accept?'),
              a: resolved(t('pricingFaqPaymentA'), 'pricingFaqPaymentA', 'We accept all major credit cards, Apple Pay, and Google Pay via Stripe.'),
            },
            {
              q: resolved(t('pricingFaqTrialQ'), 'pricingFaqTrialQ', 'Is there a free trial?'),
              a: resolved(t('pricingFaqTrialA'), 'pricingFaqTrialA', 'The free tier gives you access to basic rankings and community features. Upgrade anytime to unlock Pro.'),
            },
            {
              q: resolved(t('pricingFaqSwitchQ'), 'pricingFaqSwitchQ', 'Can I switch plans?'),
              a: resolved(t('pricingFaqSwitchA'), 'pricingFaqSwitchA', 'Yes, you can switch between monthly and yearly anytime. We will prorate the difference.'),
            },
            {
              q: resolved(t('pricingFaqApiQ'), 'pricingFaqApiQ', 'Does Pro include API access?'),
              a: resolved(t('pricingFaqApiA'), 'pricingFaqApiA', 'API access is coming soon for Pro members. You will be the first to get access.'),
            },
          ].map((faq, i) => (
            <details key={i} style={{
              marginBottom: tokens.spacing[3],
              padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              cursor: 'pointer',
            }}>
              <summary style={{ fontWeight: 600, fontSize: 15, color: tokens.colors.text.primary, listStyle: 'none' }}>
                {faq.q}
              </summary>
              <p style={{ marginTop: tokens.spacing[3], fontSize: 14, color: tokens.colors.text.secondary, lineHeight: 1.6 }}>
                {faq.a}
              </p>
            </details>
          ))}
        </div>
      </div>
      {/* MobileBottomNav rendered in root layout */}
    </div>
  )
}
