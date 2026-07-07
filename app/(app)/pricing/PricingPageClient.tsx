'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { tokens, alpha } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { trackEvent } from '@/lib/analytics/track'
import {
  PRICING,
  getPricingFaqData,
  getPricingComparisonData,
} from '@/app/(app)/user-center/membership-config'
import { useDirectCheckout } from '@/lib/hooks/useDirectCheckout'
import { useToast } from '@/app/components/ui/Toast'

const CheckIcon = ({ size = 16, color }: { size?: number; color?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color || 'currentColor'}
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    <path d="M20 6L9 17L4 12" />
  </svg>
)

const ChevronDownIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    <path d="M6 9L12 15L18 9" />
  </svg>
)

const LockIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

/* Helper: t() returns the key itself when missing — treat that as a miss */
function resolved(value: string, key: string, fallback: string): string {
  return value === key ? fallback : value
}

/* Compact trust strip rendered under checkout CTAs (Stripe / refund / cancel) */
function TrustStrip({ items }: { items: string[] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: tokens.spacing[3],
        marginTop: tokens.spacing[3],
      }}
    >
      {items.map((item, i) => (
        <span
          key={item}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: tokens.colors.text.tertiary,
          }}
        >
          {i === 0 ? (
            <LockIcon size={11} />
          ) : (
            <CheckIcon size={11} color={tokens.colors.accent.success} />
          )}
          {item}
        </span>
      ))}
    </div>
  )
}

interface PricingPageClientProps {
  lifetimeCount?: number
}

export default function PricingPageClient({ lifetimeCount = 0 }: PricingPageClientProps) {
  const { email } = useAuthSession()
  const { t } = useLanguage()
  const { showToast } = useToast()
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
  const [openFaqs, setOpenFaqs] = useState<Set<number>>(new Set())

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
  const yearlySavings = Math.round((1 - PRICING.yearly.price / 12 / PRICING.monthly.price) * 100)
  // Concrete dollar saving on the yearly plan vs paying monthly for 12 months
  const yearlySaveAmount = (PRICING.monthly.price * 12 - PRICING.yearly.price).toFixed(2)
  // How long Lifetime takes to pay for itself — computed against the currently
  // selected billing basis so the monthly view doesn't quote the yearly price.
  const monthlyRate = billing === 'yearly' ? PRICING.yearly.price / 12 : PRICING.monthly.price
  const lifetimePaybackMonths = Math.round(PRICING.lifetime.price / monthlyRate)
  const {
    checkout: directCheckout,
    isLoading: checkoutLoading,
    error: checkoutError,
    alreadySubscribed,
  } = useDirectCheckout()

  // Show toast when user is already subscribed — with link to manage
  useEffect(() => {
    if (alreadySubscribed) {
      showToast(
        resolved(
          t('alreadyProMember'),
          'alreadyProMember',
          'You already have an active Pro subscription! Go to Settings to manage it.'
        ),
        'success'
      )
    }
  }, [alreadySubscribed, showToast, t])

  // Show toast on checkout error (Stripe API failure, network error)
  useEffect(() => {
    if (checkoutError) {
      showToast(checkoutError, 'error')
    }
  }, [checkoutError, showToast])

  // Logged-in users go directly to Stripe checkout; anonymous users go to login
  // Already-subscribed users go to settings to manage their subscription
  const ctaHref = email ? (alreadySubscribed ? '/settings' : undefined) : '/login'
  const handleCta =
    email && !alreadySubscribed
      ? () => {
          trackEvent('click_upgrade_cta', { plan: billing })
          directCheckout(billing)
        }
      : undefined

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <div
        style={{
          maxWidth: 960,
          margin: '0 auto',
          padding: `${tokens.spacing[10]} ${tokens.spacing[6]}`,
          textAlign: 'center',
        }}
      >
        {/* Header */}
        <h1
          style={{
            fontSize: 'clamp(24px, 6vw, 36px)',
            fontWeight: 800,
            marginBottom: tokens.spacing[3],
            letterSpacing: '-0.02em',
          }}
        >
          {resolved(t('pricingTitle'), 'pricingTitle', 'Upgrade to Pro')}
        </h1>
        <p
          style={{
            fontSize: 17,
            color: tokens.colors.text.secondary,
            marginBottom: tokens.spacing[6],
            lineHeight: 1.5,
          }}
        >
          {resolved(t('pricingSubtitle'), 'pricingSubtitle', 'Unlock all premium features')}
        </p>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 16px',
            borderRadius: 20,
            background: 'var(--color-accent-primary-bg, rgba(59, 130, 246, 0.1))',
            color: 'var(--color-accent-primary)',
            fontSize: 14,
            fontWeight: 600,
            marginBottom: tokens.spacing[6],
          }}
        >
          {resolved(
            t('pricingTrialBadge'),
            'pricingTrialBadge',
            '7-day free trial on Pro monthly & yearly. Cancel anytime.'
          )}
        </div>

        {/* Founding member urgency banner */}
        <div
          style={{
            maxWidth: 560,
            margin: `0 auto ${tokens.spacing[8]}`,
            padding: `${tokens.spacing[4]} ${tokens.spacing[6]}`,
            background:
              'linear-gradient(135deg, color-mix(in srgb, var(--color-accent-primary, #3b82f6) 12%, var(--color-bg-secondary)) 0%, color-mix(in srgb, var(--color-accent-primary, #3b82f6) 6%, var(--color-bg-secondary)) 100%)',
            border:
              '1px solid color-mix(in srgb, var(--color-accent-primary, #3b82f6) 25%, transparent)',
            borderRadius: tokens.radius.lg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: tokens.spacing[3],
          }}
        >
          <span
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--color-accent-primary, #3b82f6)',
              letterSpacing: '-0.01em',
            }}
          >
            {resolved(
              t('pricingFoundingBanner'),
              'pricingFoundingBanner',
              'Founding Member Offer: Lifetime Pro for ${price} ({spots} spots only)'
            )
              .replace('{price}', String(PRICING.lifetime.price))
              .replace('{spots}', String(PRICING.lifetime.spots))}
          </span>
        </div>

        {/* Social proof stats */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: tokens.spacing[8],
            flexWrap: 'wrap',
            marginBottom: tokens.spacing[10],
          }}
        >
          {[
            {
              value: '8,000+',
              label: resolved(
                t('pricingStatTradersRanked'),
                'pricingStatTradersRanked',
                'Traders Ranked'
              ),
            },
            {
              value: '32+',
              label: resolved(
                t('pricingStatExchangesTracked'),
                'pricingStatExchangesTracked',
                'Exchanges Tracked'
              ),
            },
            {
              value: '30min',
              label: resolved(
                t('pricingStatUpdateFrequency'),
                'pricingStatUpdateFrequency',
                'Update Frequency'
              ),
            },
          ].map((stat) => (
            <div key={stat.label} style={{ textAlign: 'center', minWidth: 120 }}>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 800,
                  background: tokens.gradient.primary,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  letterSpacing: '-0.02em',
                  lineHeight: 1.2,
                }}
              >
                {stat.value}
              </div>
              <div style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginTop: 4 }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>

        {/* Billing toggle */}
        <div
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 4,
            borderRadius: tokens.radius.lg,
            background: tokens.colors.bg.secondary,
            marginBottom: tokens.spacing[10],
          }}
        >
          {(['monthly', 'yearly'] as const).map((b) => (
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
                color:
                  billing === b ? 'var(--color-on-accent, #fff)' : tokens.colors.text.secondary,
                transition: 'all 0.2s',
              }}
            >
              {b === 'monthly'
                ? resolved(t('monthly'), 'monthly', 'Monthly')
                : resolved(t('yearly'), 'yearly', 'Yearly')}
              {b === 'yearly' && (
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 12,
                    fontWeight: 700,
                    color: billing === b ? '#ffd700' : tokens.colors.accent.brand,
                  }}
                >
                  -{yearlySavings}%
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Plans grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: tokens.spacing[8],
            maxWidth: 720,
            margin: '0 auto',
            alignItems: 'stretch',
            overflow: 'visible',
          }}
        >
          {/* Free Plan */}
          <div
            style={{
              padding: tokens.spacing[8],
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <h3
              style={{
                fontSize: 20,
                fontWeight: 700,
                marginBottom: tokens.spacing[2],
                color: tokens.colors.text.secondary,
              }}
            >
              {resolved(t('pricingPlanFree'), 'pricingPlanFree', 'Free')}
            </h3>
            <p
              style={{
                fontSize: 40,
                fontWeight: 800,
                marginBottom: tokens.spacing[6],
                letterSpacing: '-0.02em',
              }}
            >
              $0
              <span style={{ fontSize: 15, fontWeight: 400, color: tokens.colors.text.secondary }}>
                /{resolved(t('perMonthShort'), 'perMonthShort', 'mo')}
              </span>
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1 }}>
              {freeFeatures.map((f) => (
                <li
                  key={f}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 0',
                    fontSize: 14,
                    color: tokens.colors.text.secondary,
                  }}
                >
                  <CheckIcon size={15} /> {f}
                </li>
              ))}
              {features.map((f) => (
                <li
                  key={`locked-${f}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 0',
                    fontSize: 14,
                    color: tokens.colors.text.tertiary,
                    opacity: 0.55,
                  }}
                >
                  <LockIcon size={14} /> {f}
                </li>
              ))}
            </ul>
            {email ? (
              // Free plan is the logged-in user's current tier — render a
              // non-interactive disabled label, not a dead <a href="#"> link.
              <span
                aria-disabled="true"
                style={{
                  display: 'block',
                  padding: '14px 0',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  textAlign: 'center',
                  color: tokens.colors.text.tertiary,
                  fontWeight: 600,
                  fontSize: 15,
                  marginTop: tokens.spacing[6],
                  cursor: 'default',
                  opacity: 0.7,
                }}
              >
                {resolved(t('currentPlan'), 'currentPlan', 'Current Plan')}
              </span>
            ) : (
              <Link
                href="/login"
                onClick={() => {
                  trackEvent('click_upgrade_cta', { plan: 'free', billing })
                }}
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
                {resolved(t('getStarted'), 'getStarted', 'Get Started')}
              </Link>
            )}
          </div>

          {/* Pro Plan — elevated with shadow + scale */}
          <div
            style={{
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
              boxShadow: `0 20px 40px -15px rgba(139, 111, 168, 0.2), 0 0 0 1px ${alpha(tokens.colors.accent.brand, 13)}`,
            }}
          >
            {/* Badge */}
            <div
              style={{
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
              }}
            >
              {resolved(t('mostPopular'), 'mostPopular', 'MOST POPULAR')}
            </div>

            <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: tokens.spacing[2] }}>Pro</h3>
            <p
              style={{
                fontSize: 44,
                fontWeight: 800,
                marginBottom: 0,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
              }}
            >
              ${billing === 'yearly' ? (currentPrice.price / 12).toFixed(2) : currentPrice.price}
              <span style={{ fontSize: 15, fontWeight: 400, color: tokens.colors.text.secondary }}>
                /
                {billing === 'yearly'
                  ? resolved(t('perMonthBilledYearly'), 'perMonthBilledYearly', 'mo')
                  : resolved(t('perMonthShort'), 'perMonthShort', 'mo')}
              </span>
            </p>
            {/* Lifetime anchor cue — surfaces lifetime value next to Pro */}
            <p
              style={{
                fontSize: 12,
                color: tokens.colors.text.tertiary,
                marginTop: 4,
                marginBottom: 0,
              }}
            >
              {(billing === 'yearly'
                ? resolved(
                    t('pricingLifetimeAnchor'),
                    'pricingLifetimeAnchor',
                    'Lifetime pays for itself in ~{months} months vs ${price}/yr'
                  ).replace('{price}', String(PRICING.yearly.price))
                : resolved(
                    t('pricingLifetimeAnchorMonthly'),
                    'pricingLifetimeAnchorMonthly',
                    'Lifetime pays for itself in ~{months} months vs ${price}/mo'
                  ).replace('{price}', String(PRICING.monthly.price))
              ).replace('{months}', String(lifetimePaybackMonths))}
            </p>
            {billing === 'yearly' && (
              <p
                style={{
                  fontSize: 13,
                  color: tokens.colors.text.secondary,
                  marginTop: 6,
                  marginBottom: tokens.spacing[6],
                }}
              >
                ${currentPrice.price}/{resolved(t('perYearShort'), 'perYearShort', 'year')}{' '}
                {'original' in currentPrice && currentPrice.original ? (
                  <s style={{ opacity: 0.6 }}>${currentPrice.original.toFixed(2)}</s>
                ) : null}{' '}
                <span style={{ color: tokens.colors.accent.success, fontWeight: 700 }}>
                  ·{' '}
                  {resolved(
                    t('pricingYearlySaveAmount'),
                    'pricingYearlySaveAmount',
                    'Save ${amount}/yr'
                  ).replace('{amount}', yearlySaveAmount)}
                </span>
              </p>
            )}
            {billing === 'monthly' && <div style={{ marginBottom: tokens.spacing[6] }} />}

            <ul style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1 }}>
              {features.map((f) => (
                <li
                  key={f}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 0',
                    fontSize: 14,
                    color: tokens.colors.text.primary,
                  }}
                >
                  <CheckIcon size={15} color={tokens.colors.accent.brand} /> {f}
                </li>
              ))}
            </ul>

            {/* Direct checkout for logged-in users; login redirect for anonymous */}
            {handleCta ? (
              <>
                <button
                  onClick={handleCta}
                  disabled={checkoutLoading}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '14px 0',
                    borderRadius: tokens.radius.md,
                    background: checkoutLoading
                      ? tokens.colors.bg.tertiary
                      : tokens.colors.accent.brand,
                    textAlign: 'center',
                    color: 'var(--color-on-accent, #fff)',
                    border: 'none',
                    fontWeight: 700,
                    fontSize: 15,
                    marginTop: tokens.spacing[6],
                    transition: 'all 0.2s',
                    boxShadow: '0 4px 14px color-mix(in srgb, var(--color-brand) 35%, transparent)',
                    cursor: checkoutLoading ? 'wait' : 'pointer',
                  }}
                >
                  {checkoutLoading
                    ? '...'
                    : resolved(t('upgradeToPro'), 'upgradeToPro', 'Upgrade to Pro')}
                </button>
                <button
                  onClick={() => {
                    trackEvent('click_free_trial', { plan: billing })
                    directCheckout(billing, { trial: true })
                  }}
                  disabled={checkoutLoading}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '12px 0',
                    borderRadius: tokens.radius.md,
                    background: 'transparent',
                    textAlign: 'center',
                    color: tokens.colors.accent.brand,
                    border: `1px solid ${tokens.colors.accent.brand}`,
                    fontWeight: 600,
                    fontSize: 14,
                    marginTop: tokens.spacing[3],
                    transition: 'all 0.2s',
                    cursor: checkoutLoading ? 'wait' : 'pointer',
                    opacity: checkoutLoading ? 0.5 : 1,
                  }}
                >
                  {resolved(t('startFreeTrial'), 'startFreeTrial', 'Start 7-Day Free Trial')}
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
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
                  {resolved(t('signUpForPro'), 'signUpForPro', 'Sign Up for Pro')}
                </Link>
                <Link
                  href="/login"
                  onClick={() => trackEvent('click_free_trial', { plan: billing })}
                  style={{
                    display: 'block',
                    padding: '12px 0',
                    borderRadius: tokens.radius.md,
                    background: 'transparent',
                    textAlign: 'center',
                    color: tokens.colors.accent.brand,
                    textDecoration: 'none',
                    border: `1px solid ${tokens.colors.accent.brand}`,
                    fontWeight: 600,
                    fontSize: 14,
                    marginTop: tokens.spacing[3],
                    transition: 'all 0.2s',
                  }}
                >
                  {resolved(t('startFreeTrial'), 'startFreeTrial', 'Start 7-Day Free Trial')}
                </Link>
              </>
            )}

            <p
              style={{
                fontSize: 12,
                color: tokens.colors.text.tertiary,
                textAlign: 'center',
                marginTop: tokens.spacing[2],
                marginBottom: 0,
              }}
            >
              {resolved(
                t('freeTrialDesc'),
                'freeTrialDesc',
                'Try all Pro features free for 7 days. Cancel anytime.'
              )}
            </p>

            <TrustStrip
              items={[
                resolved(
                  t('pricingTrustSecureCheckout'),
                  'pricingTrustSecureCheckout',
                  'Secure checkout by Stripe'
                ),
                resolved(
                  t('pricingTrustMoneyBack'),
                  'pricingTrustMoneyBack',
                  '7-day money-back guarantee'
                ),
                resolved(
                  t('pricingTrustCancelAnytime'),
                  'pricingTrustCancelAnytime',
                  'Cancel anytime'
                ),
              ]}
            />

            <div
              style={{
                marginTop: tokens.spacing[4],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                background:
                  'color-mix(in srgb, var(--color-accent-success, #16c784) 8%, var(--color-bg-secondary))',
                border:
                  '1px solid color-mix(in srgb, var(--color-accent-success, #16c784) 20%, transparent)',
                borderRadius: 8,
                fontSize: 13,
                color: 'var(--color-text-secondary)',
                textAlign: 'center' as const,
                fontWeight: 600,
              }}
            >
              {resolved(
                t('pricingAllFeaturesFree'),
                'pricingAllFeaturesFree',
                'Upgrade to Pro to unlock all features'
              )}
            </div>
          </div>
        </div>

        {/* Founding Member Lifetime Card */}
        <div
          style={{
            maxWidth: 720,
            margin: `${tokens.spacing[6]} auto 0`,
            padding: `0 ${tokens.spacing[0]}`,
          }}
        >
          <div
            style={{
              padding: tokens.spacing[8],
              borderRadius: tokens.radius.lg,
              border: '2px solid var(--color-founding-accent)',
              background:
                'color-mix(in srgb, var(--color-founding-accent) 6%, var(--color-bg-secondary))',
              position: 'relative',
              textAlign: 'left',
            }}
          >
            {/* Badge */}
            <div
              style={{
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
              }}
            >
              {resolved(
                t('pricingFoundingMemberBadge'),
                'pricingFoundingMemberBadge',
                'FOUNDING MEMBER \u00b7 FIRST 200 ONLY'
              )}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 24,
              }}
            >
              <div style={{ flex: 1 }}>
                <h3
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    marginBottom: 6,
                    color: 'var(--color-founding-accent)',
                  }}
                >
                  {resolved(t('pricingLifetimePro'), 'pricingLifetimePro', 'Lifetime Pro')}
                </h3>
                <p
                  style={{
                    fontSize: 14,
                    color: tokens.colors.text.secondary,
                    marginBottom: 0,
                    lineHeight: 1.6,
                  }}
                >
                  {resolved(
                    t('pricingLifetimeDesc'),
                    'pricingLifetimeDesc',
                    'One-time payment. All Pro features, forever. This price will never be available again.'
                  )}
                </p>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <p
                  style={{
                    fontSize: 44,
                    fontWeight: 800,
                    marginBottom: 0,
                    letterSpacing: '-0.02em',
                    color: 'var(--color-founding-accent)',
                    lineHeight: 1.1,
                  }}
                >
                  ${PRICING.lifetime.price}
                </p>
                <p style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginTop: 2 }}>
                  {resolved(
                    t('pricingLifetimeOneTime'),
                    'pricingLifetimeOneTime',
                    'one-time \u00b7 forever'
                  )}
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
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      marginBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: 'var(--color-founding-accent)',
                      }}
                    >
                      {resolved(
                        t('pricingSpotsTaken'),
                        'pricingSpotsTaken',
                        '{taken} / {total} spots taken'
                      )
                        .replace('{taken}', String(taken))
                        .replace('{total}', String(TOTAL_SPOTS))}
                    </span>
                    <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                      {resolved(
                        t('pricingSpotsRemaining'),
                        'pricingSpotsRemaining',
                        '{count} remaining'
                      ).replace('{count}', String(remaining))}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 6,
                      borderRadius: 999,
                      background:
                        'color-mix(in srgb, var(--color-founding-accent) 18%, var(--color-bg-primary))',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${pct}%`,
                        borderRadius: 999,
                        background: 'linear-gradient(90deg, var(--color-founding-accent), #fbbf24)',
                        transition: 'width 0.6s ease',
                      }}
                    />
                  </div>
                </div>
              )
            })()}

            {handleCta ? (
              <button
                onClick={() => {
                  trackEvent('click_upgrade_cta', { plan: 'lifetime' })
                  directCheckout('lifetime')
                }}
                disabled={checkoutLoading}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '14px 0',
                  borderRadius: tokens.radius.md,
                  background: checkoutLoading
                    ? tokens.colors.bg.tertiary
                    : 'var(--color-founding-accent)',
                  textAlign: 'center',
                  color: 'var(--color-on-accent, #fff)',
                  border: 'none',
                  fontWeight: 700,
                  fontSize: 15,
                  marginTop: tokens.spacing[6],
                  transition: 'all 0.2s',
                  boxShadow: '0 4px 14px var(--color-founding-accent-shadow)',
                  cursor: checkoutLoading ? 'wait' : 'pointer',
                }}
              >
                {checkoutLoading
                  ? '...'
                  : resolved(
                      t('pricingGetFoundingAccess'),
                      'pricingGetFoundingAccess',
                      'Get Founding Member Access'
                    )}
              </button>
            ) : (
              <Link
                href="/login"
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
                {resolved(
                  t('pricingGetFoundingAccess'),
                  'pricingGetFoundingAccess',
                  'Get Founding Member Access'
                )}
              </Link>
            )}

            <TrustStrip
              items={[
                resolved(
                  t('pricingTrustSecureCheckout'),
                  'pricingTrustSecureCheckout',
                  'Secure checkout by Stripe'
                ),
                // Money-back guarantee intentionally omitted for Lifetime: the
                // documented 7-day refund covers subscriptions, not the one-time
                // purchase. Don't surface an unverified refund claim.
              ]}
            />
          </div>
        </div>
        {/* Feature Comparison Table */}
        <div style={{ maxWidth: 720, margin: `${tokens.spacing[10]} auto 0`, textAlign: 'left' }}>
          <h2
            style={{
              fontSize: 24,
              fontWeight: 800,
              marginBottom: tokens.spacing[6],
              textAlign: 'center',
            }}
          >
            {resolved(
              t('pricingFeatureComparison'),
              'pricingFeatureComparison',
              'Feature Comparison'
            )}
          </h2>
          <div
            style={{
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              overflowX: 'auto',
            }}
          >
            {/* Header */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 80px 80px',
                minWidth: 360,
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                background: tokens.colors.bg.tertiary,
                fontWeight: 700,
                fontSize: 13,
                color: tokens.colors.text.secondary,
              }}
            >
              <span>{resolved(t('pricingFeatureHeader'), 'pricingFeatureHeader', 'Feature')}</span>
              <span style={{ textAlign: 'center' }}>
                {resolved(t('pricingPlanFree'), 'pricingPlanFree', 'Free')}
              </span>
              <span style={{ textAlign: 'center', color: tokens.colors.accent.brand }}>Pro</span>
            </div>
            {/* Rows — single source of truth: membership-config */}
            {getPricingComparisonData(t).map((row, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 80px 80px',
                  minWidth: 360,
                  padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                  borderTop: `1px solid ${tokens.colors.border.primary}`,
                  fontSize: 14,
                  color: tokens.colors.text.primary,
                }}
              >
                <span>{row.feature}</span>
                <span
                  style={{
                    textAlign: 'center',
                    color:
                      row.free === false ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                  }}
                >
                  {row.free === true ? (
                    <CheckIcon size={16} color={tokens.colors.accent.success} />
                  ) : row.free === false ? (
                    '—'
                  ) : (
                    <span style={{ fontSize: 12 }}>{row.free}</span>
                  )}
                </span>
                <span style={{ textAlign: 'center' }}>
                  {row.pro === true ? (
                    <CheckIcon size={16} color={tokens.colors.accent.brand} />
                  ) : (
                    '—'
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* What Pro Unlocks */}
        <div style={{ maxWidth: 720, margin: `${tokens.spacing[10]} auto 0`, textAlign: 'left' }}>
          <h2
            style={{
              fontSize: 24,
              fontWeight: 800,
              marginBottom: tokens.spacing[6],
              textAlign: 'center',
            }}
          >
            {resolved(t('pricingProUnlockTitle'), 'pricingProUnlockTitle', 'What Pro unlocks')}
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: tokens.spacing[4],
            }}
          >
            {[
              {
                text: resolved(
                  t('pricingProDetailedAnalytics'),
                  'pricingProDetailedAnalytics',
                  'Detailed trader analytics & score breakdowns'
                ),
              },
              {
                text: resolved(
                  t('pricingProAlerts'),
                  'pricingProAlerts',
                  'Real-time trader alerts & notifications'
                ),
              },
              {
                text: resolved(t('pricingProCsvExport'), 'pricingProCsvExport', 'CSV data export'),
              },
              {
                text: resolved(
                  t('pricingProAdvancedFilters'),
                  'pricingProAdvancedFilters',
                  'Advanced multi-condition filters'
                ),
              },
              {
                text: resolved(
                  t('pricingProTraderCompare'),
                  'pricingProTraderCompare',
                  'Side-by-side trader comparison'
                ),
              },
              {
                text: resolved(
                  t('pricingProPriority'),
                  'pricingProPriority',
                  'Priority support & early access to new features'
                ),
              },
              {
                text: resolved(
                  t('pricingProApiAccess'),
                  'pricingProApiAccess',
                  'API access (coming soon)'
                ),
              },
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
          <h2
            style={{
              fontSize: 24,
              fontWeight: 800,
              marginBottom: tokens.spacing[6],
              textAlign: 'center',
            }}
          >
            FAQ
          </h2>
          {getPricingFaqData(t).map((faq, i) => (
            <details
              key={i}
              onToggle={(e) => {
                // Capture `open` synchronously — React nulls out the synthetic
                // event's currentTarget before the setState updater runs, so
                // reading e.currentTarget inside the updater throws (crashes page).
                const isOpen = e.currentTarget.open
                setOpenFaqs((prev) => {
                  const next = new Set(prev)
                  if (isOpen) next.add(i)
                  else next.delete(i)
                  return next
                })
              }}
              style={{
                marginBottom: tokens.spacing[3],
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <summary
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: tokens.spacing[3],
                  padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
                  fontWeight: 600,
                  fontSize: 15,
                  color: tokens.colors.text.primary,
                  listStyle: 'none',
                  cursor: 'pointer',
                }}
              >
                <span>{faq.q}</span>
                <span
                  aria-hidden="true"
                  style={{
                    flexShrink: 0,
                    display: 'inline-flex',
                    color: tokens.colors.text.secondary,
                    transition: 'transform 0.2s ease',
                    transform: openFaqs.has(i) ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                >
                  <ChevronDownIcon size={16} />
                </span>
              </summary>
              <p
                style={{
                  margin: 0,
                  padding: `0 ${tokens.spacing[5]} ${tokens.spacing[4]}`,
                  fontSize: 14,
                  color: tokens.colors.text.secondary,
                  lineHeight: 1.6,
                }}
              >
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
