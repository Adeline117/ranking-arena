'use client'
/* eslint-disable react-hooks/preserve-manual-memoization */

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import TopNav from '@/app/components/layout/TopNav'
import { supabase } from '@/lib/supabase/client'
import { usePremium } from '@/lib/premium/hooks'
import { clearSubscriptionCache } from '@/app/components/home/hooks/useSubscription'
import { getCsrfHeaders } from '@/lib/api/client'

// 图标组件
const CheckCircleIcon = ({ size = 64 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" fill="var(--color-accent-success)" fillOpacity="0.15" />
    <circle cx="12" cy="12" r="10" stroke="var(--color-accent-success)" strokeWidth="2" />
    <path d="M8 12L11 15L16 9" stroke="var(--color-accent-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const StarIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

const LoadingSpinner = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 1s linear infinite' }}>
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </svg>
)

export default function PaymentSuccessPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { language, t } = useLanguage()
  const { showToast } = useToast()
  const { refresh: refreshPremium, isPremium, tier } = usePremium()
  
  const [email, setEmail] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(8) // 增加倒计时给验证留更多时间
  const [verificationStatus, setVerificationStatus] = useState<'verifying' | 'success' | 'error'>('verifying')
  const [hasVerified, setHasVerified] = useState(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  // 验证并同步订阅状态
  const verifyAndRefresh = useCallback(async () => {
    const sessionId = searchParams.get('session_id')
    if (!sessionId || hasVerified) return

    setHasVerified(true)
    setVerificationStatus('verifying')

    try {
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        console.error('No session found')
        setVerificationStatus('error')
        return
      }

      // 调用验证 API 更新数据库
      const response = await fetch('/api/stripe/verify-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ sessionId }),
      })

      if (!response.ok) {
        let errorMsg = language === 'zh' ? '验证支付失败' : 'Payment verification failed'
        try {
          const errorData = await response.json()
          errorMsg = errorData.error || errorMsg
          console.error('[Payment Success] Verification failed:', errorData)
        } catch {
          errorMsg = `${errorMsg} (${response.status})`
        }
        
        // 即使验证失败也尝试刷新状态（可能 webhook 已经处理了）
        clearSubscriptionCache()
        await refreshPremium()
        
        // 等待一下再检查状态（给 webhook 时间处理）
        await new Promise(resolve => setTimeout(resolve, 2000))
        await refreshPremium()
        
        // 再次刷新以获取最新状态
        await refreshPremium()
        
        // 如果刷新后是 pro，说明 webhook 已经处理了
        const currentIsPremium = isPremium || tier === 'pro'
        if (currentIsPremium) {
          setVerificationStatus('success')
          showToast(
            language === 'zh' ? '会员已激活！' : 'Membership activated!',
            'success'
          )
        } else {
          setVerificationStatus('error')
          showToast(
            language === 'zh' ? '验证失败，请稍后刷新页面或联系客服' : 'Verification failed, please refresh or contact support',
            'warning'
          )
        }
        return
      }

      const data = await response.json()
      console.log('[Payment Success] Subscription verified:', data)
      
      // 清除本地订阅缓存
      clearSubscriptionCache()
      
      // 关键：刷新 Premium 上下文以更新界面状态
      await refreshPremium()
      
      // 等待一下确保状态更新
      await new Promise(resolve => setTimeout(resolve, 500))
      await refreshPremium()
      
      // 检查最终状态
      const finalIsPremium = data.tier === 'pro' || isPremium || tier === 'pro'
      if (finalIsPremium) {
        setVerificationStatus('success')
        showToast(
          language === 'zh' ? '会员已激活！' : 'Membership activated!',
          'success'
        )
      } else {
        // 状态可能还没完全同步，但 API 返回成功，标记为成功
        setVerificationStatus('success')
        showToast(
          language === 'zh' ? '支付成功，正在激活会员...' : 'Payment successful, activating membership...',
          'info'
        )
      }
    } catch (error) {
      console.error('Failed to verify subscription:', error)
      setVerificationStatus('error')
      
      // 清除本地订阅缓存
      clearSubscriptionCache()
      
      // 尝试刷新状态
      await refreshPremium()
    }
  }, [searchParams, hasVerified, refreshPremium, showToast, language])

  useEffect(() => {
    verifyAndRefresh()
  }, [verifyAndRefresh])

  // 自动跳转倒计时（只在验证完成后开始）
  useEffect(() => {
    if (verificationStatus === 'verifying') return
    
    if (countdown <= 0) {
      router.push('/')
      return
    }

    const timer = setTimeout(() => {
      setCountdown((prev) => prev - 1)
    }, 1000)

    return () => clearTimeout(timer)
  }, [countdown, router, verificationStatus])

  const sessionId = searchParams.get('session_id')

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
          background: `radial-gradient(ellipse at top, var(--color-accent-success)15 0%, transparent 50%),
                       radial-gradient(ellipse at bottom right, var(--color-pro-glow) 0%, transparent 50%)`,
          pointerEvents: 'none',
        }}
      />

      <TopNav email={email} />

      <Box
        style={{
          maxWidth: 600,
          margin: '0 auto',
          padding: `${tokens.spacing[10]} ${tokens.spacing[6]}`,
          textAlign: 'center',
          position: 'relative',
        }}
      >
        {/* 验证中状态 */}
        {verificationStatus === 'verifying' && (
          <>
            <Box style={{ marginBottom: tokens.spacing[6], color: 'var(--color-pro-gradient-start)' }}>
              <LoadingSpinner size={80} />
            </Box>
            <Text
              as="h1"
              size="2xl"
              weight="black"
              style={{ marginBottom: tokens.spacing[3] }}
            >
              {language === 'zh' ? '正在激活会员...' : 'Activating membership...'}
            </Text>
            <Text size="md" color="secondary">
              {language === 'zh' ? '请稍候，正在同步您的订阅状态' : 'Please wait while we sync your subscription'}
            </Text>
          </>
        )}

        {/* 验证成功状态 */}
        {verificationStatus !== 'verifying' && (
          <>
            {/* 成功图标 */}
            <Box style={{ marginBottom: tokens.spacing[6] }}>
              <CheckCircleIcon size={80} />
            </Box>

            {/* 标题 */}
            <Text
              as="h1"
              size="2xl"
              weight="black"
              style={{
                marginBottom: tokens.spacing[3],
              }}
            >
              {t('paymentSuccess')}
            </Text>

            <Text size="md" color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
              {language === 'zh' 
                ? '恭喜！你已成功升级为 Pro 会员' 
                : 'Congratulations! You are now a Pro member'
              }
            </Text>

            {/* Pro 徽章 - 显示实时状态 */}
            <Box
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 24px',
                background: isPremium ? 'var(--color-pro-badge-bg)' : 'var(--color-bg-secondary)',
                borderRadius: tokens.radius.full,
                boxShadow: isPremium ? '0 4px 20px var(--color-pro-badge-shadow)' : 'none',
                border: isPremium ? 'none' : '1px solid var(--color-border-primary)',
                marginBottom: tokens.spacing[6],
              }}
            >
              <StarIcon size={18} />
              <Text size="md" weight="bold" style={{ color: isPremium ? '#fff' : 'var(--color-text-secondary)' }}>
                {isPremium ? 'Pro Member' : (tier === 'pro' ? 'Pro Member' : 'Activating...')}
              </Text>
            </Box>

            {/* 功能提示 */}
            <Box
              style={{
                background: 'var(--color-bg-secondary)',
                borderRadius: tokens.radius.xl,
                border: '1px solid var(--color-border-primary)',
                padding: tokens.spacing[5],
                marginBottom: tokens.spacing[6],
                textAlign: 'left',
              }}
            >
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                {language === 'zh' ? '现在你可以：' : 'Now you can:'}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {[
                  language === 'zh' ? '按分类查看交易员排行' : 'View rankings by category',
                  language === 'zh' ? '接收交易员变动提醒' : 'Get trader change alerts',
                  language === 'zh' ? '查看详细评分分析' : 'View detailed score analysis',
                  language === 'zh' ? '使用高级筛选功能' : 'Use advanced filters',
                  language === 'zh' ? '对比多位交易员' : 'Compare multiple traders',
                ].map((text, i) => (
                  <Box key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Box
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: 'var(--color-accent-success)',
                      }}
                    />
                    <Text size="sm" color="secondary">{text}</Text>
                  </Box>
                ))}
              </Box>
            </Box>

            {/* 按钮 */}
            <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'center' }}>
              <Link href="/" style={{ textDecoration: 'none' }}>
                <Button
                  variant="primary"
                  style={{
                    padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                    background: 'var(--color-pro-badge-bg)',
                    border: 'none',
                    boxShadow: '0 4px 12px var(--color-pro-badge-shadow)',
                  }}
                >
                  {language === 'zh' ? '开始探索' : 'Start Exploring'}
                </Button>
              </Link>
              <Link href="/settings" style={{ textDecoration: 'none' }}>
                <Button
                  variant="secondary"
                  style={{
                    padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                  }}
                >
                  {t('settings')}
                </Button>
              </Link>
            </Box>

            {/* 倒计时提示 */}
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[6] }}>
              {language === 'zh' 
                ? `${countdown} 秒后自动返回首页...` 
                : `Redirecting to home in ${countdown} seconds...`
              }
            </Text>
          </>
        )}
      </Box>
    </Box>
  )
}
