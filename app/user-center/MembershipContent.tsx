'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePremium, FEATURE_LIMITS } from '@/lib/premium/hooks'
import { ButtonSpinner } from '@/app/components/ui/LoadingSpinner'
import { useToast } from '@/app/components/ui/Toast'
import { logger } from '@/lib/logger'

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
  const isZh = language === 'zh'
  const router = useRouter()
  const { showToast } = useToast()
  const { getAuthHeadersAsync } = useAuthSession()
  const { isPremium: isPro } = usePremium()

  const [info, setInfo] = useState<MembershipInfo | null>(null)
  const [loading, setLoading] = useState(true)

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

          {!isPro && (
            <button
              onClick={() => router.push('/pricing')}
              style={{
                padding: '12px 28px',
                background: tokens.colors.accent.brand,
                color: tokens.colors.white,
                border: 'none',
                borderRadius: tokens.radius.lg,
                fontWeight: 700,
                fontSize: 15,
                cursor: 'pointer',
              }}
            >
              {t('upgradePro')}
            </button>
          )}
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
                    isZh ? 'zh-CN' : 'en-US'
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

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

      {/* Benefits Comparison */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
          {t('benefitsComparison')}
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
                <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: `1px solid ${tokens.colors.border.primary}`, color: tokens.colors.text.secondary, fontWeight: 600 }}>
                  {t('featureLabel')}
                </th>
                <th style={{ textAlign: 'center', padding: '12px 8px', borderBottom: `1px solid ${tokens.colors.border.primary}`, color: tokens.colors.text.tertiary, fontWeight: 600 }}>
                  Free
                </th>
                <th style={{
                  textAlign: 'center',
                  padding: '12px 8px',
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  color: tokens.colors.accent.brand,
                  fontWeight: 700,
                }}>
                  Pro
                </th>
              </tr>
            </thead>
            <tbody>
              <BenefitRow feature={t('followTradersLabel')} free={`${FEATURE_LIMITS.free.maxFollows}`} pro={`${FEATURE_LIMITS.pro.maxFollows}`} />
              <BenefitRow feature={t('historicalDataLabel')} free={`${FEATURE_LIMITS.free.historicalDays} ${t('days')}`} pro={`${FEATURE_LIMITS.pro.historicalDays} ${t('days')}`} />
              <BenefitRow feature={t('rankingsBrowse')} free={t('basicSort')} pro={t('allSortsFilters')} highlight />
              <BenefitRow feature={t('traderAlerts')} free="--" pro={t('supportedYes')} highlight />
              <BenefitRow feature={t('traderCompare')} free={t('traderComparePeople').replace('{n}', '2')} pro={t('traderComparePeople').replace('{n}', '5')} highlight />
              <BenefitRow feature={t('scoreBreakdown')} free="--" pro={t('supportedYes')} highlight />
              <BenefitRow feature={t('exchangeFilterLabel')} free="--" pro={t('supportedYes')} highlight />
              <BenefitRow feature={t('dataExportLabel')} free="--" pro="Top 10/50/100" highlight />
              <BenefitRow feature={t('apiAccessLabel')} free="--" pro={`${FEATURE_LIMITS.pro.apiCallsPerDay}${t('callsPerDay')}`} highlight />
              <BenefitRow feature={t('directMessagesLabel')} free={t('basicLabel')} pro={t('unlimitedLabel')} highlight />
              <BenefitRow feature={t('proGroups')} free="--" pro={t('supportedYes')} highlight />
              <BenefitRow feature={t('nftMembershipLabel')} free="--" pro={t('supportedYes')} highlight />
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
          {isPro && (
            <UsageStat
              label={t('apiCallsTodayLabel')}
              value={info?.usage?.apiCallsToday || 0}
              max={FEATURE_LIMITS.pro.apiCallsPerDay}
            />
          )}
        </div>
      </div>

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
                  const res = await fetch('/api/stripe/portal', { method: 'POST', headers })
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
                  const res = await fetch('/api/stripe/portal', { method: 'POST', headers })
                  if (res.ok) {
                    const { url } = await res.json()
                    window.location.href = url + '/billing'
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
                  const res = await fetch('/api/stripe/portal', { method: 'POST', headers })
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

function BenefitRow({ feature, free, pro, highlight = false }: {
  feature: string
  free: string
  pro: string
  highlight?: boolean
}) {
  return (
    <tr>
      <td style={{ padding: '10px 8px', borderBottom: `1px solid ${tokens.colors.border.primary}`, color: tokens.colors.text.secondary, fontSize: 13 }}>
        {feature}
      </td>
      <td style={{
        textAlign: 'center',
        padding: '10px 8px',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        color: tokens.colors.text.tertiary,
        fontSize: 13,
      }}>
        {free}
      </td>
      <td style={{
        textAlign: 'center',
        padding: '10px 8px',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        color: highlight ? tokens.colors.accent.success : tokens.colors.text.primary,
        fontWeight: highlight ? 600 : 400,
        fontSize: 13,
      }}>
        {pro}
      </td>
    </tr>
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
