'use client'

import { Suspense, useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { supabase } from '@/lib/supabase/client'
import { usePremium } from '@/lib/premium/hooks'
import { clearSubscriptionCache } from '@/app/components/home/hooks/useSubscription'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import { trackEvent } from '@/lib/analytics/track'

// 图标组件
const CheckCircleIcon = ({ size = 64 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" fill="var(--color-accent-success)" fillOpacity="0.15" />
    <circle cx="12" cy="12" r="10" stroke="var(--color-accent-success)" strokeWidth="2" />
    <path
      d="M8 12L11 15L16 9"
      stroke="var(--color-accent-success)"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const StarIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

const LoadingSpinner = ({ size = 24 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    style={{ animation: 'spin 1s linear infinite' }}
  >
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </svg>
)

export default function PaymentSuccessPage() {
  return (
    <Suspense
      fallback={
        <Box
          style={{
            minHeight: '100vh',
            background: 'var(--color-bg-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <LoadingSpinner size={48} />
        </Box>
      }
    >
      <PaymentSuccessContent />
    </Suspense>
  )
}

function PaymentSuccessContent() {
  const searchParams = useSearchParams()
  const { language: _language, t } = useLanguage()
  const { showToast } = useToast()
  const { refresh: refreshPremium } = usePremium()

  const [email, setEmail] = useState<string | null>(null)
  const [verificationStatus, setVerificationStatus] = useState<'verifying' | 'success' | 'error'>(
    'verifying'
  )
  const [hasVerified, setHasVerified] = useState(false)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    supabase.auth
      .getUser()
      .then(({ data }) => {
        setEmail(data.user?.email ?? null)
      })
      // eslint-disable-next-line no-restricted-syntax
      .catch(() => {
        /* Intentionally swallowed: auth check non-critical for success page */
      })
  }, [])

  // 直接查询订阅状态（避免 React 状态闭包问题）
  const checkSubscriptionDirect = useCallback(async (): Promise<boolean> => {
    try {
      // 获取有效 session（自动刷新过期 token）

      let {
        data: { session },
      } = await supabase.auth.getSession()

      // 检查 token 是否过期或即将过期
      if (session?.expires_at) {
        const now = Math.floor(Date.now() / 1000)
        if (session.expires_at - now < 60) {
          // Token 过期或即将过期，强制刷新
          const { data: refreshed } = await supabase.auth.refreshSession()
          session = refreshed.session
        }
      } else if (!session?.access_token) {
        const { data: refreshed } = await supabase.auth.refreshSession()
        session = refreshed.session
      }

      if (!session?.access_token || !session?.user?.id) return false

      // 优先通过 API 查询（使用 service role，不受 RLS 限制）
      try {
        const response = await fetch('/api/subscription', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        })
        if (response.ok) {
          const data = await response.json()
          if (data.subscription?.tier === 'pro') return true
        }
      } catch {
        // Intentionally swallowed: subscription API check failed, falling back to direct Supabase query
      }

      // 降级：直接查 subscriptions 表（需要有效 JWT 才能通过 RLS）
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('tier, status')
        .eq('user_id', session.user.id)
        .in('status', ['active', 'trialing'])
        .maybeSingle()

      if (sub?.tier === 'pro') return true

      // 再查 user_profiles
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('subscription_tier')
        .eq('id', session.user.id)
        .maybeSingle()

      return profile?.subscription_tier === 'pro'
    } catch {
      return false
    }
  }, [])

  // 获取有效的 access token（自动刷新过期 token）
  const getValidAccessToken = useCallback(async (): Promise<string | null> => {
    let {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      // 尝试刷新 session（token 可能已过期但 refresh token 仍有效）
      const { data: refreshed } = await supabase.auth.refreshSession()
      session = refreshed.session
    }

    return session?.access_token || null
  }, [])

  // 验证并同步订阅状态
  const verifyAndRefresh = useCallback(async () => {
    const sessionId = searchParams.get('session_id')
    if (hasVerified) return

    // No session_id means we can't verify — show error immediately
    if (!sessionId) {
      setVerificationStatus('error')
      return
    }

    setHasVerified(true)
    setVerificationStatus('verifying')

    try {
      // 尝试获取 token（但不强制要求，verify-session 通过 Stripe metadata 识别用户）
      const accessToken = await getValidAccessToken()

      // 调用验证 API 更新数据库 - 即使没有 token 也尝试调用
      // verify-session 通过 Stripe session metadata 中的 userId 识别用户，不依赖调用者 token
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...getCsrfHeaders(),
      }
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`
      }

      const response = await fetch('/api/stripe/verify-session', {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId }),
      })

      if (response.ok) {
        await response.json()

        // 验证成功后，尝试刷新 auth session 以获取最新状态
        if (!accessToken) {
          // token 过期了，尝试刷新
          await supabase.auth.refreshSession()
        }

        clearSubscriptionCache()
        await refreshPremium()
        setVerificationStatus('success')
        trackEvent('pro_subscribe', { source: 'verify_api' })
        showToast(t('membershipActivated'), 'success')
        return
      }

      // API 返回非 200，记录错误
      try {
        const errorData = await response.json()
        logger.error('[Payment Success] Verification API error:', errorData)
      } catch {
        logger.error('[Payment Success] Verification API error:', response.status)
      }

      // 验证 API 失败，可能 webhook 已经处理了，通过轮询数据库确认
      // 先尝试刷新 session 以确保后续查询有有效 token
      if (!accessToken) {
        await supabase.auth.refreshSession()
      }
      clearSubscriptionCache()

      // 轮询检查（最多尝试 4 次，间隔缩短以减少等待）
      const delays = [800, 1200, 1500, 2000]
      for (const delay of delays) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        const isProNow = await checkSubscriptionDirect()
        if (isProNow) {
          await refreshPremium()
          setVerificationStatus('success')
          showToast(t('membershipActivated'), 'success')
          return
        }
      }

      // 所有重试都失败
      setVerificationStatus('error')
    } catch (error) {
      logger.error('Failed to verify subscription:', error)

      // 清除缓存，尝试刷新 session 后直接查询确认
      await supabase.auth.refreshSession()
      clearSubscriptionCache()
      const isProNow = await checkSubscriptionDirect()
      if (isProNow) {
        await refreshPremium()
        setVerificationStatus('success')
        trackEvent('pro_subscribe', { source: 'verify_api' })
        showToast(t('membershipActivated'), 'success')
      } else {
        setVerificationStatus('error')
      }
    }
  }, [
    searchParams,
    hasVerified,
    refreshPremium,
    showToast,
    t,
    checkSubscriptionDirect,
    getValidAccessToken,
  ])

  // 手动重试 - 先刷新 session，再触发重新验证
  const handleRetry = useCallback(async () => {
    setRetrying(true)
    setVerificationStatus('verifying')
    // 重试前先尝试刷新 session
    await supabase.auth.refreshSession()
    clearSubscriptionCache()
    setHasVerified(false)
    // hasVerified 重置后 verifyAndRefresh 的 useEffect 会重新触发
  }, [])

  useEffect(() => {
    if (!hasVerified) {
      verifyAndRefresh()
    }
  }, [verifyAndRefresh, hasVerified])

  // retrying 结束后重置状态
  useEffect(() => {
    if (retrying && verificationStatus !== 'verifying') {
      setRetrying(false)
    }
  }, [retrying, verificationStatus])

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
            <Box
              style={{ marginBottom: tokens.spacing[6], color: 'var(--color-pro-gradient-start)' }}
            >
              <LoadingSpinner size={80} />
            </Box>
            <Text as="h1" size="2xl" weight="black" style={{ marginBottom: tokens.spacing[3] }}>
              {t('activatingMembership')}
            </Text>
            <Text size="md" color="secondary">
              {t('syncingSubscription')}
            </Text>
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[3] }}>
              {t('thisUsuallyTakesSeconds')}
            </Text>
          </>
        )}

        {/* 验证成功状态 */}
        {verificationStatus === 'success' && (
          <>
            <Box style={{ marginBottom: tokens.spacing[6] }}>
              <CheckCircleIcon size={80} />
            </Box>

            <Text as="h1" size="2xl" weight="black" style={{ marginBottom: tokens.spacing[3] }}>
              {t('paymentSuccess')}
            </Text>

            <Text size="md" color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
              {t('congratsProMember')}
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
              <Text size="md" weight="bold" style={{ color: tokens.colors.white }}>
                {t('proMember')}
              </Text>
            </Box>

            {/* 可执行的上手清单（带跳转链接） */}
            <Box
              style={{
                background: 'var(--color-bg-secondary)',
                borderRadius: tokens.radius.xl,
                border: '1px solid var(--color-border-primary)',
                padding: tokens.spacing[5],
                marginBottom: tokens.spacing[5],
                textAlign: 'left',
              }}
            >
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                {t('proGetStarted')}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {[
                  { href: '/rankings', label: t('proStep1') },
                  { href: '/rankings', label: t('proStep2') },
                  { href: '/settings', label: t('proStep3') },
                ].map((step, i) => (
                  <Link key={i} href={step.href} style={{ textDecoration: 'none' }}>
                    <Box
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[3],
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        borderRadius: tokens.radius.lg,
                        background: 'var(--color-bg-primary)',
                        border: '1px solid var(--color-border-primary)',
                      }}
                    >
                      <Box
                        style={{
                          flexShrink: 0,
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          background: 'var(--color-pro-badge-bg)',
                          color: tokens.colors.white,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text size="xs" weight="bold" style={{ color: tokens.colors.white }}>
                          {i + 1}
                        </Text>
                      </Box>
                      <Text size="sm" color="secondary" style={{ flex: 1 }}>
                        {step.label}
                      </Text>
                      <Text size="sm" color="tertiary">
                        →
                      </Text>
                    </Box>
                  </Link>
                ))}
              </Box>
            </Box>

            {/* 推荐好友交叉销售 */}
            <Link href="/referral" style={{ textDecoration: 'none' }}>
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                  padding: tokens.spacing[4],
                  marginBottom: tokens.spacing[6],
                  borderRadius: tokens.radius.xl,
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border-primary)',
                  textAlign: 'left',
                }}
              >
                <Box style={{ flex: 1 }}>
                  <Text size="sm" weight="bold">
                    {t('inviteFriendsTitle')}
                  </Text>
                  <Text size="xs" color="secondary">
                    {t('inviteFriendsDesc')}
                  </Text>
                </Box>
                <Text size="sm" weight="bold" style={{ color: 'var(--color-accent-primary)' }}>
                  {t('inviteFriendsCta')} →
                </Text>
              </Box>
            </Link>

            {/* 按钮：主操作=第一价值动作（排行榜），次操作=随便逛逛 */}
            <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'center' }}>
              <Link href="/rankings" style={{ textDecoration: 'none' }}>
                <Button
                  variant="primary"
                  style={{
                    padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                    background: 'var(--color-pro-badge-bg)',
                    border: 'none',
                    boxShadow: '0 4px 12px var(--color-pro-badge-shadow)',
                  }}
                >
                  {t('exploreProRankings')}
                </Button>
              </Link>
              <Link href="/" style={{ textDecoration: 'none' }}>
                <Button
                  variant="secondary"
                  style={{ padding: `${tokens.spacing[3]} ${tokens.spacing[6]}` }}
                >
                  {t('startExploring')}
                </Button>
              </Link>
            </Box>

            {/* 收据安心提示 */}
            {email ? (
              <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[6] }}>
                {t('receiptSentTo').replace('{email}', email)}
              </Text>
            ) : (
              <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[6] }}>
                {t('receiptEmailed')}
              </Text>
            )}
          </>
        )}

        {/* 验证失败状态 */}
        {verificationStatus === 'error' && (
          <>
            <Box
              style={{
                marginBottom: tokens.spacing[6],
                color: 'var(--color-accent-warning, #f59e0b)',
              }}
            >
              <svg width={80} height={80} viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.15" />
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                <path d="M12 8V13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                <circle cx="12" cy="16.5" r="1.5" fill="currentColor" />
              </svg>
            </Box>

            <Text as="h1" size="2xl" weight="black" style={{ marginBottom: tokens.spacing[3] }}>
              {t('activationInProgress')}
            </Text>

            <Text size="md" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {t('paymentSuccessActivating')}
            </Text>

            <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[6] }}>
              {t('contactSupportIfFails')}
            </Text>

            <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'center' }}>
              <Button
                variant="primary"
                onClick={handleRetry}
                disabled={retrying}
                style={{
                  padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                  background: 'var(--color-pro-badge-bg)',
                  border: 'none',
                  boxShadow: '0 4px 12px var(--color-pro-badge-shadow)',
                }}
              >
                {retrying ? t('retrying') : t('retryActivation')}
              </Button>
              <Link href="/" style={{ textDecoration: 'none' }}>
                <Button
                  variant="secondary"
                  style={{ padding: `${tokens.spacing[3]} ${tokens.spacing[6]}` }}
                >
                  {t('backToHome')}
                </Button>
              </Link>
            </Box>
          </>
        )}
      </Box>
    </Box>
  )
}
