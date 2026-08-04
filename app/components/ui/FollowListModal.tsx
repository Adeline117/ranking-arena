'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
import { Box, Text } from '../base'
import Avatar from './Avatar'
import UserFollowButton from './UserFollowButton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from './Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import {
  compareFollowListTimestamps,
  readFollowListPage,
  type FollowListType,
  type FollowListUser,
} from '@/lib/follows/follow-list-client-contract'

const REQUEST_TIMEOUT_MS = 15_000

interface FollowListModalProps {
  isOpen: boolean
  onClose: () => void
  type: FollowListType
  handle: string
  /** @deprecated The canonical viewer comes from useAuthSession. */
  currentUserId?: string | null
  isOwnProfile?: boolean
  isPublic?: boolean
}

type FailedOperation = 'initial' | 'more'

type FollowListState = {
  resourceKey: string
  users: FollowListUser[]
  targetUserId: string | null
  nextCursor: string | null
  hasMore: boolean
  hidden: boolean
  loading: boolean
  loadingMore: boolean
  error: string | null
  failedOperation: FailedOperation | null
}

type RequestScope = {
  descriptor: string
  generation: number
  resourceKey: string
  isOpen: boolean
  authChecked: boolean
  accessToken: string | null
  userId: string | null
  viewerKey: string
  sessionGeneration: number
  handle: string
  type: FollowListType
}

function emptyState(resourceKey: string, loading: boolean): FollowListState {
  return {
    resourceKey,
    users: [],
    targetUserId: null,
    nextCursor: null,
    hasMore: false,
    hidden: false,
    loading,
    loadingMore: false,
    error: null,
    failedOperation: null,
  }
}

function scopeIsCurrent(expected: RequestScope, current: RequestScope): boolean {
  return (
    current.isOpen &&
    current.generation === expected.generation &&
    current.descriptor === expected.descriptor &&
    current.resourceKey === expected.resourceKey &&
    current.viewerKey === expected.viewerKey &&
    current.sessionGeneration === expected.sessionGeneration &&
    current.userId === expected.userId &&
    current.handle === expected.handle &&
    current.type === expected.type
  )
}

export default function FollowListModal({
  isOpen,
  onClose,
  type,
  handle,
  currentUserId: _currentUserId,
  isOwnProfile = false,
  isPublic = true,
}: FollowListModalProps) {
  const router = useRouter()
  const { t } = useLanguage()
  const { showToast } = useToast()
  const auth = useAuthSession()
  const tRef = useRef(t)
  const showToastRef = useRef(showToast)
  tRef.current = t
  showToastRef.current = showToast

  const resourceKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${auth.userId ?? 'anonymous'}\u0000${handle}\u0000${type}`
  const readiness = auth.authChecked
    ? auth.userId === null || auth.accessToken
      ? 'ready'
      : 'missing-token'
    : 'pending'
  const descriptor = `${isOpen ? 'open' : 'closed'}\u0000${resourceKey}\u0000${readiness}`
  const scopeRef = useRef<RequestScope>({
    descriptor,
    generation: 0,
    resourceKey,
    isOpen,
    authChecked: auth.authChecked,
    accessToken: auth.accessToken,
    userId: auth.userId,
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    handle,
    type,
  })
  if (scopeRef.current.descriptor !== descriptor) {
    scopeRef.current = {
      descriptor,
      generation: scopeRef.current.generation + 1,
      resourceKey,
      isOpen,
      authChecked: auth.authChecked,
      accessToken: auth.accessToken,
      userId: auth.userId,
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      handle,
      type,
    }
  } else {
    scopeRef.current = {
      ...scopeRef.current,
      isOpen,
      authChecked: auth.authChecked,
      accessToken: auth.accessToken,
      userId: auth.userId,
    }
  }

  const [state, setState] = useState<FollowListState>(() => emptyState(resourceKey, true))
  const stateRef = useRef(state)
  stateRef.current = state
  const abortControllerRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const pendingRef = useRef(false)

  const updateState = useCallback((updater: (current: FollowListState) => FollowListState) => {
    setState((current) => {
      const next = updater(current)
      stateRef.current = next
      return next
    })
  }, [])

  const loadPage = useCallback(
    async (operation: FailedOperation) => {
      if (pendingRef.current) return
      const scope = { ...scopeRef.current }
      const currentState = stateRef.current
      if (
        !scope.isOpen ||
        !scope.authChecked ||
        scope.resourceKey !== currentState.resourceKey ||
        (scope.userId !== null && scope.accessToken === null)
      ) {
        if (
          scope.isOpen &&
          scope.authChecked &&
          scope.userId !== null &&
          scope.accessToken === null
        ) {
          const message = tRef.current('loadFailed')
          updateState((current) =>
            current.resourceKey === scope.resourceKey
              ? {
                  ...current,
                  loading: false,
                  loadingMore: false,
                  error: message,
                  failedOperation: operation,
                }
              : current
          )
        }
        return
      }

      const cursor = operation === 'more' ? currentState.nextCursor : null
      if (operation === 'more' && cursor === null) return

      pendingRef.current = true
      abortControllerRef.current?.abort()
      const controller = new AbortController()
      abortControllerRef.current = controller
      const requestId = ++requestIdRef.current
      let timedOut = false
      const timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, REQUEST_TIMEOUT_MS)

      updateState((current) =>
        current.resourceKey === scope.resourceKey
          ? {
              ...current,
              loading: operation === 'initial',
              loadingMore: operation === 'more',
              error: null,
              failedOperation: null,
            }
          : current
      )

      try {
        const search = new URLSearchParams({ list: scope.type })
        if (cursor) search.set('cursor', cursor)
        const headers: Record<string, string> = {}
        if (scope.accessToken) headers.Authorization = `Bearer ${scope.accessToken}`
        const response = await fetch(
          `/api/users/${encodeURIComponent(scope.handle)}/follow?${search.toString()}`,
          {
            headers,
            signal: controller.signal,
            cache: 'no-store',
          }
        )
        if (
          controller.signal.aborted ||
          requestIdRef.current !== requestId ||
          !scopeIsCurrent(scope, scopeRef.current)
        ) {
          return
        }
        if (response.status !== 200) throw new Error(`Follow list returned ${response.status}`)

        const body: unknown = await response.json()
        if (
          controller.signal.aborted ||
          requestIdRef.current !== requestId ||
          !scopeIsCurrent(scope, scopeRef.current)
        ) {
          return
        }
        const page = readFollowListPage(body, {
          viewerId: scope.userId,
          targetHandle: scope.handle,
          targetUserId: currentState.targetUserId,
          list: scope.type,
        })
        if (!page || (cursor !== null && page.nextCursor === cursor)) {
          throw new Error('Follow list returned an invalid acknowledgement')
        }

        const latestState = stateRef.current
        const nextUsers =
          operation === 'more' ? [...latestState.users, ...page.users] : [...page.users]
        if (!page.hidden && new Set(nextUsers.map((user) => user.id)).size !== nextUsers.length) {
          throw new Error('Follow list pagination repeated a user')
        }
        const previousLast = operation === 'more' ? latestState.users.at(-1) : null
        const nextFirst = operation === 'more' ? page.users[0] : null
        if (
          !page.hidden &&
          previousLast &&
          nextFirst &&
          compareFollowListTimestamps(nextFirst.followed_at, previousLast.followed_at) > 0
        ) {
          throw new Error('Follow list pagination was out of order')
        }

        updateState((current) => {
          if (
            current.resourceKey !== scope.resourceKey ||
            !scopeIsCurrent(scope, scopeRef.current)
          ) {
            return current
          }
          if (page.hidden) {
            return {
              ...current,
              users: [],
              targetUserId: page.targetUserId,
              nextCursor: null,
              hasMore: false,
              hidden: true,
              error: null,
              failedOperation: null,
            }
          }

          return {
            ...current,
            users: nextUsers,
            targetUserId: page.targetUserId,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            hidden: false,
            error: null,
            failedOperation: null,
          }
        })
      } catch (error) {
        if (
          (!timedOut && controller.signal.aborted) ||
          requestIdRef.current !== requestId ||
          !scopeIsCurrent(scope, scopeRef.current)
        ) {
          return
        }
        logger.error('Follow-list modal read failed', error)
        const message = tRef.current(operation === 'more' ? 'loadMoreFailed' : 'loadFailed')
        updateState((current) =>
          current.resourceKey === scope.resourceKey
            ? {
                ...current,
                error: message,
                failedOperation: operation,
              }
            : current
        )
        showToastRef.current(message, 'error')
      } finally {
        clearTimeout(timeoutId)
        if (requestIdRef.current === requestId && scopeIsCurrent(scope, scopeRef.current)) {
          pendingRef.current = false
          updateState((current) =>
            current.resourceKey === scope.resourceKey
              ? { ...current, loading: false, loadingMore: false }
              : current
          )
        }
        if (abortControllerRef.current === controller) abortControllerRef.current = null
      }
    },
    [updateState]
  )

  useEffect(() => {
    return () => {
      requestIdRef.current += 1
      pendingRef.current = false
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
    }
  }, [])

  useEffect(() => {
    requestIdRef.current += 1
    pendingRef.current = false
    abortControllerRef.current?.abort()
    abortControllerRef.current = null

    const reset = emptyState(resourceKey, isOpen)
    stateRef.current = reset
    setState(reset)
    if (isOpen && auth.authChecked) void loadPage('initial')

    return () => {
      requestIdRef.current += 1
      pendingRef.current = false
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
    }
  }, [auth.authChecked, descriptor, isOpen, loadPage, resourceKey])

  const invalidateAndClose = useCallback(() => {
    requestIdRef.current += 1
    pendingRef.current = false
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    scopeRef.current = {
      ...scopeRef.current,
      generation: scopeRef.current.generation + 1,
      isOpen: false,
    }
    onClose()
  }, [onClose])

  const handleUserClick = useCallback(
    (userHandle: string) => {
      invalidateAndClose()
      router.push(`/u/${encodeURIComponent(userHandle)}`)
    },
    [invalidateAndClose, router]
  )

  const title = type === 'followers' ? t('followers') : t('following')
  const visibleState = state.resourceKey === resourceKey ? state : emptyState(resourceKey, true)
  const showInitialLoading = visibleState.loading && visibleState.users.length === 0
  const showEmpty =
    !showInitialLoading &&
    !visibleState.hidden &&
    visibleState.users.length === 0 &&
    visibleState.error === null

  return (
    <ModalOverlay open={isOpen} onClose={invalidateAndClose} label={title}>
      <div
        style={{
          padding: tokens.spacing[6],
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '80vh',
        }}
      >
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.spacing[4],
            paddingBottom: tokens.spacing[3],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
            <Text id="follow-list-modal-title" size="lg" weight="bold">
              {title}
            </Text>
            {isOwnProfile && (
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                <span
                  aria-hidden="true"
                  style={{
                    fontSize: tokens.typography.fontSize.xs,
                    color: isPublic ? tokens.colors.accent.success : tokens.colors.accent.warning,
                  }}
                >
                  {isPublic ? '\u25CB' : '\u25CF'}
                </span>
                <Text size="xs" color="tertiary">
                  {isPublic ? t('publicListVisible') : t('privateListHidden')}
                </Text>
              </Box>
            )}
          </Box>
          <button
            type="button"
            onClick={invalidateAndClose}
            aria-label={t('close')}
            style={{
              width: 44,
              height: 44,
              display: 'grid',
              placeItems: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: tokens.radius.md,
              fontSize: tokens.typography.fontSize['2xl'],
              cursor: 'pointer',
              color: tokens.colors.text.tertiary,
              lineHeight: 1,
              padding: 0,
            }}
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </Box>

        <Box style={{ overflowY: 'auto', flex: 1 }} aria-busy={showInitialLoading}>
          {visibleState.error && (
            <Box
              role="alert"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: tokens.spacing[3],
                padding: tokens.spacing[3],
                marginBottom: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.accent.error}`,
                background: tokens.colors.bg.tertiary,
              }}
            >
              <Text size="sm" color="tertiary">
                {visibleState.error}
              </Text>
              <button
                type="button"
                onClick={() => void loadPage(visibleState.failedOperation ?? 'initial')}
                disabled={visibleState.loading || visibleState.loadingMore}
                style={{
                  minWidth: 72,
                  minHeight: 44,
                  padding: `0 ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  cursor: visibleState.loading || visibleState.loadingMore ? 'wait' : 'pointer',
                  fontWeight: tokens.typography.fontWeight.semibold,
                }}
              >
                {t('retry')}
              </button>
            </Box>
          )}

          {showInitialLoading ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[6] }} aria-live="polite">
              <Text size="sm" color="tertiary">
                {t('loading')}
              </Text>
            </Box>
          ) : visibleState.hidden ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[6] }}>
              <Box
                aria-hidden="true"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  background: tokens.colors.bg.tertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto',
                  marginBottom: tokens.spacing[3],
                  opacity: 0.6,
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </Box>
              <Text size="sm" color="tertiary">
                {t('userHiddenList')}
              </Text>
            </Box>
          ) : showEmpty ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[6] }}>
              <Text size="sm" color="tertiary">
                {type === 'followers' ? t('noFollowersYet') : t('notFollowingAnyone')}
              </Text>
            </Box>
          ) : (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              {visibleState.users.map((user) => (
                <Box
                  key={user.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    minHeight: 64,
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <button
                    type="button"
                    aria-label={`@${user.handle}`}
                    onClick={() => handleUserClick(user.handle)}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.background = tokens.colors.bg.secondary
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = 'transparent'
                    }}
                    onFocus={(event) => {
                      event.currentTarget.style.background = tokens.colors.bg.secondary
                    }}
                    onBlur={(event) => {
                      event.currentTarget.style.background = 'transparent'
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 56,
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[3],
                      padding: tokens.spacing[2],
                      border: 'none',
                      borderRadius: tokens.radius.md,
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: `background ${tokens.transition.base}`,
                    }}
                  >
                    <Avatar
                      userId={user.id}
                      name={user.handle}
                      avatarUrl={user.avatar_url}
                      size={44}
                      style={{ flexShrink: 0 }}
                    />

                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        size="sm"
                        weight="semibold"
                        style={{
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {user.handle}
                      </Text>
                      {user.bio && (
                        <Text
                          size="xs"
                          color="tertiary"
                          style={{
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            marginTop: 2,
                          }}
                        >
                          {user.bio}
                        </Text>
                      )}
                    </Box>
                  </button>

                  {auth.userId && user.id !== auth.userId && (
                    <Box style={{ flexShrink: 0 }}>
                      <UserFollowButton
                        targetUserId={user.id}
                        currentUserId={auth.userId}
                        size="sm"
                        initialFollowing={user.is_following}
                      />
                    </Box>
                  )}
                </Box>
              ))}

              {visibleState.hasMore && (
                <button
                  type="button"
                  onClick={() => void loadPage('more')}
                  disabled={visibleState.loadingMore}
                  style={{
                    width: '100%',
                    minHeight: 44,
                    padding: `0 ${tokens.spacing[4]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    color: tokens.colors.text.primary,
                    cursor: visibleState.loadingMore ? 'wait' : 'pointer',
                    fontWeight: tokens.typography.fontWeight.semibold,
                  }}
                >
                  {visibleState.loadingMore ? t('loading') : t('loadMore')}
                </button>
              )}
            </Box>
          )}
        </Box>
      </div>
    </ModalOverlay>
  )
}
