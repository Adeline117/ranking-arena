'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'
import { useToast } from '@/app/components/UI/Toast'

// 图标组件
const StarIcon = ({ size = 16 }: { size?: number }) => (
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

const LockIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1C8.676 1 6 3.676 6 7V8H4V21H20V8H18V7C18 3.676 15.324 1 12 1ZM12 3C14.276 3 16 4.724 16 7V8H8V7C8 4.724 9.724 3 12 3ZM12 13C13.1 13 14 13.9 14 15C14 16.1 13.1 17 12 17C10.9 17 10 16.1 10 15C10 13.9 10.9 13 12 13Z" />
  </svg>
)

// 价格配置 - 与 Stripe 保持一致
const PRICING = {
  monthly: { price: 9.99, original: 15 },
  yearly: { price: 99.99, original: 180 },
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
  const [userId, setUserId] = useState<string | null>(null)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<'monthly' | 'yearly'>('yearly')
  const [hoveredPlan, setHoveredPlan] = useState<'monthly' | 'yearly' | null>(null)
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
        },
        body: JSON.stringify({ 
          plan: selectedPlan,
          successUrl: `${window.location.origin}/pricing/success`,
          cancelUrl: `${window.location.origin}/pricing`,
        }),
      })
      
      const data = await response.json()
      
      if (data.url) {
        // 跳转到 Stripe Checkout 页面
        window.location.href = data.url
      } else if (data.error) {
        showToast(data.error, 'error')
      }
    } catch (error) {
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
              ? '专业的跟单分析工具，助你做出更明智的投资决策'
              : 'Professional copy trading analytics to help you make smarter investment decisions'
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

        {/* 底部 FAQ */}
        <Box style={{ marginTop: tokens.spacing[8], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">
            {language === 'zh' ? '有任何问题？' : 'Have questions?'}
            <Link 
              href="/help" 
              style={{ 
                color: 'var(--color-pro-gradient-start)', 
                marginLeft: 4,
                textDecoration: 'none',
              }}
            >
              {language === 'zh' ? '查看帮助中心' : 'View Help Center'}
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
