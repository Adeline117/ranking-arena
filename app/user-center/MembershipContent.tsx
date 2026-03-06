'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePremium, FEATURE_LIMITS } from '@/lib/premium/hooks'
import { ButtonSpinner } from '@/app/components/ui/LoadingSpinner'
import { useToast } from '@/app/components/ui/Toast'
import { logger } from '@/lib/logger'
import { Box, Text, Button } from '@/app/components/base'
import { supabase } from '@/lib/supabase/client'
import { getCsrfHeaders } from '@/lib/api/client'

// Icons
const CheckIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17L4 12" />
  </svg>
)

const CrownIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z" />
  </svg>
)

const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M18 6L6 18M6 6L18 18" />
  </svg>
)

// Pricing config
const PRICING = {
  monthly: { price: 4.99, original: null as number | null },
  yearly: { price: 29.99, original: 59.88 },
  lifetime: { price: 49.99, spots: 200 },
}

// Pro features list
const getProFeatures = (t: (key: string) => string) => [
  { key: 'category_ranking', title: t('featureCategoryRanking'), desc: t('featureCategoryRankingDesc') },
  { key: 'trader_alerts', title: t('featureTraderAlerts'), desc: t('featureTraderAlertsDesc') },
  { key: 'score_breakdown', title: t('featureScoreBreakdown'), desc: t('featureScoreBreakdownDesc') },
  { key: 'pro_badge', title: t('featureProBadge'), desc: t('featureProBadgeDesc') },
  { key: 'advanced_filter', title: t('featureAdvancedFilter'), desc: t('featureAdvancedFilterDesc') },
  { key: 'trader_compare', title: t('featureTraderCompare'), desc: t('featureTraderCompareDesc') },
  { key: 'pro_groups', title: t('featureProGroups'), desc: t('featureProGroupsDesc') },
  { key: 'historical_data', title: t('featureHistoricalData'), desc: t('featureHistoricalDataDesc') },
]

// Comparison data
const getComparisonData = (t: (key: string) => string) => [
  { feature: t('compFeatureLeaderboard'), free: t('compFreeTop50'), pro: t('compProFullLeaderboard') },
  { feature: t('compFeatureBasicFilters'), free: true, pro: true },
  { feature: t('compFeatureTraderDetails'), free: true, pro: true },
  { feature: t('compFeatureAdvancedFilters'), free: false, pro: t('compProMultiFilter') },
  { feature: t('compFeatureRealtimeData'), free: t('compFreeHourlyRefresh'), pro: t('compProRealtimePush') },
  { feature: t('compFeatureTraderCompare'), free: false, pro: t('compProUpTo10Traders') },
  { feature: t('compFeatureTraderAlerts'), free: false, pro: t('compProInAppEmailPush') },
  { feature: t('compFeatureArenaScore'), free: t('compFreeTotalScore'), pro: t('compProBreakdownPercentile') },
  { feature: t('compFeatureHistoricalData'), free: t('compFree7Days'), pro: t('compPro1Year') },
  { feature: t('compFeatureProBadgeGroups'), free: false, pro: true },
]

// FAQ data
const getFaqData = (t: (key: string) => string) => [
  { q: t('faqCancelQ'), a: t('faqCancelA') },
  { q: t('faqPaymentQ'), a: t('faqPaymentA') },
  { q: t('faqRefundQ'), a: t('faqRefundA') },
  { q: t('faqSwitchPlanQ'), a: t('faqSwitchPlanA') },
]

interface MembershipInfo {
  subscription: {
    tier: 'free' | 'pro'
    status: string
    plan?: string
    currentPeriodEnd?: string
    cancelAtPeriodEnd?: boolean
  } | null
  nft: {
    hasNft: boolean
    tokenId?: string
    walletAddress?: string
    expiresAt?: string
  } | null
  usage: {
    followedTraders: number
    apiCallsToday: number
  }
}

export default function MembershipContent() {
  const { t, language } = useLanguage()
  const router = useRouter()
  const { showToast } = useToast()
  const { getAuthHeadersAsync } = useAuthSession()
  const { isPremium: isPro } = usePremium()

  const [info, setInfo] = useState<MembershipInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedPlan, setSelectedPlan] = useState<'monthly' | 'yearly' | 'lifetime'>('yearly')
  const [subscribing, setSubscribing] = useState(false)

  useEffect(() => {
    fetchMembershipInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function fetchMembershipInfo() {
    try {
      const headers = await getAuthHeadersAsync()

      const [subRes, nftRes, usageRes] = await Promise.all([
        fetch('/api/subscription', { headers }),
        fetch('/api/membership/nft', { headers }),
        fetch('/api/user/usage', { headers }),
      ])

      const subData = subRes.ok ? await subRes.json() : null
      const nftData = nftRes.ok ? await nftRes.json() : null
      const usageData = usageRes.ok ? await usageRes.json() : { followedTraders: 0, apiCallsToday: 0 }

      setInfo({
        subscription: subData?.subscription || null,
        nft: nftData || null,
        usage: usageData,
      })
    } catch (err) {
      logger.error('Failed to fetch membership info:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleSubscribe = async () => {
    setSubscribing(true)
    try {
      let { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        const { data: refreshed } = await supabase.auth.refreshSession()
        session = refreshed.session
      }
      if (!session?.access_token) {
        showToast(t('pleaseLoginAgain'), 'error')
        router.push('/login?redirect=/user-center?tab=membership')
        return
      }

      const response = await fetch('/api/stripe/create-checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          plan: selectedPlan,
          successUrl: `${window.location.origin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${window.location.origin}/user-center?tab=membership`,
        }),
      })

      if (!response.ok) {
        let errorMsg = t('createCheckoutFailed')
        try {
          const errorData = await response.json()
          errorMsg = errorData.error || errorMsg
        } catch {
          errorMsg = `${errorMsg} (${response.status})`
        }
        showToast(errorMsg, 'error')
        return
      }

      const data = await response.json()
      if (data.url) {
        window.location.href = data.url
      } else if (data.error) {
        showToast(data.error, 'error')
      } else {
        showToast(t('getPaymentLinkFailed'), 'error')
      }
    } catch {
      showToast(t('subscriptionFailed'), 'error')
    } finally {
      setSubscribing(false)
    }
  }

  if (loading) {
    return (
      <div style={{
        minHeight: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <ButtonSpinner size="md" />
      </div>
    )
  }

  const tierLabel = isPro ? 'Pro' : 'Free'
  const tierColor = isPro ? tokens.colors.accent.brand : tokens.colors.text.tertiary
  const yearlySavings = Math.round((1 - (PRICING.yearly.price / 12) / PRICING.monthly.price) * 100)

  const cardStyle: React.CSSProperties = {
    background: tokens.colors.bg.tertiary,
    border: `1px solid ${tokens.colors.border.primary}`,
    borderRadius: tokens.radius.xl,
    padding: 24,
    marginBottom: 24,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Current Plan Status */}
      <div style={cardStyle}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 16,
          marginBottom: info?.subscription ? 16 : 0,
        }}>
          <div>
            <div style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginBottom: 4 }}>
              {t('currentPlan')}
            </div>
            <div style={{
              fontSize: 28,
              fontWeight: 900,
              color: tierColor,
            }}>
              {tierLabel}
            </div>
          </div>
        </div>

        {/* Expiry Warning */}
        {info?.subscription?.currentPeriodEnd && (() => {
          const daysUntilExpiry = Math.ceil((new Date(info.subscription!.currentPeriodEnd!).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          if (daysUntilExpiry <= 7 && daysUntilExpiry > 0 && info.subscription!.cancelAtPeriodEnd) {
            return (
              <div style={{
                padding: '12px 16px',
                background: `${tokens.colors.accent.warning}15`,
                border: `1px solid ${tokens.colors.accent.warning}40`,
                borderRadius: tokens.radius.lg,
                marginBottom: 16,
                fontSize: 14,
                color: tokens.colors.accent.warning,
                fontWeight: 600,
              }}>
                {t('proExpiryWarning').replace('{days}', String(daysUntilExpiry))}
              </div>
            )
          }
          return null
        })()}

        {/* Subscription Details */}
        {info?.subscription && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 16,
            paddingTop: 16,
            borderTop: `1px solid ${tokens.colors.border.primary}`,
          }}>
            <div>
              <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                {t('subscriptionStatusLabel')}
              </div>
              <div style={{ fontWeight: 600, marginTop: 4, color: tokens.colors.text.primary }}>
                {info.subscription.status === 'active' ? t('statusActive') :
                  info.subscription.status === 'canceled' ? t('statusCanceled') :
                    info.subscription.status === 'past_due' ? t('statusPastDue') : info.subscription.status}
              </div>
            </div>
            {info.subscription.plan && (
              <div>
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                  {t('billingCycle')}
                </div>
                <div style={{ fontWeight: 600, marginTop: 4, color: tokens.colors.text.primary }}>
                  {info.subscription.plan === 'yearly' ? t('yearlyPrice') : t('monthlyPrice')}
                </div>
              </div>
            )}
            {info.subscription.currentPeriodEnd && (
              <div>
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                  {info.subscription.cancelAtPeriodEnd ? t('expiresLabel') : t('nextRenewal')}
                </div>
                <div style={{ fontWeight: 600, marginTop: 4, color: tokens.colors.text.primary }}>
                  {new Date(info.subscription.currentPeriodEnd).toLocaleDateString(
                    language === 'zh' ? 'zh-CN' : 'en-US'
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Upgrade to Pro — only shown for free users */}
      {!isPro && (
        <div style={{
          ...cardStyle,
          border: '1px solid var(--color-pro-glow)',
          background: `linear-gradient(135deg, ${tokens.colors.bg.tertiary} 0%, ${tokens.colors.bg.secondary} 100%)`,
        }}>
          {/* Header */}
          <Box style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: tokens.spacing[5],
          }}>
            <Box style={{ color: 'var(--color-pro-gradient-start)' }}>
              <CrownIcon size={20} />
            </Box>
            <Text size="lg" weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
              {t('pricingTitle')}
            </Text>
          </Box>

          <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[5], lineHeight: 1.6 }}>
            {t('pricingDescription')}
          </Text>

          {/* Plan Selector */}
          <Box style={{ marginBottom: tokens.spacing[5] }}>
            {/* Monthly */}
            <Box
              onClick={() => setSelectedPlan('monthly')}
              style={{
                padding: tokens.spacing[4],
                borderRadius: tokens.radius.lg,
                border: `2px solid ${selectedPlan === 'monthly' ? 'var(--color-pro-gradient-start)' : 'var(--color-border-primary)'}`,
                background: selectedPlan === 'monthly' ? 'var(--color-pro-glow)' : 'transparent',
                cursor: 'pointer',
                transition: 'all 0.2s',
                marginBottom: tokens.spacing[3],
              }}
            >
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Box>
                  <Text size="sm" weight="bold">{t('monthlyPlan')}</Text>
                  <Text size="xs" color="tertiary">{t('monthlySubscription')}</Text>
                </Box>
                <Box style={{ textAlign: 'right' }}>
                  <Text size="xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                    ${PRICING.monthly.price}
                  </Text>
                  <Text size="xs" color="tertiary">{t('perMonth')}</Text>
                </Box>
              </Box>
            </Box>

            {/* Yearly */}
            <Box
              onClick={() => setSelectedPlan('yearly')}
              style={{
                padding: tokens.spacing[4],
                borderRadius: tokens.radius.lg,
                border: `2px solid ${selectedPlan === 'yearly' ? 'var(--color-pro-gradient-start)' : 'var(--color-border-primary)'}`,
                background: selectedPlan === 'yearly' ? 'var(--color-pro-glow)' : 'transparent',
                cursor: 'pointer',
                transition: 'all 0.2s',
                position: 'relative',
              }}
            >
              <Box
                style={{
                  position: 'absolute',
                  top: -8,
                  right: 12,
                  padding: '2px 8px',
                  background: 'var(--color-accent-success)',
                  borderRadius: tokens.radius.full,
                  fontSize: 10,
                  fontWeight: 700,
                  color: tokens.colors.white,
                }}
              >
                {t('savePercent').replace('{percent}', String(yearlySavings))}
              </Box>

              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Box>
                  <Text size="sm" weight="bold">{t('yearlyPlan')}</Text>
                  <Text size="xs" color="tertiary">{t('bestValue')}</Text>
                </Box>
                <Box style={{ textAlign: 'right' }}>
                  <Box style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                    <Text size="xs" style={{ textDecoration: 'line-through', color: 'var(--color-text-tertiary)' }}>
                      ${PRICING.yearly.original}
                    </Text>
                    <Text size="xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                      ${PRICING.yearly.price}
                    </Text>
                  </Box>
                  <Text size="xs" color="tertiary">
                    {t('approxPerMonth').replace('{price}', (PRICING.yearly.price / 12).toFixed(1))}
                  </Text>
                </Box>
              </Box>
            </Box>
            {/* Lifetime */}
            <Box
              onClick={() => setSelectedPlan('lifetime')}
              style={{
                padding: tokens.spacing[4],
                borderRadius: tokens.radius.lg,
                border: `2px solid ${selectedPlan === 'lifetime' ? '#f59e0b' : 'var(--color-border-primary)'}`,
                background: selectedPlan === 'lifetime' ? 'color-mix(in srgb, #f59e0b 8%, transparent)' : 'transparent',
                cursor: 'pointer',
                transition: 'all 0.2s',
                position: 'relative',
                marginTop: tokens.spacing[3],
              }}
            >
              <Box
                style={{
                  position: 'absolute',
                  top: -8,
                  right: 12,
                  padding: '2px 8px',
                  background: '#f59e0b',
                  borderRadius: tokens.radius.full,
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#451a03',
                }}
              >
                {t('membershipLifetimeSpots').replace('{spots}', String(PRICING.lifetime.spots))}
              </Box>

              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Box>
                  <Text size="sm" weight="bold" style={{ color: '#f59e0b' }}>{isZh ? '创始会员终身' : 'Founding Member Lifetime'}</Text>
                  <Text size="xs" color="tertiary">{isZh ? '一次付款 · 永久有效' : 'One-time · Forever'}</Text>
                </Box>
                <Box style={{ textAlign: 'right' }}>
                  <Text size="xl" weight="black" style={{ color: '#f59e0b' }}>
                    ${PRICING.lifetime.price}
                  </Text>
                  <Text size="xs" color="tertiary">{isZh ? '一次性' : 'one-time'}</Text>
                </Box>
              </Box>
            </Box>
          </Box>

          {/* Subscribe Button */}
          <Button
            variant="primary"
            onClick={handleSubscribe}
            disabled={subscribing}
            style={{
              width: '100%',
              padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
              background: selectedPlan === 'lifetime' ? '#f59e0b' : 'var(--color-pro-badge-bg)',
              border: 'none',
              boxShadow: selectedPlan === 'lifetime' ? '0 4px 16px rgba(245,158,11,0.3)' : '0 4px 16px var(--color-pro-badge-shadow)',
              fontSize: tokens.typography.fontSize.md,
              fontWeight: 700,
            }}
          >
            {subscribing
              ? t('processing')
              : selectedPlan === 'lifetime'
                ? (isZh ? `立即成为创始会员 - $${PRICING.lifetime.price}` : `Get Founding Access - $${PRICING.lifetime.price}`)
                : `${t('startSubscription')} - $${selectedPlan === 'yearly' ? PRICING.yearly.price : PRICING.monthly.price}`}
          </Button>

          <Box style={{ marginTop: tokens.spacing[3], textAlign: 'center' }}>
            <Text size="xs" color="tertiary" style={{ lineHeight: 1.6 }}>
              {selectedPlan === 'lifetime'
                ? (isZh ? '一次付款，终身有效，价格以后不会再有' : 'One-time payment. Lifetime access. Price will not return.')
                : `${t('cancelAnytime')} · ${t('securePayment')}`}
            </Text>
          </Box>
        </div>
      )}

      {/* Pro Features (for free users) */}
      {!isPro && (
        <div style={cardStyle}>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[4], color: tokens.colors.text.primary }}>
            {t('proExclusiveFeatures')}
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {getProFeatures(t).map((feature, index) => (
              <Box
                key={index}
                style={{
                  display: 'flex',
                  gap: tokens.spacing[3],
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.lg,
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.secondary}`,
                }}
              >
                <Box
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: tokens.radius.md,
                    background: 'var(--color-pro-glow)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--color-pro-gradient-start)',
                    flexShrink: 0,
                  }}
                >
                  <CheckIcon size={14} />
                </Box>
                <Box>
                  <Text size="sm" weight="bold" style={{ marginBottom: 2 }}>
                    {feature.title}
                  </Text>
                  <Text size="xs" color="tertiary">
                    {feature.desc}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        </div>
      )}

      {/* NFT Membership */}
      {(info?.nft?.hasNft || isPro) && (
        <div style={cardStyle}>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
            {t('nftMembershipCard')}
          </h3>

          {info?.nft?.hasNft ? (
            <div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 12,
              }}>
                <div style={{
                  width: 56,
                  height: 56,
                  borderRadius: tokens.radius.lg,
                  background: `linear-gradient(135deg, ${tokens.colors.accent.brand}, ${tokens.colors.accent.success})`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: tokens.colors.white,
                  fontWeight: 700,
                  fontSize: 20,
                }}>
                  PRO
                </div>
                <div>
                  <div style={{ fontWeight: 700, color: tokens.colors.text.primary }}>Arena Pro NFT #{info.nft.tokenId}</div>
                  <div style={{ fontSize: 13, color: tokens.colors.text.secondary }}>
                    {info.nft.walletAddress?.slice(0, 6)}...{info.nft.walletAddress?.slice(-4)}
                  </div>
                </div>
              </div>
              {info.nft.expiresAt && (
                <div style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
                  {t('validUntil')} {new Date(info.nft.expiresAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US')}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: tokens.colors.text.tertiary }}>
              <p style={{ marginBottom: 12, fontSize: 14 }}>
                {t('proMintNft')}
              </p>
              <button
                onClick={() => router.push('/settings')}
                style={{
                  padding: '10px 20px',
                  background: tokens.colors.bg.hover,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.primary,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                {t('linkWallet')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Free vs Pro Comparison */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
          {t('freeVsProComparison')}
        </h3>

        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 14,
            minWidth: 360,
          }}>
            <thead>
              <tr>
                <th style={{
                  textAlign: 'left',
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `2px solid ${tokens.colors.border.primary}`,
                  color: tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 600,
                }}>
                  {t('feature')}
                </th>
                <th style={{
                  textAlign: 'center',
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `2px solid ${tokens.colors.border.primary}`,
                  color: tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 600,
                  width: 100,
                }}>
                  {t('free')}
                </th>
                <th style={{
                  textAlign: 'center',
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `2px solid ${tokens.colors.border.primary}`,
                  color: 'var(--color-pro-gradient-start)',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 700,
                  width: 100,
                }}>
                  {t('pro')}
                </th>
              </tr>
            </thead>
            <tbody>
              {getComparisonData(t).map((row, index) => (
                <tr key={index}>
                  <td style={{
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                    fontSize: tokens.typography.fontSize.sm,
                    color: tokens.colors.text.secondary,
                  }}>
                    {row.feature}
                  </td>
                  <td style={{
                    textAlign: 'center',
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                  }}>
                    {row.free === true ? (
                      <Box style={{ color: 'var(--color-accent-success)', display: 'inline-flex' }}>
                        <CheckIcon size={18} />
                      </Box>
                    ) : row.free === false ? (
                      <Box style={{ color: 'var(--color-text-tertiary)', display: 'inline-flex' }}>
                        <CloseIcon size={18} />
                      </Box>
                    ) : (
                      <Text size="sm" color="secondary">{row.free}</Text>
                    )}
                  </td>
                  <td style={{
                    textAlign: 'center',
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                    background: 'var(--color-pro-glow)',
                  }}>
                    {row.pro === true ? (
                      <Box style={{ color: 'var(--color-pro-gradient-start)', display: 'inline-flex' }}>
                        <CheckIcon size={18} />
                      </Box>
                    ) : (
                      <Text size="sm" weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
                        {row.pro}
                      </Text>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Usage Stats */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
          {t('usageStatsTitle')}
        </h3>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
        }}>
          <UsageStat
            label={t('followedTradersUsage')}
            value={info?.usage?.followedTraders || 0}
            max={isPro ? FEATURE_LIMITS.pro.maxFollows : FEATURE_LIMITS.free.maxFollows}
          />
        </div>
      </div>

      {/* FAQ (for free users) */}
      {!isPro && (
        <div style={cardStyle}>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[4], color: tokens.colors.text.primary }}>
            {t('faq')}
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {getFaqData(t).map((faq, index) => (
              <Box
                key={index}
                style={{
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.lg,
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.secondary}`,
                }}
              >
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                  {faq.q}
                </Text>
                <Text size="xs" color="secondary" style={{ lineHeight: 1.6 }}>
                  {faq.a}
                </Text>
              </Box>
            ))}
          </Box>

          <Box style={{ marginTop: tokens.spacing[4], textAlign: 'center' }}>
            <Text size="xs" color="tertiary">
              {t('haveMoreQuestions')}
              <Link
                href="/help"
                style={{
                  color: 'var(--color-pro-gradient-start)',
                  marginLeft: 4,
                  textDecoration: 'none',
                }}
              >
                {t('contactUs')}
              </Link>
            </Text>
          </Box>
        </div>
      )}

      {/* Subscription Management */}
      {isPro && (
        <div style={{ ...cardStyle, marginBottom: 0 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
            {t('manageSubscription')}
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <button
              onClick={async () => {
                try {
                  const headers = await getAuthHeadersAsync()
                  const res = await fetch('/api/stripe/portal', {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ returnUrl: `${window.location.origin}/user-center?tab=membership` }),
                  })
                  if (res.ok) {
                    const { url } = await res.json()
                    window.location.href = url
                  } else {
                    showToast(t('paymentSystemComingSoon'), 'error')
                  }
                } catch {
                  showToast(t('operationFailedTryAgain'), 'error')
                }
              }}
              style={{
                padding: '10px 20px',
                background: tokens.colors.accent.brand,
                border: 'none',
                borderRadius: tokens.radius.lg,
                color: tokens.colors.white,
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {t('changePlan')}
            </button>
            <button
              onClick={async () => {
                try {
                  const headers = await getAuthHeadersAsync()
                  const res = await fetch('/api/stripe/portal', {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ returnUrl: `${window.location.origin}/user-center?tab=membership` }),
                  })
                  if (res.ok) {
                    const { url } = await res.json()
                    window.location.href = url
                  } else {
                    showToast(t('paymentSystemComingSoon'), 'error')
                  }
                } catch {
                  showToast(t('operationFailedTryAgain'), 'error')
                }
              }}
              style={{
                padding: '10px 20px',
                background: 'transparent',
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.lg,
                color: tokens.colors.text.secondary,
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {t('billingHistory')}
            </button>
            {info?.subscription && !info.subscription.cancelAtPeriodEnd && (
              <button
                onClick={async () => {
                  if (!confirm(t('cancelSubscriptionConfirm'))) return
                  const headers = await getAuthHeadersAsync()
                  const res = await fetch('/api/stripe/portal', {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ returnUrl: `${window.location.origin}/user-center?tab=membership` }),
                  })
                  if (res.ok) {
                    const { url } = await res.json()
                    window.location.href = url
                  }
                }}
                style={{
                  padding: '10px 20px',
                  background: 'transparent',
                  border: `1px solid ${tokens.colors.accent.error}40`,
                  borderRadius: tokens.radius.lg,
                  color: tokens.colors.accent.error,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                {t('cancelSubscription')}
              </button>
            )}
            {info?.subscription?.cancelAtPeriodEnd && (
              <div style={{
                padding: '10px 20px',
                background: `${tokens.colors.accent.warning}15`,
                border: `1px solid ${tokens.colors.accent.warning}40`,
                borderRadius: tokens.radius.lg,
                color: tokens.colors.accent.warning,
                fontWeight: 600,
                fontSize: 14,
              }}>
                {t('subscriptionCancelAtEnd')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function UsageStat({ label, value, max }: { label: string; value: number; max: number }) {
  const percentage = Math.min((value / max) * 100, 100)
  const isHigh = percentage > 80

  return (
    <div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginBottom: 8,
        fontSize: 13,
      }}>
        <span style={{ color: tokens.colors.text.secondary }}>{label}</span>
        <span style={{ fontWeight: 600, color: tokens.colors.text.primary }}>{value} / {max}</span>
      </div>
      <div style={{
        height: 8,
        background: tokens.colors.bg.hover,
        borderRadius: tokens.radius.full,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${percentage}%`,
          background: isHigh ? tokens.colors.accent.warning : tokens.colors.accent.brand,
          borderRadius: tokens.radius.full,
          transition: 'width 0.3s ease',
        }} />
      </div>
    </div>
  )
}
