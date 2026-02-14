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
              {isZh ? '当前方案' : 'Current Plan'}
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
              {isZh ? '升级 Pro' : 'Upgrade to Pro'}
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
                {isZh
                  ? `Pro 会员将在 ${daysUntilExpiry} 天后到期，届时将降级为 Free 方案。`
                  : `Your Pro membership expires in ${daysUntilExpiry} day${daysUntilExpiry > 1 ? 's' : ''}. You will be downgraded to Free.`}
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
                {isZh ? '订阅状态' : 'Status'}
              </div>
              <div style={{ fontWeight: 600, marginTop: 4, color: tokens.colors.text.primary }}>
                {info.subscription.status === 'active' ? (isZh ? '已激活' : 'Active') :
                  info.subscription.status === 'canceled' ? (isZh ? '已取消' : 'Canceled') :
                    info.subscription.status === 'past_due' ? (isZh ? '逾期' : 'Past Due') : info.subscription.status}
              </div>
            </div>
            {info.subscription.plan && (
              <div>
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                  {isZh ? '计费周期' : 'Billing Cycle'}
                </div>
                <div style={{ fontWeight: 600, marginTop: 4, color: tokens.colors.text.primary }}>
                  {info.subscription.plan === 'yearly' ? (isZh ? '年付' : 'Yearly') : (isZh ? '月付' : 'Monthly')}
                </div>
              </div>
            )}
            {info.subscription.currentPeriodEnd && (
              <div>
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                  {info.subscription.cancelAtPeriodEnd ? (isZh ? '到期日' : 'Expires') : (isZh ? '下次续费' : 'Next Renewal')}
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

      {/* NFT Membership - only show when relevant */}
      {(info?.nft?.hasNft || isPro) && (
        <div style={cardStyle}>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
            {isZh ? 'NFT 会员证' : 'NFT Membership Card'}
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
                  {isZh ? '有效期至' : 'Valid until'} {new Date(info.nft.expiresAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US')}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: tokens.colors.text.tertiary }}>
              <p style={{ marginBottom: 12, fontSize: 14 }}>
                {isZh ? 'Pro 会员可铸造专属 NFT 会员证' : 'Pro members can mint an exclusive NFT membership card'}
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
                {isZh ? '绑定钱包' : 'Link Wallet'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Benefits Comparison */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
          {isZh ? '权益对比' : 'Benefits Comparison'}
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
                  {isZh ? '功能' : 'Feature'}
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
              <BenefitRow feature={isZh ? '关注交易员' : 'Follow Traders'} free={`${FEATURE_LIMITS.free.maxFollows}`} pro={`${FEATURE_LIMITS.pro.maxFollows}`} />
              <BenefitRow feature={isZh ? '历史数据' : 'Historical Data'} free={`${FEATURE_LIMITS.free.historicalDays} ${isZh ? '天' : 'days'}`} pro={`${FEATURE_LIMITS.pro.historicalDays} ${isZh ? '天' : 'days'}`} />
              <BenefitRow feature={isZh ? '排行榜浏览' : 'Rankings Browse'} free={isZh ? '基础排序' : 'Basic sort'} pro={isZh ? '全部排序+筛选' : 'All sorts + filters'} highlight />
              <BenefitRow feature={isZh ? '交易员变动提醒' : 'Trader Alerts'} free="--" pro={isZh ? '支持' : 'Yes'} highlight />
              <BenefitRow feature={isZh ? '交易员对比' : 'Trader Compare'} free={isZh ? '2人' : '2'} pro={isZh ? '5人' : '5'} highlight />
              <BenefitRow feature={isZh ? 'Arena Score 详情' : 'Arena Score Details'} free="--" pro={isZh ? '支持' : 'Yes'} highlight />
              <BenefitRow feature={isZh ? '交易所平台筛选' : 'Exchange Filter'} free="--" pro={isZh ? '支持' : 'Yes'} highlight />
              <BenefitRow feature={isZh ? '数据导出' : 'Data Export'} free="--" pro="Top 10/50/100" highlight />
              <BenefitRow feature={isZh ? 'API 访问' : 'API Access'} free="--" pro={`${FEATURE_LIMITS.pro.apiCallsPerDay}${isZh ? '次/天' : '/day'}`} highlight />
              <BenefitRow feature={isZh ? '私聊消息' : 'Direct Messages'} free={isZh ? '基础' : 'Basic'} pro={isZh ? '无限制' : 'Unlimited'} highlight />
              <BenefitRow feature={isZh ? 'Pro 专属群组' : 'Pro Groups'} free="--" pro={isZh ? '支持' : 'Yes'} highlight />
              <BenefitRow feature={isZh ? 'NFT 会员证' : 'NFT Membership'} free="--" pro={isZh ? '支持' : 'Yes'} highlight />
            </tbody>
          </table>
        </div>
      </div>

      {/* Usage Stats */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
          {isZh ? '使用统计' : 'Usage Stats'}
        </h3>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
        }}>
          <UsageStat
            label={isZh ? '已关注交易员' : 'Followed Traders'}
            value={info?.usage?.followedTraders || 0}
            max={isPro ? FEATURE_LIMITS.pro.maxFollows : FEATURE_LIMITS.free.maxFollows}
          />
          {isPro && (
            <UsageStat
              label={isZh ? '今日 API 调用' : 'API Calls Today'}
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
            {isZh ? '订阅管理' : 'Manage Subscription'}
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
                    showToast(isZh ? '支付系统暂未开放，敬请期待' : 'Payment system coming soon', 'error')
                  }
                } catch {
                  showToast(isZh ? '操作失败，请稍后再试' : 'Failed, please try again', 'error')
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
              {isZh ? '升级/降级方案' : 'Change Plan'}
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
                    showToast(isZh ? '支付系统暂未开放，敬请期待' : 'Payment system coming soon', 'error')
                  }
                } catch {
                  showToast(isZh ? '操作失败，请稍后再试' : 'Failed, please try again', 'error')
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
              {isZh ? '账单历史' : 'Billing History'}
            </button>
            {info?.subscription && !info.subscription.cancelAtPeriodEnd && (
              <button
                onClick={async () => {
                  if (!confirm(isZh ? '确定要取消订阅吗？取消后将在当前周期结束时失效。' : 'Are you sure you want to cancel? Your subscription will remain active until the end of the current billing period.')) return
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
                {isZh ? '取消订阅' : 'Cancel Subscription'}
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
                {isZh ? '订阅将在到期后取消' : 'Subscription will cancel at period end'}
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
