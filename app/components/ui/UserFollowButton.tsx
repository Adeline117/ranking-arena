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
import { authedFetch } from '@/lib/api/client'
import {
  consumeProfileActionLogin,
  profileUserTarget,
  queueProfileActionLogin,
  type ProfileActionIntent,
} from '@/lib/auth/profile-action-login'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

type UserFollowButtonProps = {
  targetUserId: string
  currentUserId: string | null
  initialFollowing?: boolean
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  loginReturnPath?: string
  onFollowChange?: (following: boolean, mutual: boolean) => void
}

type FollowIdentityScope = {
  currentUserId: string | null
  generation: number
  targetUserId: string
}

type FollowOperationScope = FollowIdentityScope & {
  viewer: SettingsViewerSnapshot | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFollowStatusAcknowledgement(value: unknown): value is {
  followedBy: boolean
  following: boolean
  mutual: boolean
} {
  if (!isRecord(value)) return false
  return (
    typeof value.following === 'boolean' &&
    typeof value.followedBy === 'boolean' &&
    typeof value.mutual === 'boolean' &&
    value.mutual === (value.following && value.followedBy)
  )
}

function isFollowMutationAcknowledgement(
  value: unknown,
  desiredFollowing: boolean
): value is {
  followedBy: boolean
  following: boolean
  mutual: boolean
  success: true
} {
  if (!isRecord(value)) return false
  return (
    value.success === true &&
    value.following === desiredFollowing &&
    typeof value.followedBy === 'boolean' &&
    typeof value.mutual === 'boolean' &&
    value.mutual === (desiredFollowing && value.followedBy)
  )
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
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const renderViewer = captureSettingsViewer(auth)
  const exactRenderViewer = renderViewer?.userId === currentUserId ? renderViewer : null
  const viewerReadinessKey = exactRenderViewer
    ? `${exactRenderViewer.viewerKey}\u0000${exactRenderViewer.sessionGeneration}\u0000ready`
    : `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000blocked`
  const identityKey = `${currentUserId ?? 'anonymous'}\u0000${targetUserId}`
  const [following, setFollowing] = useState(initialFollowing)
  const [followedBy, setFollowedBy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true) // 初始加载状态
  const [stateIdentityKey, setStateIdentityKey] = useState(identityKey)
  const pendingRef = useRef(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const mountedRef = useRef(false)
  const statusAbortRef = useRef<AbortController | null>(null)
  const mutationAbortRef = useRef<AbortController | null>(null)
  const identityRef = useRef<FollowIdentityScope>({
    currentUserId,
    generation: 0,
    targetUserId,
  })
  if (
    identityRef.current.currentUserId !== currentUserId ||
    identityRef.current.targetUserId !== targetUserId
  ) {
    identityRef.current = {
      currentUserId,
      generation: identityRef.current.generation + 1,
      targetUserId,
    }
  }

  const captureOperationScope = useCallback((): FollowOperationScope => {
    const viewer = captureSettingsViewer(authRef.current)
    return {
      ...identityRef.current,
      viewer: viewer?.userId === identityRef.current.currentUserId ? viewer : null,
    }
  }, [])
  const operationIsCurrent = useCallback((scope: FollowOperationScope): boolean => {
    const current = identityRef.current
    return (
      mountedRef.current &&
      current.generation === scope.generation &&
      current.currentUserId === scope.currentUserId &&
      current.targetUserId === scope.targetUserId &&
      scope.viewer !== null &&
      isSettingsViewerCurrent(scope.viewer, authRef.current)
    )
  }, [])

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

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      statusAbortRef.current?.abort()
      mutationAbortRef.current?.abort()
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const scope = captureOperationScope()
    statusAbortRef.current?.abort()
    mutationAbortRef.current?.abort()
    statusAbortRef.current = null
    mutationAbortRef.current = null
    pendingRef.current = false
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    setStateIdentityKey(identityKey)
    setFollowing(initialFollowing)
    setFollowedBy(false)
    setLoading(false)

    if (!currentUserId || currentUserId === targetUserId) {
      setInitialLoading(false)
      return
    }
    if (!scope.viewer) {
      setInitialLoading(false)
      return
    }
    const operationViewer = scope.viewer

    const abortController = new AbortController()
    statusAbortRef.current = abortController
    setInitialLoading(true)
    ;(async () => {
      try {
        const result = await authedFetch<unknown>(
          `/api/users/follow?followingId=${targetUserId}`,
          'GET',
          operationViewer.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: operationViewer.userId,
            expectedSessionGeneration: operationViewer.sessionGeneration,
            signal: abortController.signal,
          }
        )
        if (result.stale || abortController.signal.aborted || !operationIsCurrent(scope)) return
        if (result.ok) {
          if (!isFollowStatusAcknowledgement(result.data)) {
            throw new Error('Invalid user follow status acknowledgement')
          }
          setFollowing(result.data.following)
          setFollowedBy(result.data.followedBy)
        }
      } catch (error) {
        if (operationIsCurrent(scope) && (error as Error).name !== 'AbortError') {
          logger.error('Check following error:', error)
        }
      } finally {
        if (statusAbortRef.current === abortController) {
          statusAbortRef.current = null
        }
        if (operationIsCurrent(scope)) setInitialLoading(false)
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [
    captureOperationScope,
    currentUserId,
    identityKey,
    initialFollowing,
    operationIsCurrent,
    targetUserId,
    viewerReadinessKey,
  ])

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

      const scope = captureOperationScope()
      const operationViewer = scope.viewer
      if (!operationViewer) {
        if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
          redirectToLogin(desiredFollowing ? 'follow-user' : 'unfollow-user')
        }
        return
      }
      if (!operationIsCurrent(scope)) return

      // Prevent double-click
      if (pendingRef.current || loading) return
      pendingRef.current = true
      setLoading(true)

      // Optimistic update — revert on failure
      const previousFollowing = following
      setFollowing(desiredFollowing)

      // Create AbortController for request cancellation
      const abortController = new AbortController()
      mutationAbortRef.current = abortController

      // Timeout protection: 10 seconds (increased from 5s for slow networks)
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => {
        if (
          pendingRef.current &&
          mutationAbortRef.current === abortController &&
          operationIsCurrent(scope)
        ) {
          abortController.abort()
          pendingRef.current = false
          setLoading(false)
          showToast(t('timeoutRetry'), 'warning')
        }
      }, 8000) // Unified 8s timeout (same as TraderFollowButton)

      try {
        const result = await authedFetch<unknown>(
          '/api/users/follow',
          'POST',
          operationViewer.accessToken,
          {
            followingId: scope.targetUserId,
            action: desiredFollowing ? 'follow' : 'unfollow',
          },
          15_000,
          {
            expectedUserId: operationViewer.userId,
            expectedSessionGeneration: operationViewer.sessionGeneration,
            signal: abortController.signal,
          }
        )

        // Clear timeout on response
        if (mutationAbortRef.current === abortController && timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }

        if (result.stale || !operationIsCurrent(scope)) return
        if (abortController.signal.aborted) {
          setFollowing(previousFollowing)
          return
        }
        if (result.status === 401) {
          setFollowing(previousFollowing)
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          redirectToLogin(desiredFollowing ? 'follow-user' : 'unfollow-user')
          return
        }

        const payload = result.data
        if (result.ok && isFollowMutationAcknowledgement(payload, desiredFollowing)) {
          setFollowing(payload.following)
          setFollowedBy(payload.followedBy)
          onFollowChange?.(payload.following, payload.mutual)
          broadcast('FOLLOW_CHANGED', {
            targetUserId: scope.targetUserId,
            following: payload.following,
            currentUserId: scope.currentUserId!,
          })
          haptic('success')
          showToast(payload.following ? t('followSuccess') : t('unfollowSuccess'), 'success')
        } else if (isRecord(payload) && payload.tableNotFound === true) {
          setFollowing(previousFollowing) // rollback
          showToast(t('followFeatureComingSoon'), 'warning')
        } else {
          setFollowing(previousFollowing) // rollback
          const errorMsg =
            isRecord(payload) && typeof payload.error === 'string'
              ? payload.error
              : t('operationFailedRetry')
          showToast(errorMsg, 'error')
        }
      } catch (error) {
        if (operationIsCurrent(scope)) {
          setFollowing(previousFollowing) // rollback optimistic update
        }
        // Clear timeout on error
        if (mutationAbortRef.current === abortController && timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }

        // Handle abort errors silently (user already notified via timeout)
        if (!operationIsCurrent(scope) || (error instanceof Error && error.name === 'AbortError')) {
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
        if (mutationAbortRef.current === abortController) {
          mutationAbortRef.current = null
          pendingRef.current = false
          if (operationIsCurrent(scope)) setLoading(false)
        }
      }
    },
    [
      currentUserId,
      targetUserId,
      captureOperationScope,
      following,
      loading,
      showToast,
      t,
      onFollowChange,
      redirectToLogin,
      broadcast,
      operationIsCurrent,
    ]
  )

  const handleToggle = useCallback(() => {
    void executeFollowAction(!following)
  }, [executeFollowAction, following])

  useEffect(() => {
    if (!exactRenderViewer || !currentUserId || initialLoading) return
    const action = consumeProfileActionLogin({
      actions: ['follow-user', 'unfollow-user'],
      target: profileUserTarget(targetUserId),
      currentUserId,
    })
    if (!action) return

    if (currentUserId !== targetUserId) {
      void executeFollowAction(action === 'follow-user')
    }
  }, [currentUserId, exactRenderViewer, executeFollowAction, initialLoading, targetUserId])

  const sizeStyles = BUTTON_SIZE_STYLES

  const isMutual = following && followedBy
  const authPending =
    !exactRenderViewer && (!auth.authChecked || auth.loading || Boolean(auth.userId))

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
          fontWeight: tokens.typography.fontWeight.bold,
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

  // A prop transition must synchronously hide the previous identity's state,
  // even before the replacement status effect has had a chance to run.
  if (initialLoading || stateIdentityKey !== identityKey) {
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
          fontWeight: tokens.typography.fontWeight.bold,
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
      disabled={loading || authPending}
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
        fontWeight: tokens.typography.fontWeight.bold,
        cursor: loading || authPending ? 'not-allowed' : 'pointer',
        opacity: loading || authPending ? 0.6 : 1,
        transition: 'all 200ms ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[1.5],
      }}
      onMouseEnter={(e) => {
        if (!loading && !authPending) e.currentTarget.style.opacity = '0.85'
      }}
      onMouseLeave={(e) => {
        if (!loading && !authPending) e.currentTarget.style.opacity = '1'
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
