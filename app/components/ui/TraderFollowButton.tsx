'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { ButtonSpinner } from './LoadingSpinner'
import { tokens } from '@/lib/design-tokens'
import { useFollowSync, type FollowChangePayload } from '@/lib/hooks/useBroadcastSync'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import { haptic } from '@/lib/utils/haptics'
import { trackEvent } from '@/lib/analytics/track'
import {
  consumeProfileActionLogin,
  profileTraderTarget,
  queueProfileActionLogin,
  type ProfileActionIntent,
} from '@/lib/auth/profile-action-login'

type TraderFollowButtonProps = {
  traderId: string
  /** Exchange/source for this account. Needed to deliver account-specific events. */
  source?: string
  userId: string | null
  initialFollowing?: boolean
  loginReturnPath?: string
  onFollowChange?: (following: boolean) => void
}

type _FollowResponse = {
  following: boolean
  success?: boolean
  tableNotFound?: boolean
  error?: string
}

/**
 * 关注交易员的按钮
 * 用于 trader 页面，关注/取消关注交易员
 *
 * 区分于 UserFollowButton（用于关注平台用户）
 */
export default function TraderFollowButton({
  traderId,
  source,
  userId,
  initialFollowing = false,
  loginReturnPath,
  onFollowChange,
}: TraderFollowButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const { getAuthHeadersAsync } = useAuthSession()
  const [following, setFollowing] = useState(initialFollowing)
  const [featureDisabled, setFeatureDisabled] = useState(false)

  // 防止重复点击的锁
  const pendingRef = useRef(false)
  // 跟踪期望的状态（用于乐观更新）
  const expectedStateRef = useRef<boolean | null>(null)
  // 超时保护计时器
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  // Network error retry counter (max 2 retries)
  const retryCountRef = useRef(0)

  // 清理超时计时器
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  // 多窗口同步
  const { broadcast, on } = useFollowSync()

  // 监听其他窗口的关注状态变化
  useEffect(() => {
    const unsubscribe = on('FOLLOW_CHANGED', (payload: FollowChangePayload) => {
      // 只处理同一交易员的状态变化
      if (payload.traderId === traderId && payload.source === source && payload.userId === userId) {
        // 避免在有待处理操作时更新
        if (!pendingRef.current) {
          setFollowing(payload.following)
          onFollowChange?.(payload.following)
        }
      }
    })

    return unsubscribe
  }, [traderId, source, userId, on, onFollowChange])

  // Loading state for follow action
  const [isLoading, setIsLoading] = useState(false)
  // Pulse animation on follow state change
  const [showPulse, setShowPulse] = useState(false)
  const redirectToLogin = useCallback(
    (action: ProfileActionIntent) => {
      if (!source) {
        showToast(t('operationFailed'), 'error')
        return
      }
      router.push(
        queueProfileActionLogin({
          action,
          target: profileTraderTarget(source, traderId),
          fallbackPath: loginReturnPath,
        })
      )
    },
    [loginReturnPath, router, showToast, source, t, traderId]
  )

  // 刷新关注状态（从服务器获取真实状态）
  const refreshFollowState = useCallback(async () => {
    if (!userId || !source) return

    try {
      const authHeaders = await getAuthHeadersAsync()
      const query = new URLSearchParams({ traderId })
      if (source) query.set('source', source)
      const response = await fetch(`/api/follow?${query.toString()}`, {
        headers: authHeaders,
      })

      if (response.ok) {
        const data = await response.json()
        const actualFollowing = data.following ?? data.data?.following
        if (typeof actualFollowing === 'boolean') {
          setFollowing(actualFollowing)
          onFollowChange?.(actualFollowing)
        }
      }
    } catch {
      // Intentionally swallowed: follow state refresh failed, UI uses cached/optimistic value
    }
  }, [userId, traderId, source, getAuthHeadersAsync, onFollowChange])

  // 执行关注/取消关注操作
  const executeFollow = useCallback(
    async (action: 'follow' | 'unfollow'): Promise<boolean> => {
      setIsLoading(true)
      try {
        if (!source) throw new Error('Trader source is unavailable')
        const authHeaders = await getAuthHeadersAsync()
        const csrfHeaders = getCsrfHeaders()
        const response = await fetch('/api/follow', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
            ...csrfHeaders,
          },
          body: JSON.stringify({ traderId, source, action }),
        })

        // Clear timeout protection as soon as the server responds.
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }

        if (response.status === 401) {
          pendingRef.current = false
          if (expectedStateRef.current !== null) {
            setFollowing(!expectedStateRef.current)
            expectedStateRef.current = null
          }
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          redirectToLogin(action === 'follow' ? 'follow-trader' : 'unfollow-trader')
          return false
        }

        const result = await response.json()
        const data = result.data || result // Handle wrapped or unwrapped response

        pendingRef.current = false
        // NOTE: do NOT clear expectedStateRef here — the catch block relies on
        // it to roll back the optimistic flip when the server returns an error.
        // (Previously it was nulled before the response.ok check, so a 500 left
        // the button stuck in the optimistic "Following" state.)

        if (data.tableNotFound) {
          expectedStateRef.current = null
          setFeatureDisabled(true)
          showToast(t('followFeatureComingSoon'), 'info')
          return false
        }

        if (!response.ok) {
          // API error payload may be a string or { code, message } object
          const apiErr = data.error
          const apiErrMsg = typeof apiErr === 'string' ? apiErr : apiErr?.message
          throw new Error(apiErrMsg || t('operationFailed'))
        }
        if (typeof data.following !== 'boolean') {
          throw new Error(t('operationFailed'))
        }

        expectedStateRef.current = null
        setFollowing(data.following)
        onFollowChange?.(data.following)
        retryCountRef.current = 0

        // Trigger pulse animation
        setShowPulse(true)
        setTimeout(() => setShowPulse(false), 600)

        // Analytics tracking
        if (data.following) {
          trackEvent('follow_trader', { trader_id: traderId })
        }

        // Haptic feedback + success toast
        haptic('success')
        showToast(data.following ? t('followSuccess') : t('unfollowSuccess'), 'success')

        // 广播状态变化到其他窗口
        if (userId) {
          broadcast('FOLLOW_CHANGED', {
            traderId,
            source,
            following: data.following,
            userId,
          })
        }
        return true
      } catch (error: unknown) {
        // 清除超时保护
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        pendingRef.current = false
        const failedAction = action
        // 回滚乐观更新
        if (expectedStateRef.current !== null) {
          setFollowing(!expectedStateRef.current)
          expectedStateRef.current = null
        }
        const errorMsg = error instanceof Error ? error.message : t('operationFailed')
        if (errorMsg.includes('table') || errorMsg.includes('503')) {
          setFeatureDisabled(true)
          showToast(t('followFeatureComingSoon'), 'info')
        } else {
          // #22: Show retry hint on network error (max 2 auto-retries)
          const isNetworkError = error instanceof TypeError && error.message.includes('fetch')
          showToast(isNetworkError ? `${errorMsg} — ${t('tapToRetry')}` : errorMsg, 'error')
          if (isNetworkError && retryCountRef.current < 2) {
            retryCountRef.current++
            setTimeout(() => executeFollow(failedAction), 2000)
          }
        }
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [
      traderId,
      source,
      userId,
      getAuthHeadersAsync,
      showToast,
      broadcast,
      onFollowChange,
      t,
      redirectToLogin,
    ]
  )

  // UF8: Resume pending follow action after login
  useEffect(() => {
    if (!userId || !traderId || !source) return
    const action = consumeProfileActionLogin({
      actions: ['follow-trader', 'unfollow-trader'],
      target: profileTraderTarget(source, traderId),
    })
    if (action) {
      pendingRef.current = true
      void executeFollow(action === 'follow-trader' ? 'follow' : 'unfollow')
      return
    }

    try {
      const pending = sessionStorage.getItem('pendingFollow')
      if (pending) {
        const { traderId: pendingTraderId, source: pendingSource, action } = JSON.parse(pending)
        if (
          pendingTraderId === traderId &&
          pendingSource === source &&
          action === 'follow' &&
          !following
        ) {
          sessionStorage.removeItem('pendingFollow')
          // Keep the mount-time status refresh from overwriting this request with
          // a stale pre-mutation snapshot. executeFollow clears the lock and only
          // applies the state returned by a successful response.
          pendingRef.current = true
          void executeFollow('follow')
        } else {
          sessionStorage.removeItem('pendingFollow')
        }
      }
    } catch {
      /* intentionally empty */
    }
  }, [userId, traderId, source]) // eslint-disable-line react-hooks/exhaustive-deps -- intentional: only resume pending follow when account identity changes; executeFollow and onFollowChange are stable refs

  useEffect(() => {
    // The pending-login effect above may already be resuming a follow. Do not
    // start a concurrent pre-mutation status read that can land after the POST.
    if (!userId || !source || pendingRef.current) return

    const abortController = new AbortController()

    ;(async () => {
      try {
        const authHeaders = await getAuthHeadersAsync()
        const query = new URLSearchParams({ traderId })
        if (source) query.set('source', source)
        const response = await fetch(`/api/follow?${query.toString()}`, {
          signal: abortController.signal,
          headers: authHeaders,
        })
        if (response.ok) {
          const data = await response.json()
          // 只有在没有待处理操作时才更新状态
          const actualFollowing = data.following ?? data.data?.following
          if (!pendingRef.current && typeof actualFollowing === 'boolean') {
            setFollowing(actualFollowing)
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          logger.error('Check following error:', error)
        }
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [userId, traderId, source, getAuthHeadersAsync])

  const handleToggle = useCallback(() => {
    if (!userId) {
      redirectToLogin('follow-trader')
      return
    }
    if (!source) {
      showToast(t('operationFailed'), 'error')
      return
    }

    // 防止重复点击
    if (pendingRef.current || isLoading) {
      return
    }

    pendingRef.current = true
    const newState = !following
    expectedStateRef.current = newState

    // 超时保护：8秒后自动解锁，防止永久锁定 (unified with UserFollowButton)
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = setTimeout(() => {
      if (pendingRef.current) {
        pendingRef.current = false
        expectedStateRef.current = null
        // 获取服务器的真实状态而不是简单回滚
        refreshFollowState()
        showToast(t('timeoutRetry'), 'warning')
      }
    }, 8000)

    // 乐观更新 UI
    setFollowing(newState)

    executeFollow(newState ? 'follow' : 'unfollow')
  }, [
    userId,
    source,
    following,
    isLoading,
    executeFollow,
    showToast,
    refreshFollowState,
    t,
    redirectToLogin,
  ])

  // 功能未开放时显示禁用状态
  if (featureDisabled) {
    return (
      <button
        disabled
        title={t('followFeatureComingSoon')}
        style={{
          width: 'auto',
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.lg,
          border: tokens.glass.border.light,
          background: tokens.glass.bg.light,
          color: tokens.colors.text.tertiary,
          fontWeight: 700,
          fontSize: tokens.typography.fontSize.base,
          cursor: 'not-allowed',
          opacity: 0.5,
        }}
      >
        {t('followFeatureComingSoon')}
      </button>
    )
  }

  if (!userId) {
    return (
      <button
        onClick={() => {
          redirectToLogin('follow-trader')
        }}
        style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.md,
          border: tokens.glass.border.light,
          background: tokens.glass.bg.light,
          color: tokens.colors.text.primary,
          fontWeight: 700,
          fontSize: tokens.typography.fontSize.sm,
          cursor: 'pointer',
        }}
      >
        {t('follow')}
      </button>
    )
  }

  return (
    <button
      onClick={handleToggle}
      disabled={isLoading}
      aria-label={following ? t('unfollowTrader') : t('followTrader')}
      aria-pressed={following}
      aria-busy={isLoading}
      className={`interactive-scale${showPulse ? ' follow-pulse' : ''}`}
      style={{
        width: 'auto',
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        borderRadius: tokens.radius.lg,
        border: following ? tokens.glass.border.light : 'none',
        background: following ? tokens.glass.bg.light : tokens.colors.accent.brand,
        // following bg is the theme-aware glass tint (light theme ≈ near-white), so
        // hard white text went invisible there. Use theme-aware text in that state.
        color: following ? 'var(--color-text-primary)' : tokens.colors.white,
        fontWeight: 900,
        fontSize: tokens.typography.fontSize.base,
        cursor: isLoading ? 'not-allowed' : 'pointer',
        opacity: isLoading ? 0.6 : 1,
        transition: tokens.transition.base,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[2],
      }}
      onMouseEnter={(e) => {
        if (!isLoading) e.currentTarget.style.opacity = '0.85'
      }}
      onMouseLeave={(e) => {
        if (!isLoading) e.currentTarget.style.opacity = '1'
      }}
    >
      {isLoading && <ButtonSpinner size="xs" />}
      {isLoading
        ? following
          ? t('unfollowingAction')
          : t('followingAction')
        : following
          ? t('unfollow')
          : t('follow')}
    </button>
  )
}
