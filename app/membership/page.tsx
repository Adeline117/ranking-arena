'use client'

/**
 * 会员权益页面
 *
 * 显示:
 * - 当前订阅状态
 * - NFT 会员信息
 * - 权益对比
 * - 使用统计
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePremium, FEATURE_LIMITS } from '@/lib/premium/hooks'
import { ButtonSpinner } from '@/app/components/ui/LoadingSpinner'
import { useToast } from '@/app/components/ui/Toast'

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

export default function MembershipPage() {
  const { t, language } = useLanguage()
  const router = useRouter()
  const { showToast } = useToast()
  const { isLoggedIn, loading: authLoading, getAuthHeadersAsync } = useAuthSession()
  const { subscription, isPremium: isPro } = usePremium()

  const [info, setInfo] = useState<MembershipInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (authLoading) return

    if (!isLoggedIn) {
      router.push('/login?redirect=/membership')
      return
    }

    fetchMembershipInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, authLoading])

  async function fetchMembershipInfo() {
    try {
      const headers = await getAuthHeadersAsync()

      // Fetch subscription info
      const subRes = await fetch('/api/subscription', { headers })
      const subData = subRes.ok ? await subRes.json() : null

      // Fetch NFT info
      const nftRes = await fetch('/api/membership/nft', { headers })
      const nftData = nftRes.ok ? await nftRes.json() : null

      // Fetch usage stats
      const usageRes = await fetch('/api/user/usage', { headers })
      const usageData = usageRes.ok ? await usageRes.json() : { followedTraders: 0, apiCallsToday: 0 }

      setInfo({
        subscription: subData?.subscription || null,
        nft: nftData || null,
        usage: usageData,
      })
    } catch (err) {
      console.error('Failed to fetch membership info:', err)
    } finally {
      setLoading(false)
    }
  }

  if (authLoading || loading) {
    return (
      <div style={{
        minHeight: '60vh',
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

  return (
    <div style={{
      maxWidth: 800,
      margin: '0 auto',
      padding: '24px 16px',
    }}>
      {/* Header */}
      <h1 style={{
        fontSize: tokens.typography.fontSize['2xl'],
        fontWeight: tokens.typography.fontWeight.black,
        marginBottom: 8,
      }}>
        {t('membershipTitle')}
      </h1>
      <p style={{
        color: tokens.colors.text.secondary,
        marginBottom: 32,
      }}>
        {t('membershipSubtitle')}
      </p>

      {/* Current Status Card */}
      <div style={{
        background: tokens.glass.bg.light,
        border: tokens.glass.border.light,
        borderRadius: 16,
        padding: 24,
        marginBottom: 24,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}>
          <div>
            <div style={{ fontSize: 14, color: tokens.colors.text.tertiary, marginBottom: 4 }}>
              {t('currentPlan')}
            </div>
            <div style={{
              fontSize: 32,
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
                padding: '12px 24px',
                background: tokens.colors.accent.brand,
                color: tokens.colors.white,
                border: 'none',
                borderRadius: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {t('upgradeToPro')}
            </button>
          )}
        </div>

        {/* Subscription Details */}
        {info?.subscription && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 16,
            paddingTop: 16,
            borderTop: `1px solid ${tokens.colors.border.secondary}`,
          }}>
            <div>
              <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                {t('subscriptionStatus')}
              </div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>
                {info.subscription.status === 'active' ? t('subscriptionActive') :
                  info.subscription.status === 'canceled' ? t('subscriptionCanceled') :
                    info.subscription.status === 'past_due' ? t('subscriptionPastDue') : info.subscription.status}
              </div>
            </div>
            {info.subscription.plan && (
              <div>
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                  {t('billingCycle')}
                </div>
                <div style={{ fontWeight: 600, marginTop: 4 }}>
                  {info.subscription.plan === 'yearly' ? t('billingYearly') : t('billingMonthly')}
                </div>
              </div>
            )}
            {info.subscription.currentPeriodEnd && (
              <div>
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                  {info.subscription.cancelAtPeriodEnd ? t('expirationDate') : t('nextRenewal')}
                </div>
                <div style={{ fontWeight: 600, marginTop: 4 }}>
                  {new Date(info.subscription.currentPeriodEnd).toLocaleDateString(
                    language === 'zh' ? 'zh-CN' : 'en-US'
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* UF29: NFT Membership Card - only show when user has NFT or is Pro */}
      {(info?.nft?.hasNft || isPro) && (
        <div style={{
          background: tokens.glass.bg.light,
          border: tokens.glass.border.light,
          borderRadius: 16,
          padding: 24,
          marginBottom: 24,
        }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
            {t('nftMembershipCard')}
          </h2>

          {info?.nft?.hasNft ? (
            <div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 16,
              }}>
                <div style={{
                  width: 64,
                  height: 64,
                  borderRadius: 12,
                  background: `linear-gradient(135deg, ${tokens.colors.accent.brand}, ${tokens.colors.accent.success})`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 24,
                }}>
                  ✓
                </div>
                <div>
                  <div style={{ fontWeight: 700 }}>Arena Pro NFT #{info.nft.tokenId}</div>
                  <div style={{ fontSize: 13, color: tokens.colors.text.secondary }}>
                    {info.nft.walletAddress?.slice(0, 6)}...{info.nft.walletAddress?.slice(-4)}
                  </div>
                </div>
              </div>
              {info.nft.expiresAt && (
                <div style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
                  {t('nftValidUntil')} {new Date(info.nft.expiresAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: tokens.colors.text.tertiary }}>
              <p style={{ marginBottom: 12 }}>{t('nftNotMintedPro')}</p>
              <p style={{ fontSize: 13 }}>{t('nftLinkWalletHint')}</p>
              <button
                onClick={() => router.push('/settings')}
                style={{
                  marginTop: 12,
                  padding: '10px 20px',
                  background: tokens.glass.bg.medium,
                  border: tokens.glass.border.light,
                  borderRadius: 8,
                  color: tokens.colors.text.primary,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {t('nftLinkWallet')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Benefits Comparison */}
      <div style={{
        background: tokens.glass.bg.light,
        border: tokens.glass.border.light,
        borderRadius: 16,
        padding: 24,
        marginBottom: 24,
      }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
          {t('benefitsComparison')}
        </h2>

        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 14,
          }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: `1px solid ${tokens.colors.border.secondary}` }}>
                  {t('benefitFeature')}
                </th>
                <th style={{ textAlign: 'center', padding: '12px 8px', borderBottom: `1px solid ${tokens.colors.border.secondary}` }}>
                  Free
                </th>
                <th style={{
                  textAlign: 'center',
                  padding: '12px 8px',
                  borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                  color: tokens.colors.accent.brand,
                }}>
                  Pro
                </th>
              </tr>
            </thead>
            <tbody>
              <BenefitRow feature={language === 'zh' ? '关注交易员' : 'Follow Traders'} free={`${FEATURE_LIMITS.free.maxFollows} ${language === 'zh' ? '个' : ''}`} pro={`${FEATURE_LIMITS.pro.maxFollows} ${language === 'zh' ? '个' : ''}`} />
              <BenefitRow feature={language === 'zh' ? '历史数据' : 'Historical Data'} free={`${FEATURE_LIMITS.free.historicalDays} ${language === 'zh' ? '天' : 'days'}`} pro={`${FEATURE_LIMITS.pro.historicalDays} ${language === 'zh' ? '天' : 'days'}`} />
              <BenefitRow feature={language === 'zh' ? '排行榜浏览' : 'Rankings Browse'} free={language === 'zh' ? '基础排序' : 'Basic sort'} pro={language === 'zh' ? '全部排序+筛选' : 'All sorts + filters'} isPro />
              <BenefitRow feature={language === 'zh' ? '交易员变动提醒' : 'Trader Alerts'} free="--" pro={language === 'zh' ? '支持' : 'Supported'} isPro />
              <BenefitRow feature={language === 'zh' ? '交易员对比' : 'Trader Compare'} free={language === 'zh' ? '2人' : '2 traders'} pro={language === 'zh' ? '5人' : '5 traders'} isPro />
              <BenefitRow feature={language === 'zh' ? 'Arena Score 详情' : 'Arena Score Details'} free="--" pro={language === 'zh' ? '支持' : 'Supported'} isPro />
              <BenefitRow feature={language === 'zh' ? '交易所平台筛选' : 'Exchange Filter'} free="--" pro={language === 'zh' ? '支持' : 'Supported'} isPro />
              <BenefitRow feature={language === 'zh' ? '数据导出' : 'Data Export'} free="--" pro={language === 'zh' ? 'Top 10/50/100' : 'Top 10/50/100'} isPro />
              <BenefitRow feature={language === 'zh' ? 'API 访问' : 'API Access'} free="--" pro={`${FEATURE_LIMITS.pro.apiCallsPerDay} ${language === 'zh' ? '次/天' : '/day'}`} isPro />
              <BenefitRow feature={language === 'zh' ? '私聊消息' : 'Direct Messages'} free={language === 'zh' ? '基础' : 'Basic'} pro={language === 'zh' ? '无限制' : 'Unlimited'} isPro />
              <BenefitRow feature={language === 'zh' ? 'Pro 专属群组' : 'Pro Groups'} free="--" pro={language === 'zh' ? '支持' : 'Supported'} isPro />
              <BenefitRow feature={language === 'zh' ? 'NFT 会员证' : 'NFT Membership'} free="--" pro={language === 'zh' ? '支持' : 'Supported'} isPro />
            </tbody>
          </table>
        </div>
      </div>

      {/* Usage Stats */}
      <div style={{
        background: tokens.glass.bg.light,
        border: tokens.glass.border.light,
        borderRadius: 16,
        padding: 24,
      }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
          {t('usageStats')}
        </h2>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 16,
        }}>
          <UsageStat
            label={t('usageFollowedTraders')}
            value={info?.usage?.followedTraders || 0}
            max={isPro ? FEATURE_LIMITS.pro.maxFollows : FEATURE_LIMITS.free.maxFollows}
          />
          {isPro && (
            <UsageStat
              label={t('usageApiCallsToday')}
              value={info?.usage?.apiCallsToday || 0}
              max={FEATURE_LIMITS.pro.apiCallsPerDay}
            />
          )}
        </div>
      </div>

      {/* UF28: Subscription Management Actions */}
      {isPro && (
        <div style={{
          marginTop: 24,
          background: tokens.glass.bg.light,
          border: tokens.glass.border.light,
          borderRadius: 16,
          padding: 24,
        }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
            {t('manageSubscription')}
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {/* Manage / Change Plan */}
            <button
              onClick={async () => {
                try {
                  const headers = await getAuthHeadersAsync()
                  const res = await fetch('/api/stripe/portal', {
                    method: 'POST',
                    headers,
                  })
                  if (res.ok) {
                    const { url } = await res.json()
                    window.location.href = url
                  } else {
                    showToast(language === 'zh' ? '支付系统暂未开放，敬请期待' : 'Payment system coming soon', 'error')
                  }
                } catch {
                  showToast(language === 'zh' ? '操作失败，请稍后再试' : 'Failed, please try again', 'error')
                }
              }}
              style={{
                padding: '12px 24px',
                background: tokens.colors.accent.brand,
                border: 'none',
                borderRadius: 12,
                color: tokens.colors.white,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {language === 'zh' ? '升级/降级方案' : 'Change Plan'}
            </button>
            {/* Billing History */}
            <button
              onClick={async () => {
                try {
                  const headers = await getAuthHeadersAsync()
                  const res = await fetch('/api/stripe/portal', {
                    method: 'POST',
                    headers,
                  })
                  if (res.ok) {
                    const { url } = await res.json()
                    window.location.href = url + '/billing'
                  } else {
                    showToast(language === 'zh' ? '支付系统暂未开放，敬请期待' : 'Payment system coming soon', 'error')
                  }
                } catch {
                  showToast(language === 'zh' ? '操作失败，请稍后再试' : 'Failed, please try again', 'error')
                }
              }}
              style={{
                padding: '12px 24px',
                background: 'transparent',
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: 12,
                color: tokens.colors.text.secondary,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {language === 'zh' ? '账单历史' : 'Billing History'}
            </button>
            {/* Cancel */}
            {info?.subscription && !info.subscription.cancelAtPeriodEnd && (
              <button
                onClick={async () => {
                  if (!confirm(language === 'zh' ? '确定要取消订阅吗？取消后将在当前周期结束时失效。' : 'Are you sure you want to cancel? Your subscription will remain active until the end of the current billing period.')) return
                  const headers = await getAuthHeadersAsync()
                  const res = await fetch('/api/stripe/portal', {
                    method: 'POST',
                    headers,
                  })
                  if (res.ok) {
                    const { url } = await res.json()
                    window.location.href = url
                  }
                }}
                style={{
                  padding: '12px 24px',
                  background: 'transparent',
                  border: `1px solid ${tokens.colors.accent.error}40`,
                  borderRadius: 12,
                  color: tokens.colors.accent.error,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {language === 'zh' ? '取消订阅' : 'Cancel Subscription'}
              </button>
            )}
            {info?.subscription?.cancelAtPeriodEnd && (
              <div style={{
                padding: '12px 24px',
                background: `${tokens.colors.accent.warning}15`,
                border: `1px solid ${tokens.colors.accent.warning}40`,
                borderRadius: 12,
                color: tokens.colors.accent.warning,
                fontWeight: 600,
              }}>
                {language === 'zh' ? '订阅将在到期后取消' : 'Subscription will cancel at period end'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function BenefitRow({ feature, free, pro, isPro = false }: {
  feature: string
  free: string
  pro: string
  isPro?: boolean
}) {
  return (
    <tr>
      <td style={{ padding: '12px 8px', borderBottom: `1px solid ${tokens.colors.border.secondary}` }}>
        {feature}
      </td>
      <td style={{
        textAlign: 'center',
        padding: '12px 8px',
        borderBottom: `1px solid ${tokens.colors.border.secondary}`,
        color: tokens.colors.text.tertiary,
      }}>
        {free}
      </td>
      <td style={{
        textAlign: 'center',
        padding: '12px 8px',
        borderBottom: `1px solid ${tokens.colors.border.secondary}`,
        color: isPro ? tokens.colors.accent.success : tokens.colors.text.primary,
        fontWeight: isPro ? 600 : 400,
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
        <span style={{ fontWeight: 600 }}>{value} / {max}</span>
      </div>
      <div style={{
        height: 8,
        background: tokens.colors.bg.tertiary,
        borderRadius: 4,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${percentage}%`,
          background: isHigh ? tokens.colors.accent.warning : tokens.colors.accent.brand,
          borderRadius: 4,
          transition: 'width 0.3s ease',
        }} />
      </div>
    </div>
  )
}
