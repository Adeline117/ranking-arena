'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'

// 图标组件
const _StarIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

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

const _LockIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1C8.676 1 6 3.676 6 7V8H4V21H20V8H18V7C18 3.676 15.324 1 12 1ZM12 3C14.276 3 16 4.724 16 7V8H8V7C8 4.724 9.724 3 12 3ZM12 13C13.1 13 14 13.9 14 15C14 16.1 13.1 17 12 17C10.9 17 10 16.1 10 15C10 13.9 10.9 13 12 13Z" />
  </svg>
)

const _UserIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 12C14.21 12 16 10.21 16 8C16 5.79 14.21 4 12 4C9.79 4 8 5.79 8 8C8 10.21 9.79 12 12 12ZM12 14C9.33 14 4 15.34 4 18V20H20V18C20 15.34 14.67 14 12 14Z" />
  </svg>
)

const QuoteIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" opacity={0.3}>
    <path d="M6 17H9L11 13V7H5V13H8L6 17ZM14 17H17L19 13V7H13V13H16L14 17Z" />
  </svg>
)

const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M18 6L6 18M6 6L18 18" />
  </svg>
)

// 用户评价数据
const TESTIMONIALS = [
  {
    name: 'Alex T.',
    avatar: '🧑‍💻',
    role: '全职交易员',
    roleEn: 'Full-time Trader',
    content: '风险预警功能帮我避免了一次大亏损，物超所值！',
    contentEn: 'Risk alerts helped me avoid a major loss. Worth every penny!',
  },
  {
    name: 'Michael K.',
    avatar: '👨‍💼',
    role: '投资顾问',
    roleEn: 'Investment Advisor',
    content: 'Arena Score 评分系统非常专业，让筛选交易员变得简单',
    contentEn: 'Arena Score is very professional, makes screening traders easy',
  },
  {
    name: 'Sarah L.',
    avatar: '👩‍🦰',
    role: '兼职跟单',
    roleEn: 'Part-time Copier',
    content: '对比功能很实用，省去了大量手动计算的时间',
    contentEn: 'Comparison feature is very useful, saves a lot of manual calculation time',
  },
]

// Free vs Pro 对比数据
const getComparisonData = (language: string) => [
  {
    feature: language === 'zh' ? '排行榜浏览' : 'Leaderboard Access',
    free: true,
    pro: true,
  },
  {
    feature: language === 'zh' ? '基础交易员详情' : 'Basic Trader Details',
    free: true,
    pro: true,
  },
  {
    feature: language === 'zh' ? '分类别排行（现货/链上/合约）' : 'Category Ranking (Spot/On-chain/Futures)',
    free: false,
    pro: true,
  },
  {
    feature: language === 'zh' ? 'Arena Score 评分' : 'Arena Score',
    free: language === 'zh' ? '总分' : 'Total Score',
    pro: language === 'zh' ? '子分数 + 同类分位' : 'Breakdown + Percentile',
  },
  {
    feature: language === 'zh' ? '关注交易员变动提醒' : 'Trader Change Alerts',
    free: false,
    pro: language === 'zh' ? '站内私信自动提醒' : 'Auto DM Alerts',
  },
  {
    feature: language === 'zh' ? '交易员对比' : 'Trader Comparison',
    free: false,
    pro: language === 'zh' ? '最多5个交易员' : 'Up to 5 traders',
  },
  {
    feature: language === 'zh' ? '高级筛选' : 'Advanced Filters',
    free: false,
    pro: language === 'zh' ? '多条件叠加 + 保存复用' : 'Multi-filter + Save & Reuse',
  },
  {
    feature: language === 'zh' ? 'Pro 徽章' : 'Pro Badge',
    free: false,
    pro: language === 'zh' ? '可在隐私设置关闭' : 'Can hide in settings',
  },
  {
    feature: language === 'zh' ? 'Pro 专属群组' : 'Pro-only Groups',
    free: false,
    pro: language === 'zh' ? '可创建/加入' : 'Create/Join',
  },
  {
    feature: language === 'zh' ? 'Pro 会员官方群' : 'Pro Member Official Group',
    free: false,
    pro: language === 'zh' ? '自动加入（500人/群）' : 'Auto-join (500/group)',
  },
]

// FAQ 数据
const getFaqData = (language: string) => [
  {
    q: language === 'zh' ? '可以随时取消订阅吗？' : 'Can I cancel anytime?',
    a: language === 'zh' 
      ? '是的，您可以随时取消订阅。取消后，您仍可享受 Pro 权益直到当前计费周期结束。'
      : 'Yes, you can cancel anytime. After cancellation, you will still enjoy Pro benefits until the end of the current billing cycle.',
  },
  {
    q: language === 'zh' ? '支持哪些支付方式？' : 'What payment methods are supported?',
    a: language === 'zh'
      ? '我们支持 Visa、Mastercard、支付宝、微信支付。付款由 Stripe 安全处理。'
      : 'We support Visa, Mastercard, Alipay, and WeChat Pay. Payments are securely processed by Stripe.',
  },
  {
    q: language === 'zh' ? '有退款政策吗？' : 'Is there a refund policy?',
    a: language === 'zh' 
      ? '首次订阅后7天内如不满意，可申请全额退款。请联系 support@arenafi.org。'
      : 'Within 7 days of your first subscription, you can request a full refund if not satisfied. Contact support@arenafi.org.',
  },
  {
    q: language === 'zh' ? '年付可以切换为月付吗？' : 'Can I switch from yearly to monthly?',
    a: language === 'zh' 
      ? '当前订阅到期后，您可以选择不同的计费周期续订。'
      : 'After your current subscription expires, you can choose a different billing cycle to renew.',
  },
]

// 价格配置 - 与 Stripe 保持一致
const PRICING = {
  monthly: { price: 9.9, original: 15 },
  yearly: { price: 99.9, original: 180 },
}

// Pro 功能配置
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

export default function PricingPage() {
  const router = useRouter()
  const { language, t } = useLanguage()
  const { showToast } = useToast()
  
  const [email, setEmail] = useState<string | null>(null)
  const [_userId, setUserId] = useState<string | null>(null)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<'monthly' | 'yearly'>('yearly')
  const [_hoveredPlan, setHoveredPlan] = useState<'monthly' | 'yearly' | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
      setIsLoggedIn(!!data.user)
    })
  }, [])

  const yearlySavings = Math.round((1 - (PRICING.yearly.price / 12) / PRICING.monthly.price) * 100)

  const PRO_FEATURES = getProFeatures(t)

  const handleSubscribe = async () => {
    if (!isLoggedIn) {
      showToast(language === 'zh' ? '请先登录后再订阅' : 'Please login first', 'info')
      router.push('/login?redirect=/pricing')
      return
    }

    setLoading(true)
    
    try {
      // 获取当前会话的 access token
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        showToast(language === 'zh' ? '请重新登录' : 'Please login again', 'error')
        router.push('/login?redirect=/pricing')
        return
      }

      // 调用 Stripe Checkout API
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
          cancelUrl: `${window.location.origin}/pricing`,
        }),
      })
      
      if (!response.ok) {
        let errorMsg = language === 'zh' ? '创建支付会话失败' : 'Failed to create checkout session'
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
        // 跳转到 Stripe Checkout 页面
        window.location.href = data.url
      } else if (data.error) {
        showToast(data.error, 'error')
      } else {
        showToast(
          language === 'zh' ? '无法获取支付链接，请稍后重试' : 'Failed to get payment link, please try again',
          'error'
        )
      }
    } catch (_error) {
      showToast(language === 'zh' ? '订阅失败，请稍后重试' : 'Subscription failed, please try again', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg-primary)',
        color: 'var(--color-text-primary)',
      }}
    >
      {/* 背景 */}
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: `radial-gradient(ellipse at top, var(--color-pro-glow) 0%, transparent 50%),
                       radial-gradient(ellipse at bottom right, var(--color-pro-gradient-start)10 0%, transparent 50%)`,
          pointerEvents: 'none',
        }}
      />

      <TopNav email={email} />

      <Box
        style={{
          maxWidth: 1000,
          margin: '0 auto',
          padding: `${tokens.spacing[8]} ${tokens.spacing[6]}`,
          position: 'relative',
        }}
      >
        {/* 标题区 */}
        <Box style={{ textAlign: 'center', marginBottom: tokens.spacing[8] }}>
          <Box
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 16px',
              background: 'var(--color-pro-glow)',
              borderRadius: tokens.radius.full,
              marginBottom: tokens.spacing[4],
            }}
          >
            <Box style={{ color: 'var(--color-pro-gradient-start)' }}>
              <CrownIcon size={18} />
            </Box>
            <Text size="sm" weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
              {t('pricingTitle')}
            </Text>
          </Box>
          
          <Text
            as="h1"
            size="3xl"
            weight="black"
            style={{
              marginBottom: tokens.spacing[3],
              background: `linear-gradient(135deg, var(--color-text-primary) 0%, var(--color-pro-gradient-start) 100%)`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            {t('pricingSubtitle')}
          </Text>
          <Text size="md" color="secondary" style={{ maxWidth: 500, margin: '0 auto' }}>
            {language === 'zh'
              ? '专业的数据聚合与分析工具，全面了解交易员表现与风险'
              : 'Professional data aggregation and analytics tools to understand trader performance and risks'
            }
          </Text>
        </Box>

        {/* 主体内容 */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 380px',
            gap: tokens.spacing[6],
            alignItems: 'start',
          }}
          className="pricing-grid"
        >
          {/* 左侧：功能列表 */}
          <Box
            style={{
              background: 'var(--color-bg-secondary)',
              borderRadius: tokens.radius.xl,
              border: '1px solid var(--color-border-primary)',
              padding: tokens.spacing[6],
            }}
          >
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[5] }}>
              {language === 'zh' ? 'Pro 会员专属功能' : 'Pro Member Exclusive Features'}
            </Text>
            
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              {PRO_FEATURES.map((feature, index) => (
                <Box
                  key={index}
                  style={{
                    display: 'flex',
                    gap: tokens.spacing[3],
                    padding: tokens.spacing[3],
                    borderRadius: tokens.radius.lg,
                    background: 'var(--color-bg-tertiary)',
                    border: '1px solid var(--color-border-secondary)',
                  }}
                >
                  <Box
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: tokens.radius.md,
                      background: 'var(--color-pro-glow)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--color-pro-gradient-start)',
                      flexShrink: 0,
                    }}
                  >
                    <CheckIcon size={16} />
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
          </Box>

          {/* 右侧：价格卡片 */}
          <Box
            style={{
              background: `linear-gradient(135deg, var(--color-bg-secondary) 0%, var(--color-bg-tertiary) 100%)`,
              borderRadius: tokens.radius.xl,
              border: '1px solid var(--color-pro-glow)',
              padding: tokens.spacing[5],
              position: 'sticky',
              top: 100,
            }}
          >
            {/* 推荐标签 */}
            <Box
              style={{
                position: 'absolute',
                top: -12,
                left: '50%',
                transform: 'translateX(-50%)',
                padding: '6px 16px',
                background: 'var(--color-pro-badge-bg)',
                borderRadius: tokens.radius.full,
                boxShadow: '0 4px 12px var(--color-pro-badge-shadow)',
              }}
            >
              <Text size="xs" weight="bold" style={{ color: '#fff' }}>
                {language === 'zh' ? '限时优惠' : 'Limited Offer'}
              </Text>
            </Box>

            {/* 价格选项 */}
            <Box style={{ marginTop: tokens.spacing[4], marginBottom: tokens.spacing[5] }}>
              {/* 月付 */}
              <Box
                onClick={() => setSelectedPlan('monthly')}
                onMouseEnter={() => setHoveredPlan('monthly')}
                onMouseLeave={() => setHoveredPlan(null)}
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
                    <Box style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                      <Text
                        size="xs"
                        style={{
                          textDecoration: 'line-through',
                          color: 'var(--color-text-tertiary)',
                        }}
                      >
                        ${PRICING.monthly.original}
                      </Text>
                      <Text size="xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                        ${PRICING.monthly.price}
                      </Text>
                    </Box>
                    <Text size="xs" color="tertiary">{t('perMonth')}</Text>
                  </Box>
                </Box>
              </Box>

              {/* 年付 */}
              <Box
                onClick={() => setSelectedPlan('yearly')}
                onMouseEnter={() => setHoveredPlan('yearly')}
                onMouseLeave={() => setHoveredPlan(null)}
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
                    color: '#fff',
                  }}
                >
                  {language === 'zh' ? `省 ${yearlySavings}%` : `Save ${yearlySavings}%`}
                </Box>
                
                <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Box>
                    <Text size="sm" weight="bold">{t('yearlyPlan')}</Text>
                    <Text size="xs" color="tertiary">{t('bestValue')}</Text>
                  </Box>
                  <Box style={{ textAlign: 'right' }}>
                    <Box style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                      <Text
                        size="xs"
                        style={{
                          textDecoration: 'line-through',
                          color: 'var(--color-text-tertiary)',
                        }}
                      >
                        ${PRICING.yearly.original}
                      </Text>
                      <Text size="xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                        ${PRICING.yearly.price}
                      </Text>
                    </Box>
                    <Text size="xs" color="tertiary">
                      {language === 'zh' 
                        ? `约 $${(PRICING.yearly.price / 12).toFixed(1)}/月`
                        : `~$${(PRICING.yearly.price / 12).toFixed(1)}/month`
                      }
                    </Text>
                  </Box>
                </Box>
              </Box>
            </Box>

            {/* 订阅按钮 */}
            <Button
              variant="primary"
              onClick={handleSubscribe}
              disabled={loading}
              style={{
                width: '100%',
                padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
                background: 'var(--color-pro-badge-bg)',
                border: 'none',
                boxShadow: '0 4px 16px var(--color-pro-badge-shadow)',
                fontSize: tokens.typography.fontSize.md,
                fontWeight: 700,
              }}
            >
              {loading ? t('processing') : (
                isLoggedIn 
                  ? `${t('startSubscription')} - $${selectedPlan === 'yearly' ? PRICING.yearly.price : PRICING.monthly.price}`
                  : (language === 'zh' ? '登录后订阅' : 'Login to Subscribe')
              )}
            </Button>

            {/* 说明 */}
            <Box style={{ marginTop: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="xs" color="tertiary" style={{ lineHeight: 1.6 }}>
                {t('cancelAnytime')}<br />
                {t('securePayment')}
              </Text>
            </Box>

            {/* 支付方式 */}
            <Box
              style={{
                marginTop: tokens.spacing[4],
                paddingTop: tokens.spacing[4],
                borderTop: '1px solid var(--color-border-secondary)',
                display: 'flex',
                justifyContent: 'center',
                gap: tokens.spacing[3],
              }}
            >
              <Text size="xs" color="tertiary">{t('paymentMethods')}:</Text>
              <Text size="xs" color="secondary">{t('supportedPayments')}</Text>
            </Box>
          </Box>
        </Box>

        {/* 社会证明区块 */}
        <Box
          style={{
            marginTop: tokens.spacing[10],
            textAlign: 'center',
          }}
        >
          {/* 统计数据 */}
          <Box
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: tokens.spacing[8],
              marginBottom: tokens.spacing[8],
              flexWrap: 'wrap',
            }}
          >
            <Box>
              <Text size="3xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                500+
              </Text>
              <Text size="sm" color="secondary">
                {language === 'zh' ? 'Pro 会员' : 'Pro Members'}
              </Text>
            </Box>
            <Box>
              <Text size="3xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                10K+
              </Text>
              <Text size="sm" color="secondary">
                {language === 'zh' ? '交易员数据' : 'Traders Tracked'}
              </Text>
            </Box>
            <Box>
              <Text size="3xl" weight="black" style={{ color: 'var(--color-pro-gradient-start)' }}>
                7
              </Text>
              <Text size="sm" color="secondary">
                {language === 'zh' ? '交易所覆盖' : 'Exchanges'}
              </Text>
            </Box>
          </Box>

          {/* 用户评价 */}
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[5] }}>
            {language === 'zh' ? '用户评价' : 'What Our Users Say'}
          </Text>
          
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: tokens.spacing[4],
              maxWidth: 900,
              margin: '0 auto',
            }}
          >
            {TESTIMONIALS.map((testimonial, index) => (
              <Box
                key={index}
                style={{
                  background: 'var(--color-bg-secondary)',
                  borderRadius: tokens.radius.lg,
                  padding: tokens.spacing[5],
                  border: '1px solid var(--color-border-primary)',
                  textAlign: 'left',
                  position: 'relative',
                }}
              >
                <Box style={{ position: 'absolute', top: 12, right: 16 }}>
                  <QuoteIcon size={24} />
                </Box>
                <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4], lineHeight: 1.6 }}>
                  &ldquo;{language === 'zh' ? testimonial.content : testimonial.contentEn}&rdquo;
                </Text>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                  <Box
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: tokens.radius.full,
                      background: 'var(--color-bg-tertiary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 18,
                    }}
                  >
                    {testimonial.avatar}
                  </Box>
                  <Box>
                    <Text size="sm" weight="bold">{testimonial.name}</Text>
                    <Text size="xs" color="tertiary">
                      {language === 'zh' ? testimonial.role : testimonial.roleEn}
                    </Text>
                  </Box>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>

        {/* Free vs Pro 功能对比表 */}
        <Box
          style={{
            marginTop: tokens.spacing[10],
            background: 'var(--color-bg-secondary)',
            borderRadius: tokens.radius.xl,
            padding: tokens.spacing[6],
            border: '1px solid var(--color-border-primary)',
          }}
        >
          <Text size="lg" weight="bold" style={{ textAlign: 'center', marginBottom: tokens.spacing[6] }}>
            {language === 'zh' ? 'Free vs Pro 功能对比' : 'Free vs Pro Comparison'}
          </Text>
          
          <Box style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ 
                    textAlign: 'left', 
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderBottom: '2px solid var(--color-border-primary)',
                    color: 'var(--color-text-secondary)',
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: 600,
                  }}>
                    {language === 'zh' ? '功能' : 'Feature'}
                  </th>
                  <th style={{ 
                    textAlign: 'center', 
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderBottom: '2px solid var(--color-border-primary)',
                    color: 'var(--color-text-secondary)',
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: 600,
                    width: 100,
                  }}>
                    Free
                  </th>
                  <th style={{ 
                    textAlign: 'center', 
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderBottom: '2px solid var(--color-border-primary)',
                    color: 'var(--color-pro-gradient-start)',
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: 700,
                    width: 100,
                  }}>
                    Pro
                  </th>
                </tr>
              </thead>
              <tbody>
                {getComparisonData(language).map((row, index) => (
                  <tr key={index}>
                    <td style={{ 
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      borderBottom: '1px solid var(--color-border-secondary)',
                      fontSize: tokens.typography.fontSize.sm,
                    }}>
                      {row.feature}
                    </td>
                    <td style={{ 
                      textAlign: 'center',
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      borderBottom: '1px solid var(--color-border-secondary)',
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
                      borderBottom: '1px solid var(--color-border-secondary)',
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
          </Box>
        </Box>

        {/* FAQ 区块 */}
        <Box
          style={{
            marginTop: tokens.spacing[10],
            maxWidth: 700,
            margin: `${tokens.spacing[10]} auto 0`,
          }}
        >
          <Text size="lg" weight="bold" style={{ textAlign: 'center', marginBottom: tokens.spacing[6] }}>
            {language === 'zh' ? '常见问题' : 'Frequently Asked Questions'}
          </Text>
          
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {getFaqData(language).map((faq, index) => (
              <Box
                key={index}
                style={{
                  background: 'var(--color-bg-secondary)',
                  borderRadius: tokens.radius.lg,
                  padding: tokens.spacing[5],
                  border: '1px solid var(--color-border-primary)',
                }}
              >
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                  {faq.q}
                </Text>
                <Text size="sm" color="secondary" style={{ lineHeight: 1.6 }}>
                  {faq.a}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>

        {/* 底部 CTA */}
        <Box style={{ marginTop: tokens.spacing[10], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">
            {language === 'zh' ? '还有其他问题？' : 'Have more questions?'}
            <Link 
              href="/help" 
              style={{ 
                color: 'var(--color-pro-gradient-start)', 
                marginLeft: 4,
                textDecoration: 'none',
              }}
            >
              {language === 'zh' ? '联系我们' : 'Contact Us'}
            </Link>
          </Text>
        </Box>
      </Box>

      {/* 响应式样式 */}
      <style jsx global>{`
        @media (max-width: 768px) {
          .pricing-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </Box>
  )
}
