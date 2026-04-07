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
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { logger } from '@/lib/logger'
import { haptic } from '@/lib/utils/haptics'
import { trackEvent } from '@/lib/analytics/track'

type TraderFollowButtonProps = {
  traderId: string
  userId: string | null
  initialFollowing?: boolean
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
export default function TraderFollowButton({ traderId, userId, initialFollowing = false, onFollowChange }: TraderFollowButtonProps) {
  const _router = useRouter()
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
      if (payload.traderId === traderId && payload.userId === userId) {
        // 避免在有待处理操作时更新
        if (!pendingRef.current) {
          setFollowing(payload.following)
          onFollowChange?.(payload.following)
        }
      }
    })

    return unsubscribe
  }, [traderId, userId, on, onFollowChange])

  // Loading state for follow action
  const [isLoading, setIsLoading] = useState(false)
  // Pulse animation on follow state change
  const [showPulse, setShowPulse] = useState(false)

  // 刷新关注状态（从服务器获取真实状态）
  const refreshFollowState = useCallback(async () => {
    if (!userId) return

    try {
      const authHeaders = await getAuthHeadersAsync()
      const response = await fetch(`/api/follow?traderId=${traderId}`, {
        headers: authHeaders,
      })

      if (response.ok) {
        const data = await response.json()
        const actualFollowing = data.following || data.data?.following
        setFollowing(actualFollowing)
        onFollowChange?.(actualFollowing)
      }
    } catch {
      // Intentionally swallowed: follow state refresh failed, UI uses cached/optimistic value
    }
  }, [userId, traderId, getAuthHeadersAsync, onFollowChange])

  // 执行关注/取消关注操作
  const executeFollow = useCallback(async (action: 'follow' | 'unfollow') => {
    setIsLoading(true)
    try {
      const authHeaders = await getAuthHeadersAsync()
      const csrfHeaders = getCsrfHeaders()
      const response = await fetch('/api/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...csrfHeaders,
        },
        body: JSON.stringify({ traderId, action }),
      })

      const result = await response.json()
      const data = result.data || result // Handle wrapped or unwrapped response

      // 清除超时保护
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      pendingRef.current = false
      expectedStateRef.current = null

      if (data.tableNotFound) {
        setFeatureDisabled(true)
        showToast(t('followFeatureComingSoon'), 'info')
        return
      }

      if (!response.ok) {
        throw new Error(data.error || t('operationFailed'))
      }

      setFollowing(data.following)
      onFollowChange?.(data.following)

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
          following: data.following,
          userId,
        })
      }
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
        // #22: Show retry hint on network error
        const isNetworkError = error instanceof TypeError && error.message.includes('fetch')
        showToast(isNetworkError ? `${errorMsg} — ${t('tapToRetry') || 'Tap to retry'}` : errorMsg, 'error')
        if (isNetworkError) {
          setTimeout(() => executeFollow(failedAction), 2000)
        }
      }
    } finally {
      setIsLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is excluded to avoid re-creating callback on language change; translations are read at call time
  }, [traderId, userId, getAuthHeadersAsync, showToast, broadcast, onFollowChange])

  // UF8: Resume pending follow action after login
  useEffect(() => {
    if (!userId || !traderId) return
    try {
      const pending = sessionStorage.getItem('pendingFollow')
      if (pending) {
        const { traderId: pendingTraderId, action } = JSON.parse(pending)
        if (pendingTraderId === traderId && action === 'follow' && !following) {
          sessionStorage.removeItem('pendingFollow')
          // Auto-execute the follow
          executeFollow('follow').then(() => {
            setFollowing(true)
            onFollowChange?.(true)
          })
        } else {
          sessionStorage.removeItem('pendingFollow')
        }
      }
    } catch { /* intentionally empty */ }
  }, [userId, traderId]) // eslint-disable-line react-hooks/exhaustive-deps -- intentional: only resume pending follow when userId/traderId change; executeFollow and onFollowChange are stable refs

  useEffect(() => {
    if (!userId) return

    const abortController = new AbortController()

    ;(async () => {
      try {
        const authHeaders = await getAuthHeadersAsync()
        const response = await fetch(
          `/api/follow?traderId=${traderId}`,
          {
            signal: abortController.signal,
            headers: authHeaders,
          }
        )
        if (response.ok) {
          const data = await response.json()
          // 只有在没有待处理操作时才更新状态
          if (!pendingRef.current) {
            setFollowing(data.following || data.data?.following)
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
  }, [userId, traderId, getAuthHeadersAsync])

  const handleToggle = useCallback(() => {
    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
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
  }, [userId, following, isLoading, executeFollow, showToast, refreshFollowState, t])

  // 功能未开放时显示禁用状态
  if (featureDisabled) {
    return (
      <button
        disabled
        title={t('followFeatureComingSoon')}
        style={{
          width: 'auto',
          padding: '12px 16px',
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
          // UF8: Save pending follow action for after login
          if (typeof window !== 'undefined') {
            sessionStorage.setItem('pendingFollow', JSON.stringify({ traderId, action: 'follow' }))
          }
          useLoginModal.getState().openLoginModal()
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
        color: tokens.colors.white,
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
      onMouseEnter={(e) => { if (!isLoading) e.currentTarget.style.opacity = '0.85' }}
      onMouseLeave={(e) => { if (!isLoading) e.currentTarget.style.opacity = '1' }}
    >
      {isLoading && <ButtonSpinner size="xs" />}
      {isLoading ? (following ? t('unfollowingAction') : t('followingAction')) : following ? t('unfollow') : t('follow')}
    </button>
  )
}

