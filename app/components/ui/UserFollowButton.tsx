'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { ButtonSpinner } from './LoadingSpinner'
import { tokens } from '@/lib/design-tokens'
import { BUTTON_SIZE_STYLES } from './button-styles'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useUserFollowSync, type UserFollowChangePayload } from '@/lib/hooks/useBroadcastSync'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import { haptic } from '@/lib/utils/haptics'
import { getCsrfHeaders } from '@/lib/api/client'
import {
  consumeProfileActionLogin,
  profileUserTarget,
  queueProfileActionLogin,
  type ProfileActionIntent,
} from '@/lib/auth/profile-action-login'

type UserFollowButtonProps = {
  targetUserId: string
  currentUserId: string | null
  initialFollowing?: boolean
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  loginReturnPath?: string
  onFollowChange?: (following: boolean, mutual: boolean) => void
}

/**
 * 关注用户的按钮
 * 用于用户主页，关注/取消关注平台用户
 *
 * 区分于 TraderFollowButton（用于关注交易员）
 */
export default function UserFollowButton({
  targetUserId,
  currentUserId,
  initialFollowing = false,
  size = 'md',
  fullWidth = false,
  loginReturnPath,
  onFollowChange,
}: UserFollowButtonProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const { getAuthHeadersAsync } = useAuthSession()
  const [following, setFollowing] = useState(initialFollowing)
  const [followedBy, setFollowedBy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true) // 初始加载状态
  const pendingRef = useRef(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Cross-tab follow sync
  const { broadcast, on } = useUserFollowSync()
  useEffect(() => {
    const unsubscribe = on('FOLLOW_CHANGED', (payload: UserFollowChangePayload) => {
      if (payload.targetUserId === targetUserId && payload.currentUserId === currentUserId) {
        if (!pendingRef.current) {
          setFollowing(payload.following)
          onFollowChange?.(payload.following, false)
        }
      }
    })
    return unsubscribe
  }, [targetUserId, currentUserId, on, onFollowChange])

  // 清理超时计时器
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!currentUserId || currentUserId === targetUserId) {
      setInitialLoading(false)
      return
    }

    const abortController = new AbortController()

    ;(async () => {
      try {
        const authHeaders = await getAuthHeadersAsync()
        const response = await fetch(`/api/users/follow?followingId=${targetUserId}`, {
          signal: abortController.signal,
          headers: authHeaders,
        })
        if (response.ok) {
          const data = await response.json()
          setFollowing(data.following)
          setFollowedBy(data.followedBy)
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          logger.error('Check following error:', error)
        }
      } finally {
        setInitialLoading(false)
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [currentUserId, targetUserId, getAuthHeadersAsync])

  const redirectToLogin = useCallback(
    (action: ProfileActionIntent) => {
      router.push(
        queueProfileActionLogin({
          action,
          target: profileUserTarget(targetUserId),
          fallbackPath: loginReturnPath,
          initiatingUserId: currentUserId,
        })
      )
    },
    [currentUserId, loginReturnPath, router, targetUserId]
  )

  const executeFollowAction = useCallback(
    async (desiredFollowing: boolean) => {
      if (!currentUserId) {
        redirectToLogin('follow-user')
        return
      }

      if (currentUserId === targetUserId) {
        showToast(t('cannotFollowSelf'), 'warning')
        return
      }

      // Prevent double-click
      if (pendingRef.current || loading) return
      pendingRef.current = true
      setLoading(true)

      // Optimistic update — revert on failure
      const previousFollowing = following
      setFollowing(desiredFollowing)

      // Create AbortController for request cancellation
      const abortController = new AbortController()

      // Timeout protection: 10 seconds (increased from 5s for slow networks)
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => {
        if (pendingRef.current) {
          abortController.abort()
          pendingRef.current = false
          setLoading(false)
          showToast(t('timeoutRetry'), 'warning')
        }
      }, 8000) // Unified 8s timeout (same as TraderFollowButton)

      try {
        const authHeaders = await getAuthHeadersAsync()
        const response = await fetch('/api/users/follow', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({
            followingId: targetUserId,
            action: desiredFollowing ? 'follow' : 'unfollow',
          }),
          signal: abortController.signal,
        })

        // Clear timeout on response
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }

        if (response.status === 401) {
          setFollowing(previousFollowing)
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          redirectToLogin(desiredFollowing ? 'follow-user' : 'unfollow-user')
          return
        }

        const result = await response.json()

        if (response.ok && result.success !== false) {
          setFollowing(result.following)
          if (result.mutual !== undefined) {
            setFollowedBy(result.mutual)
          }
          onFollowChange?.(result.following, result.mutual ?? false)
          broadcast('FOLLOW_CHANGED', {
            targetUserId,
            following: result.following,
            currentUserId: currentUserId!,
          })
          haptic('success')
          showToast(result.following ? t('followSuccess') : t('unfollowSuccess'), 'success')
        } else if (result.tableNotFound) {
          setFollowing(previousFollowing) // rollback
          showToast(t('followFeatureComingSoon'), 'warning')
        } else {
          setFollowing(previousFollowing) // rollback
          const errorMsg = result.error || t('operationFailedRetry')
          showToast(errorMsg, 'error')
        }
      } catch (error) {
        setFollowing(previousFollowing) // rollback optimistic update
        // Clear timeout on error
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }

        // Handle abort errors silently (user already notified via timeout)
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }

        // #22: Show retry hint on network error
        const isNetworkError =
          error instanceof TypeError && (error as TypeError).message.includes('fetch')
        showToast(
          isNetworkError
            ? `${t('operationFailedRetry')} — ${t('tapToRetry')}`
            : t('operationFailedRetry'),
          'error'
        )
      } finally {
        setLoading(false)
        pendingRef.current = false
      }
    },
    [
      currentUserId,
      targetUserId,
      following,
      loading,
      getAuthHeadersAsync,
      showToast,
      t,
      onFollowChange,
      redirectToLogin,
      broadcast,
    ]
  )

  const handleToggle = useCallback(() => {
    void executeFollowAction(!following)
  }, [executeFollowAction, following])

  useEffect(() => {
    if (!currentUserId || initialLoading) return
    const action = consumeProfileActionLogin({
      actions: ['follow-user', 'unfollow-user'],
      target: profileUserTarget(targetUserId),
      currentUserId,
    })
    if (!action) return

    if (currentUserId !== targetUserId) {
      void executeFollowAction(action === 'follow-user')
    }
  }, [currentUserId, executeFollowAction, initialLoading, targetUserId])

  const sizeStyles = BUTTON_SIZE_STYLES

  const isMutual = following && followedBy

  if (!currentUserId) {
    return (
      <button
        onClick={() => redirectToLogin('follow-user')}
        style={{
          ...sizeStyles[size],
          width: fullWidth ? '100%' : 'auto',
          border: `1px solid var(--glass-border-medium)`,
          background: 'var(--glass-bg-light)',
          color: tokens.colors.text.primary,
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        {t('follow')}
      </button>
    )
  }

  // 如果是自己的资料，不显示关注按钮
  if (currentUserId === targetUserId) {
    return null
  }

  // 初始加载时显示加载状态
  if (initialLoading) {
    return (
      <button
        disabled
        aria-busy="true"
        aria-label={t('loading')}
        style={{
          ...sizeStyles[size],
          width: fullWidth ? '100%' : 'auto',
          border: `1px solid var(--glass-border-medium)`,
          background: 'var(--glass-bg-light)',
          color: tokens.colors.white,
          fontWeight: 700,
          cursor: 'not-allowed',
          opacity: 0.6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ButtonSpinner size="xs" />
      </button>
    )
  }

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      aria-label={following ? t('unfollowUser') : t('followUser')}
      aria-pressed={following}
      aria-busy={loading}
      className="interactive-scale"
      style={{
        ...sizeStyles[size],
        width: fullWidth ? '100%' : 'auto',
        border: following ? `1px solid var(--glass-border-medium)` : 'none',
        background: following ? tokens.glass.bg.light : tokens.colors.accent.brand,
        // following bg is the theme-aware glass tint (light theme ≈ near-white), so
        // hard white text went invisible there. Use theme-aware text in that state.
        color: following ? 'var(--color-text-primary)' : tokens.colors.white,
        fontWeight: 700,
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[1.5],
      }}
      onMouseEnter={(e) => {
        if (!loading) e.currentTarget.style.opacity = '0.85'
      }}
      onMouseLeave={(e) => {
        if (!loading) e.currentTarget.style.opacity = '1'
      }}
    >
      {loading && <ButtonSpinner size="xs" />}
      {loading
        ? following
          ? t('unfollowingAction')
          : t('followingAction')
        : following
          ? isMutual
            ? t('mutualFollow')
            : t('unfollow')
          : followedBy
            ? t('followBack')
            : t('follow')}
    </button>
  )
}
