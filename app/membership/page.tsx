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
        fontSize: 28,
        fontWeight: 900,
        marginBottom: 8,
      }}>
        {t('membershipTitle') || '会员中心'}
      </h1>
      <p style={{
        color: tokens.colors.text.secondary,
        marginBottom: 32,
      }}>
        {t('membershipSubtitle') || '管理您的订阅和查看会员权益'}
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
              {t('currentPlan') || '当前等级'}
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
                color: '#fff',
                border: 'none',
                borderRadius: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {t('upgradeToPro') || '升级 Pro'}
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
                {t('subscriptionStatus') || '订阅状态'}
              </div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>
                {info.subscription.status === 'active' ? '活跃' :
                  info.subscription.status === 'canceled' ? '已取消' :
                    info.subscription.status === 'past_due' ? '逾期' : info.subscription.status}
              </div>
            </div>
            {info.subscription.plan && (
              <div>
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                  {t('billingCycle') || '计费周期'}
                </div>
                <div style={{ fontWeight: 600, marginTop: 4 }}>
                  {info.subscription.plan === 'yearly' ? '年付' : '月付'}
                </div>
              </div>
            )}
            {info.subscription.currentPeriodEnd && (
              <div>
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                  {info.subscription.cancelAtPeriodEnd ? '到期日期' : '下次续费'}
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

      {/* NFT Membership Card */}
      <div style={{
        background: tokens.glass.bg.light,
        border: tokens.glass.border.light,
        borderRadius: 16,
        padding: 24,
        marginBottom: 24,
      }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
          NFT 会员证
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
                有效期至: {new Date(info.nft.expiresAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: tokens.colors.text.tertiary }}>
            {isPro ? (
              <div>
                <p style={{ marginBottom: 12 }}>您是 Pro 会员，但尚未铸造 NFT 会员证。</p>
                <p style={{ fontSize: 13 }}>链接钱包后将自动铸造 NFT 会员证明。</p>
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
                  链接钱包
                </button>
              </div>
            ) : (
              <p>升级 Pro 会员后可获得 NFT 会员证明。</p>
            )}
          </div>
        )}
      </div>

      {/* Benefits Comparison */}
      <div style={{
        background: tokens.glass.bg.light,
        border: tokens.glass.border.light,
        borderRadius: 16,
        padding: 24,
        marginBottom: 24,
      }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
          {t('benefitsComparison') || '权益对比'}
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
                  功能
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
              <BenefitRow feature="关注交易员" free={`${FEATURE_LIMITS.free.maxFollows} 个`} pro={`${FEATURE_LIMITS.pro.maxFollows} 个`} />
              <BenefitRow feature="历史数据" free={`${FEATURE_LIMITS.free.historicalDays} 天`} pro={`${FEATURE_LIMITS.pro.historicalDays} 天`} />
              <BenefitRow feature="交易员变动提醒" free="✗" pro="✓" isPro />
              <BenefitRow feature="交易员对比" free="有限制" pro="无限制" isPro />
              <BenefitRow feature="Arena Score 详情" free="✗" pro="✓" isPro />
              <BenefitRow feature="API 访问" free="✗" pro={`${FEATURE_LIMITS.pro.apiCallsPerDay} 次/天`} isPro />
              <BenefitRow feature="Pro 专属群组" free="✗" pro="✓" isPro />
              <BenefitRow feature="高级筛选" free="✗" pro="✓" isPro />
              <BenefitRow feature="NFT 会员证" free="✗" pro="✓" isPro />
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
          {t('usageStats') || '使用统计'}
        </h2>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 16,
        }}>
          <UsageStat
            label="已关注交易员"
            value={info?.usage?.followedTraders || 0}
            max={isPro ? FEATURE_LIMITS.pro.maxFollows : FEATURE_LIMITS.free.maxFollows}
          />
          {isPro && (
            <UsageStat
              label="今日 API 调用"
              value={info?.usage?.apiCallsToday || 0}
              max={FEATURE_LIMITS.pro.apiCallsPerDay}
            />
          )}
        </div>
      </div>

      {/* Manage Subscription Button */}
      {isPro && (
        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <button
            onClick={async () => {
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
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: 12,
              color: tokens.colors.text.secondary,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('manageSubscription') || '管理订阅'}
          </button>
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
