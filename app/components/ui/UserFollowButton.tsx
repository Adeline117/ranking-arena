'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { ButtonSpinner } from './LoadingSpinner'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { logger } from '@/lib/logger'
import { haptic } from '@/lib/utils/haptics'

type UserFollowButtonProps = {
  targetUserId: string
  currentUserId: string | null
  initialFollowing?: boolean
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
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
  onFollowChange
}: UserFollowButtonProps) {
  const _router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const { getAuthHeadersAsync } = useAuthSession()
  const [following, setFollowing] = useState(initialFollowing)
  const [followedBy, setFollowedBy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true) // 初始加载状态
  const pendingRef = useRef(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

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
        const response = await fetch(
          `/api/users/follow?followingId=${targetUserId}`,
          {
            signal: abortController.signal,
            headers: authHeaders,
          }
        )
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

  const { openLoginModal } = useLoginModal()

  const handleToggle = useCallback(async () => {
    if (!currentUserId) {
      openLoginModal(t('pleaseLogin'))
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
    setFollowing(!following)

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
        },
        body: JSON.stringify({
          followingId: targetUserId,
          action: following ? 'unfollow' : 'follow',
        }),
        signal: abortController.signal,
      })

      // Clear timeout on response
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }

      const result = await response.json()

      if (response.ok && result.success !== false) {
        setFollowing(result.following)
        if (result.mutual !== undefined) {
          setFollowedBy(result.mutual)
        }
        onFollowChange?.(result.following, result.mutual ?? false)
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
      const isNetworkError = error instanceof TypeError && (error as TypeError).message.includes('fetch')
      showToast(isNetworkError ? `${t('operationFailedRetry')} — ${t('tapToRetry') || 'Tap to retry'}` : t('operationFailedRetry'), 'error')
    } finally {
      setLoading(false)
      pendingRef.current = false
    }
  }, [currentUserId, targetUserId, following, loading, getAuthHeadersAsync, showToast, t, onFollowChange, openLoginModal])

  const sizeStyles = {
    sm: { padding: '10px 16px', fontSize: tokens.typography.fontSize.sm, borderRadius: tokens.radius.md, minHeight: '44px' },
    md: { padding: '12px 20px', fontSize: tokens.typography.fontSize.base, borderRadius: tokens.radius.lg, minHeight: '44px' },
    lg: { padding: '14px 24px', fontSize: tokens.typography.fontSize.md, borderRadius: tokens.radius.lg, minHeight: '48px' },
  }

  const isMutual = following && followedBy

  if (!currentUserId) {
    return (
      <button
        onClick={() => useLoginModal.getState().openLoginModal()}
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
      style={{
        ...sizeStyles[size],
        width: fullWidth ? '100%' : 'auto',
        border: following ? `1px solid var(--glass-border-medium)` : 'none',
        background: following ? tokens.glass.bg.light : tokens.colors.accent.brand,
        color: tokens.colors.white,
        fontWeight: 700,
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
      }}
    >
      {loading && <ButtonSpinner size="xs" />}
      {loading
        ? (following ? t('unfollowingAction') : t('followingAction'))
        : (following ? (isMutual ? t('mutualFollow') : t('unfollow')) : (followedBy ? t('followBack') : t('follow')))
      }
    </button>
  )
}
