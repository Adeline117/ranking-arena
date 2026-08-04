'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { ButtonSpinner } from './LoadingSpinner'
import { tokens } from '@/lib/design-tokens'
import { useFollowSync, type FollowChangePayload } from '@/lib/hooks/useBroadcastSync'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { authedFetch } from '@/lib/api/client'
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
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import { readTraderFollowAcknowledgement } from '@/lib/follows/trader-follow-contract'

type TraderFollowButtonProps = {
  traderId: string
  /** Exchange/source for this account. Needed to deliver account-specific events. */
  source?: string
  userId: string | null
  initialFollowing?: boolean
  loginReturnPath?: string
  onFollowChange?: (following: boolean) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readApiErrorMessage(value: unknown): string {
  if (!isRecord(value)) return ''
  if (typeof value.error === 'string') return value.error
  return isRecord(value.error) && typeof value.error.message === 'string' ? value.error.message : ''
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
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const exactRenderViewer = useMemo(() => {
    const viewer = captureSettingsViewer(auth)
    return viewer?.userId === userId ? viewer : null
  }, [auth, userId])
  const resourceScopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${userId ?? 'anonymous'}\u0000${source ?? ''}\u0000${traderId}`
  const resourceScopeKeyRef = useRef(resourceScopeKey)
  resourceScopeKeyRef.current = resourceScopeKey
  const [following, setFollowing] = useState(initialFollowing)
  const [featureDisabled, setFeatureDisabled] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [showPulse, setShowPulse] = useState(false)
  const activeMutationRef = useRef<{
    controller: AbortController
    resourceScopeKey: string
    viewer: SettingsViewerSnapshot
  } | null>(null)

  // 防止重复点击的锁
  const pendingRef = useRef(false)
  // 跟踪期望的状态（用于乐观更新）
  const expectedStateRef = useRef<boolean | null>(null)
  // 超时保护计时器
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const captureExactViewer = useCallback((): SettingsViewerSnapshot | null => {
    const viewer = captureSettingsViewer(authRef.current)
    return viewer?.userId === userId && resourceScopeKeyRef.current === resourceScopeKey
      ? viewer
      : null
  }, [resourceScopeKey, userId])

  const viewerIsCurrent = useCallback(
    (viewer: SettingsViewerSnapshot): boolean =>
      resourceScopeKeyRef.current === resourceScopeKey &&
      viewer.userId === userId &&
      isSettingsViewerCurrent(viewer, authRef.current),
    [resourceScopeKey, userId]
  )

  // 清理超时计时器
  useEffect(() => {
    return () => {
      activeMutationRef.current?.controller.abort()
      activeMutationRef.current = null
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const mutation = activeMutationRef.current
    if (mutation && mutation.resourceScopeKey !== resourceScopeKey) {
      mutation.controller.abort()
      activeMutationRef.current = null
    }
    pendingRef.current = false
    expectedStateRef.current = null
    setIsLoading(false)
    setFollowing(initialFollowing)
    setFeatureDisabled(false)
  }, [initialFollowing, resourceScopeKey])

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
          initiatingUserId: userId,
        })
      )
    },
    [loginReturnPath, router, showToast, source, t, traderId, userId]
  )

  // 刷新关注状态（从服务器获取真实状态）
  const refreshFollowState = useCallback(async () => {
    if (!userId || !source) return
    const viewer = captureExactViewer()
    if (!viewer) return

    try {
      const query = new URLSearchParams({ traderId })
      if (source) query.set('source', source)
      const result = await authedFetch<unknown>(
        `/api/follow?${query.toString()}`,
        'GET',
        viewer.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: viewer.userId,
          expectedSessionGeneration: viewer.sessionGeneration,
        }
      )
      if (result.stale || !viewerIsCurrent(viewer) || !result.ok) return
      const acknowledgement = readTraderFollowAcknowledgement(result.data, {
        traderId,
        source,
        allowTableNotFound: true,
      })
      if (!acknowledgement) return
      if (acknowledgement.tableNotFound) {
        setFeatureDisabled(true)
        return
      }
      setFollowing(acknowledgement.following)
      onFollowChange?.(acknowledgement.following)
    } catch {
      // Intentionally swallowed: follow state refresh failed, UI uses cached/optimistic value
    }
  }, [captureExactViewer, onFollowChange, source, traderId, userId, viewerIsCurrent])

  // 执行关注/取消关注操作
  const executeFollow = useCallback(
    async (action: 'follow' | 'unfollow'): Promise<boolean> => {
      if (!source || activeMutationRef.current) return false
      const viewer = captureExactViewer()
      if (!viewer) return false

      const abortController = new AbortController()
      const operation = {
        controller: abortController,
        resourceScopeKey,
        viewer,
      }
      activeMutationRef.current = operation
      setIsLoading(true)
      let timedOut = false

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      const timeout = new Promise<never>((_, reject) => {
        timeoutRef.current = setTimeout(() => {
          timedOut = true
          abortController.abort()
          const error = new Error('Trader follow request timed out')
          error.name = 'AbortError'
          reject(error)
        }, 8000)
      })

      try {
        const result = await Promise.race([
          authedFetch<unknown>(
            '/api/follow',
            'POST',
            operation.viewer.accessToken,
            { traderId, source, action },
            15_000,
            {
              expectedUserId: operation.viewer.userId,
              expectedSessionGeneration: operation.viewer.sessionGeneration,
              signal: abortController.signal,
            }
          ),
          timeout,
        ])

        // Clear timeout protection as soon as the server responds.
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }

        if (
          result.stale ||
          activeMutationRef.current !== operation ||
          !viewerIsCurrent(operation.viewer)
        ) {
          return false
        }

        if (result.status === 401) {
          pendingRef.current = false
          if (expectedStateRef.current !== null) {
            setFollowing(!expectedStateRef.current)
            expectedStateRef.current = null
          }
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          redirectToLogin(action === 'follow' ? 'follow-trader' : 'unfollow-trader')
          return false
        }

        pendingRef.current = false
        // NOTE: do NOT clear expectedStateRef here — the catch block relies on
        // it to roll back the optimistic flip when the server returns an error.
        // (Previously it was nulled before the response.ok check, so a 500 left
        // the button stuck in the optimistic "Following" state.)

        if (!result.ok) {
          const apiErrMsg = readApiErrorMessage(result.data)
          throw new Error(apiErrMsg || t('operationFailed'))
        }
        const expectedFollowing = action === 'follow'
        if (
          !readTraderFollowAcknowledgement(result.data, {
            following: expectedFollowing,
            traderId,
            source,
          })
        ) {
          throw new Error(t('operationFailed'))
        }

        expectedStateRef.current = null
        setFollowing(expectedFollowing)
        onFollowChange?.(expectedFollowing)

        // Trigger pulse animation
        setShowPulse(true)
        setTimeout(() => {
          if (viewerIsCurrent(operation.viewer)) setShowPulse(false)
        }, 600)

        // Analytics tracking
        if (expectedFollowing) {
          trackEvent('follow_trader', { trader_id: traderId })
        }

        // Haptic feedback + success toast
        haptic('success')
        showToast(expectedFollowing ? t('followSuccess') : t('unfollowSuccess'), 'success')

        // 广播状态变化到其他窗口
        if (userId) {
          broadcast('FOLLOW_CHANGED', {
            traderId,
            source,
            following: expectedFollowing,
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
        if (activeMutationRef.current !== operation || !viewerIsCurrent(operation.viewer)) {
          return false
        }
        pendingRef.current = false
        // 回滚乐观更新
        if (expectedStateRef.current !== null) {
          setFollowing(!expectedStateRef.current)
          expectedStateRef.current = null
        }
        if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
          void refreshFollowState()
          showToast(t('timeoutRetry'), 'warning')
          return false
        }
        const errorMsg = error instanceof Error ? error.message : t('operationFailed')
        if (errorMsg.includes('table') || errorMsg.includes('503')) {
          setFeatureDisabled(true)
          showToast(t('followFeatureComingSoon'), 'info')
        } else {
          const isNetworkError = error instanceof TypeError && error.message.includes('fetch')
          showToast(isNetworkError ? `${errorMsg} — ${t('tapToRetry')}` : errorMsg, 'error')
        }
        return false
      } finally {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        if (activeMutationRef.current === operation) {
          activeMutationRef.current = null
          pendingRef.current = false
          if (viewerIsCurrent(operation.viewer)) setIsLoading(false)
        }
      }
    },
    [
      broadcast,
      captureExactViewer,
      onFollowChange,
      redirectToLogin,
      refreshFollowState,
      resourceScopeKey,
      showToast,
      source,
      t,
      traderId,
      userId,
      viewerIsCurrent,
    ]
  )

  // Resume only the short-lived, path-bound login proof. Older releases wrote
  // an unbounded `pendingFollow` record; clear it without executing so a stale
  // tab can never follow someone days later.
  useEffect(() => {
    if (!exactRenderViewer || !userId || !traderId || !source) return
    try {
      sessionStorage.removeItem('pendingFollow')
    } catch {
      // Storage can be unavailable; there is still no legacy execution path.
    }

    const action = consumeProfileActionLogin({
      actions: ['follow-trader', 'unfollow-trader'],
      target: profileTraderTarget(source, traderId),
      currentUserId: userId,
    })
    if (action) {
      pendingRef.current = true
      void executeFollow(action === 'follow-trader' ? 'follow' : 'unfollow')
      return
    }
  }, [exactRenderViewer, userId, traderId, source]) // eslint-disable-line react-hooks/exhaustive-deps -- intentional: only resume pending follow when account identity changes; executeFollow and onFollowChange are stable refs

  useEffect(() => {
    // The pending-login effect above may already be resuming a follow. Do not
    // start a concurrent pre-mutation status read that can land after the POST.
    if (!exactRenderViewer || !userId || !source || pendingRef.current) return
    const viewer = exactRenderViewer

    const abortController = new AbortController()

    ;(async () => {
      try {
        const query = new URLSearchParams({ traderId })
        if (source) query.set('source', source)
        const result = await authedFetch<unknown>(
          `/api/follow?${query.toString()}`,
          'GET',
          viewer.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: viewer.userId,
            expectedSessionGeneration: viewer.sessionGeneration,
            signal: abortController.signal,
          }
        )
        if (result.stale || !viewerIsCurrent(viewer) || !result.ok) return
        const acknowledgement = readTraderFollowAcknowledgement(result.data, {
          traderId,
          source,
          allowTableNotFound: true,
        })
        if (acknowledgement?.tableNotFound) {
          if (!pendingRef.current) setFeatureDisabled(true)
          return
        }
        // 只有在没有待处理操作时才更新状态
        if (!pendingRef.current && acknowledgement) {
          setFollowing(acknowledgement.following)
        }
      } catch (error) {
        if (viewerIsCurrent(viewer) && (error as Error).name !== 'AbortError') {
          logger.error('Check following error:', error)
        }
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [exactRenderViewer, source, traderId, userId, viewerIsCurrent])

  const handleToggle = useCallback(() => {
    if (!userId) {
      redirectToLogin('follow-trader')
      return
    }
    if (!source) {
      showToast(t('operationFailed'), 'error')
      return
    }
    if (!captureExactViewer()) {
      if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
        redirectToLogin('follow-trader')
      }
      return
    }

    // 防止重复点击
    if (pendingRef.current || isLoading) {
      return
    }

    pendingRef.current = true
    const newState = !following
    expectedStateRef.current = newState

    // 乐观更新 UI
    setFollowing(newState)

    executeFollow(newState ? 'follow' : 'unfollow')
  }, [
    captureExactViewer,
    executeFollow,
    following,
    isLoading,
    redirectToLogin,
    showToast,
    source,
    t,
    userId,
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
          fontWeight: tokens.typography.fontWeight.bold,
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
          fontWeight: tokens.typography.fontWeight.bold,
          fontSize: tokens.typography.fontSize.sm,
          cursor: 'pointer',
        }}
      >
        {t('follow')}
      </button>
    )
  }

  const authPending =
    !exactRenderViewer && (!auth.authChecked || auth.loading || Boolean(auth.userId))
  const buttonDisabled = isLoading || authPending

  return (
    <button
      onClick={handleToggle}
      disabled={buttonDisabled}
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
        fontWeight: tokens.typography.fontWeight.black,
        fontSize: tokens.typography.fontSize.base,
        cursor: buttonDisabled ? 'not-allowed' : 'pointer',
        opacity: buttonDisabled ? 0.6 : 1,
        transition: tokens.transition.base,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[2],
      }}
      onMouseEnter={(e) => {
        if (!buttonDisabled) e.currentTarget.style.opacity = '0.85'
      }}
      onMouseLeave={(e) => {
        if (!buttonDisabled) e.currentTarget.style.opacity = '1'
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
