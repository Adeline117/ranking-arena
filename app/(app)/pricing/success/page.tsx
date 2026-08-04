'use client'

import { Suspense, useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { usePremium } from '@/lib/premium/hooks'
import { fetchVerifiedSubscription } from '@/lib/premium/subscription-client'
import { clearSubscriptionCache } from '@/app/components/home/hooks/useSubscription'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import { trackEvent } from '@/lib/analytics/track'
import { getAuthSession, refreshAuthToken } from '@/lib/auth'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { readVerifiedCheckoutSession } from '@/lib/stripe/verify-session-client'
import { PaymentSuccessLoadingFallback, PaymentSuccessState } from './PaymentSuccessState'

export default function PaymentSuccessPage() {
  return (
    <Suspense fallback={<PaymentSuccessLoadingFallback />}>
      <PaymentSuccessContent />
    </Suspense>
  )
}

function PaymentSuccessContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { language: _language, t } = useLanguage()
  const { showToast } = useToast()
  const { refresh: refreshPremium } = usePremium()
  const auth = useAuthSession()
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}`
  const authScopeRef = useRef({
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  })
  const verificationRequestKeyRef = useRef<string | null>(null)
  authScopeRef.current = {
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  }
  const captureRenderedScope = useCallback(
    () => ({
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
    }),
    [auth.sessionGeneration, auth.userId, auth.viewerKey]
  )
  const scopeIsCurrent = useCallback(
    (scope: { viewerKey: string; sessionGeneration: number; userId: string | null }) => {
      const current = authScopeRef.current
      return (
        current.viewerKey === scope.viewerKey &&
        current.sessionGeneration === scope.sessionGeneration &&
        current.userId === scope.userId
      )
    },
    []
  )

  const stateOwnerScopeKeyRef = useRef(scopeKey)
  const [emailState, setEmail] = useState<string | null>(null)
  const [verificationStatusState, setVerificationStatus] = useState<
    'verifying' | 'success' | 'error'
  >('verifying')
  const [hasVerifiedState, setHasVerified] = useState(false)
  const [retryingState, setRetrying] = useState(false)
  const stateScopeOwned = stateOwnerScopeKeyRef.current === scopeKey
  const email = stateScopeOwned ? emailState : null
  const verificationStatus = stateScopeOwned ? verificationStatusState : 'verifying'
  const hasVerified = stateScopeOwned ? hasVerifiedState : false
  const retrying = stateScopeOwned ? retryingState : false

  useEffect(() => {
    if (!auth.authChecked) return
    stateOwnerScopeKeyRef.current = scopeKey
    setEmail(auth.email)
    setVerificationStatus('verifying')
    setHasVerified(false)
    setRetrying(false)
  }, [auth.authChecked, auth.email, scopeKey])

  // Poll only the server's exact entitlement authority; never infer success
  // from the legacy subscriptions/profile projections in the browser.
  const checkSubscriptionDirect = useCallback(async (): Promise<boolean> => {
    const capturedScope = captureRenderedScope()
    if (!auth.authChecked || !scopeIsCurrent(capturedScope)) return false
    try {
      // 获取有效 session（自动刷新过期 token）
      const session = await getAuthSession()
      if (!session || session.userId !== capturedScope.userId || !scopeIsCurrent(capturedScope)) {
        return false
      }

      const subscription = await fetchVerifiedSubscription(session.accessToken, session.userId)
      return scopeIsCurrent(capturedScope) && subscription.tier === 'pro'
    } catch {
      return false
    }
  }, [auth.authChecked, captureRenderedScope, scopeIsCurrent])

  // 获取有效的 access token（自动刷新过期 token）
  const getValidAccessToken = useCallback(async (): Promise<string | null> => {
    const capturedScope = captureRenderedScope()
    if (!auth.authChecked || !scopeIsCurrent(capturedScope)) return null
    const session = await getAuthSession()
    return session?.userId === capturedScope.userId && scopeIsCurrent(capturedScope)
      ? session.accessToken
      : null
  }, [auth.authChecked, captureRenderedScope, scopeIsCurrent])

  // 验证并同步订阅状态
  const verifyAndRefresh = useCallback(async () => {
    const capturedScope = captureRenderedScope()
    if (!auth.authChecked || !scopeIsCurrent(capturedScope)) return
    const sessionId = searchParams.get('session_id')
    const verificationRequestKey = `${capturedScope.viewerKey}\u0000${capturedScope.sessionGeneration}\u0000${sessionId || ''}`
    if (hasVerified || verificationRequestKeyRef.current === verificationRequestKey) return

    // No session_id means the user reached this page without completing a real
    // Stripe checkout (bare access). Do NOT claim success — send them back to
    // pricing rather than showing a "payment succeeded" state.
    if (!sessionId) {
      router.replace('/pricing')
      return
    }

    verificationRequestKeyRef.current = verificationRequestKey
    setHasVerified(true)
    setVerificationStatus('verifying')

    try {
      // Obtain the current viewer token; verify-session also binds the Stripe
      // session metadata to this authenticated identity on the server.
      const accessToken = await getValidAccessToken()
      if (!scopeIsCurrent(capturedScope)) return

      // A missing token produces an explicit 401 and then follows the same
      // bounded refresh + authority-poll path below.
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
      if (!scopeIsCurrent(capturedScope)) return

      const responseData: unknown = await response.json().catch(() => null)
      if (response.ok && readVerifiedCheckoutSession(responseData)) {
        if (!scopeIsCurrent(capturedScope)) return

        // 验证成功后，尝试刷新 auth session 以获取最新状态
        if (!accessToken) {
          // token 过期了，尝试刷新
          await refreshAuthToken()
          if (!scopeIsCurrent(capturedScope)) return
        }

        clearSubscriptionCache()
        await refreshPremium()
        if (!scopeIsCurrent(capturedScope)) return
        setVerificationStatus('success')
        trackEvent('pro_subscribe', { source: 'verify_api' })
        showToast(t('membershipActivated'), 'success')
        return
      }

      // API 返回非 200，记录错误
      logger.error('[Payment Success] Verification API error:', responseData || response.status)

      // 验证 API 失败，可能 webhook 已经处理了，通过轮询数据库确认
      // 先尝试刷新 session 以确保后续查询有有效 token
      if (!accessToken) {
        await refreshAuthToken()
        if (!scopeIsCurrent(capturedScope)) return
      }
      clearSubscriptionCache()

      // 轮询检查（最多尝试 4 次，间隔缩短以减少等待）
      const delays = [800, 1200, 1500, 2000]
      for (const delay of delays) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        if (!scopeIsCurrent(capturedScope)) return
        const isProNow = await checkSubscriptionDirect()
        if (isProNow) {
          await refreshPremium()
          if (!scopeIsCurrent(capturedScope)) return
          setVerificationStatus('success')
          showToast(t('membershipActivated'), 'success')
          return
        }
      }

      // 所有重试都失败
      setVerificationStatus('error')
    } catch (error) {
      if (!scopeIsCurrent(capturedScope)) return
      logger.error('Failed to verify subscription:', error)

      // 清除缓存，尝试刷新 session 后直接查询确认
      await refreshAuthToken()
      if (!scopeIsCurrent(capturedScope)) return
      clearSubscriptionCache()
      const isProNow = await checkSubscriptionDirect()
      if (isProNow) {
        await refreshPremium()
        if (!scopeIsCurrent(capturedScope)) return
        setVerificationStatus('success')
        trackEvent('pro_subscribe', { source: 'verify_api' })
        showToast(t('membershipActivated'), 'success')
      } else {
        setVerificationStatus('error')
      }
    } finally {
      if (verificationRequestKeyRef.current === verificationRequestKey) {
        verificationRequestKeyRef.current = null
      }
    }
  }, [
    searchParams,
    auth.authChecked,
    captureRenderedScope,
    hasVerified,
    refreshPremium,
    showToast,
    t,
    checkSubscriptionDirect,
    getValidAccessToken,
    router,
    scopeIsCurrent,
  ])

  // 手动重试 - 先刷新 session，再触发重新验证
  const handleRetry = useCallback(async () => {
    const capturedScope = captureRenderedScope()
    if (!auth.authChecked || !scopeIsCurrent(capturedScope)) return
    setRetrying(true)
    setVerificationStatus('verifying')
    // 重试前先尝试刷新 session
    await refreshAuthToken()
    if (!scopeIsCurrent(capturedScope)) return
    clearSubscriptionCache()
    setHasVerified(false)
    // hasVerified 重置后 verifyAndRefresh 的 useEffect 会重新触发
  }, [auth.authChecked, captureRenderedScope, scopeIsCurrent])

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
    <PaymentSuccessState
      status={verificationStatus}
      email={email}
      retrying={retrying}
      onRetry={handleRetry}
      t={t}
    />
  )
}
