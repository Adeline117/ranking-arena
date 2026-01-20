'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/Base'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'
import TopNav from '@/app/components/Layout/TopNav'
import { supabase } from '@/lib/supabase/client'

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

export default function PaymentSuccessPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { language, t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(5)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  // 验证并同步订阅状态
  useEffect(() => {
    const sessionId = searchParams.get('session_id')
    if (!sessionId) return

    const verifySubscription = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        
        const response = await fetch('/api/stripe/verify-session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': session?.access_token ? `Bearer ${session.access_token}` : '',
          },
          body: JSON.stringify({ sessionId }),
        })

        if (response.ok) {
          console.log('Subscription verified successfully')
        }
      } catch (error) {
        console.error('Failed to verify subscription:', error)
      }
    }

    verifySubscription()
  }, [searchParams])

  // 自动跳转倒计时
  useEffect(() => {
    if (countdown <= 0) {
      router.push('/')
      return
    }

    const timer = setTimeout(() => {
      setCountdown((prev) => prev - 1)
    }, 1000)

    return () => clearTimeout(timer)
  }, [countdown, router])

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

        {/* Pro 徽章 */}
        <Box
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 24px',
            background: 'var(--color-pro-badge-bg)',
            borderRadius: tokens.radius.full,
            boxShadow: '0 4px 20px var(--color-pro-badge-shadow)',
            marginBottom: tokens.spacing[6],
          }}
        >
          <StarIcon size={18} />
          <Text size="md" weight="bold" style={{ color: '#fff' }}>
            Pro Member
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
      </Box>
    </Box>
  )
}
