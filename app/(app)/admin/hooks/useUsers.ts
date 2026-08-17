'use client'

import { useCallback, useRef } from 'react'
import { authedFetch, getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { isProfileBanned } from '@/lib/auth/profile-suspension'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import { jwtSubject } from '@/lib/auth/token-subject'
import { useViewerSlotState } from '@/lib/groups/use-viewer-slot-state'
import { logger } from '@/lib/logger'

type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void
const USERS_PAGE_LIMIT = 20

export interface AdminUser {
  id: string
  handle: string | null
  email: string | null
  avatar_url: string | null
  bio: string | null
  follower_count: number
  following_count: number
  role: string | null
  banned_at: string | null
  banned_reason: string | null
  banned_by: string | null
  is_banned: boolean
  ban_expires_at: string | null
  is_effectively_banned: boolean
  created_at: string
  updated_at: string
}

export interface UsersPagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

type AdminUsersPaginationEnvelope = {
  success: true
  data: AdminUser[]
  meta: {
    timestamp: string
    pagination: {
      limit: number
      offset: number
      has_more: boolean
      total: number
    }
  }
}

function emptyPagination(page = 1): UsersPagination {
  return {
    page,
    limit: USERS_PAGE_LIMIT,
    total: 0,
    totalPages: 0,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isAdminUser(value: unknown): value is AdminUser {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isNullableString(value.handle) &&
    isNullableString(value.email) &&
    isNullableString(value.avatar_url) &&
    isNullableString(value.bio) &&
    isFiniteInteger(value.follower_count) &&
    isFiniteInteger(value.following_count) &&
    isNullableString(value.role) &&
    isNullableString(value.banned_at) &&
    isNullableString(value.banned_reason) &&
    isNullableString(value.banned_by) &&
    isBoolean(value.is_banned) &&
    isNullableString(value.ban_expires_at) &&
    isBoolean(value.is_effectively_banned) &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string'
  )
}

function parseUsersEnvelope(
  value: unknown,
  expectedPage: number
): AdminUsersPaginationEnvelope | null {
  if (
    !isRecord(value) ||
    value.success !== true ||
    !Array.isArray(value.data) ||
    !isRecord(value.meta)
  ) {
    return null
  }

  const { meta } = value
  if (typeof meta.timestamp !== 'string' || Number.isNaN(Date.parse(meta.timestamp))) {
    return null
  }

  if (!isRecord(meta.pagination)) return null
  const pagination = meta.pagination
  const limit = pagination.limit
  const offset = pagination.offset
  const total = pagination.total
  const hasMore = pagination.has_more
  const expectedOffset = (expectedPage - 1) * USERS_PAGE_LIMIT

  if (
    limit !== USERS_PAGE_LIMIT ||
    !isFiniteInteger(offset) ||
    offset !== expectedOffset ||
    !isFiniteInteger(total) ||
    total < 0 ||
    typeof hasMore !== 'boolean' ||
    hasMore !== total > offset + limit
  ) {
    return null
  }

  const users = value.data
  if (!users.every(isAdminUser)) return null

  return {
    success: true,
    data: users,
    meta: {
      timestamp: meta.timestamp,
      pagination: { limit, offset, has_more: hasMore, total },
    },
  }
}

function toUsersPagination(envelope: AdminUsersPaginationEnvelope, page: number): UsersPagination {
  const { limit, total } = envelope.meta.pagination
  return {
    page,
    limit,
    total,
    totalPages: total > 0 ? Math.ceil(total / limit) : 0,
  }
}

function extractErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.error === 'string' && value.error) return value.error
  if (isRecord(value.error) && typeof value.error.message === 'string' && value.error.message) {
    return value.error.message
  }
  return typeof value.message === 'string' && value.message ? value.message : null
}

export function useUsers(accessToken: string | null, showToast?: ToastFn) {
  const { t } = useLanguage()
  const renderScope = getViewerScope()
  const renderActorId = jwtSubject(accessToken)
  const stateOwnerKey =
    renderActorId &&
    renderScope.userId === renderActorId &&
    renderScope.viewerKey === `user:${renderActorId}`
      ? `${renderScope.viewerKey}:${renderScope.sessionGeneration}`
      : `unbound:${renderActorId ?? 'none'}:${renderScope.sessionGeneration}`
  const [users, setUsers] = useViewerSlotState<AdminUser[]>(stateOwnerKey, [])
  const [pagination, setPagination] = useViewerSlotState<UsersPagination>(
    stateOwnerKey,
    emptyPagination()
  )
  const [loading, setLoading] = useViewerSlotState(stateOwnerKey, false)
  const [error, setError] = useViewerSlotState<string | null>(stateOwnerKey, null)
  const [actionLoading, setActionLoading] = useViewerSlotState<Record<string, boolean>>(
    stateOwnerKey,
    {}
  )
  const loadRequestSequenceRef = useRef(0)
  const loadRequestIdRef = useRef<Record<string, number>>({})
  const loadAbortControllerRef = useRef<Record<string, AbortController | null>>({})

  const loadUsers = useCallback(
    async (page: number = 1, search: string = '', filter: 'all' | 'banned' | 'active' = 'all') => {
      const loadPage = async (requestedPage: number, allowPageFallback: boolean): Promise<void> => {
        const actorId = jwtSubject(accessToken)
        const requestScope = getViewerScope()
        const requestStateOwnerKey =
          actorId && requestScope.userId === actorId && requestScope.viewerKey === `user:${actorId}`
            ? `${requestScope.viewerKey}:${requestScope.sessionGeneration}`
            : `unbound:${actorId ?? 'none'}:${requestScope.sessionGeneration}`

        if (
          !accessToken ||
          !actorId ||
          requestScope.userId !== actorId ||
          requestScope.viewerKey !== `user:${actorId}` ||
          stateOwnerKey !== requestStateOwnerKey ||
          !isViewerScopeCurrent(requestScope)
        ) {
          setError(t('adminNotLoggedIn'))
          setUsers([])
          setPagination(emptyPagination(requestedPage))
          return
        }

        const requestId = ++loadRequestSequenceRef.current
        loadRequestIdRef.current[stateOwnerKey] = requestId
        loadAbortControllerRef.current[stateOwnerKey]?.abort()
        const controller = new AbortController()
        loadAbortControllerRef.current[stateOwnerKey] = controller

        setLoading(true)
        setError(null)

        try {
          const params = new URLSearchParams({
            page: String(requestedPage),
            limit: String(USERS_PAGE_LIMIT),
            filter,
          })
          if (search) params.set('search', search)

          const result = await authedFetch<unknown>(
            `/api/admin/users?${params.toString()}`,
            'GET',
            accessToken,
            undefined,
            15_000,
            {
              expectedUserId: actorId,
              expectedSessionGeneration: requestScope.sessionGeneration,
              signal: controller.signal,
            }
          )
          if (
            result.stale ||
            !isViewerScopeCurrent(requestScope) ||
            loadRequestIdRef.current[stateOwnerKey] !== requestId
          ) {
            return
          }

          if (!result.ok) {
            setError(extractErrorMessage(result.data) || t('adminLoadFailed'))
            setUsers([])
            setPagination(emptyPagination(requestedPage))
            return
          }

          const envelope = parseUsersEnvelope(result.data, requestedPage)
          if (!envelope) {
            setError(t('adminLoadFailed'))
            setUsers([])
            setPagination(emptyPagination(requestedPage))
            return
          }

          const nextPagination = toUsersPagination(envelope, requestedPage)
          if (
            allowPageFallback &&
            envelope.data.length === 0 &&
            nextPagination.totalPages > 0 &&
            requestedPage > nextPagination.totalPages
          ) {
            await loadPage(nextPagination.totalPages, false)
            return
          }

          setUsers(envelope.data)
          setPagination(nextPagination)
        } catch (err) {
          if (
            controller.signal.aborted ||
            !isViewerScopeCurrent(requestScope) ||
            loadRequestIdRef.current[stateOwnerKey] !== requestId
          ) {
            return
          }
          logger.error('Error loading users:', err)
          setError(t('adminNetworkErrorRetry'))
          setUsers([])
          setPagination(emptyPagination(requestedPage))
        } finally {
          if (loadRequestIdRef.current[stateOwnerKey] === requestId) {
            delete loadRequestIdRef.current[stateOwnerKey]
            if (loadAbortControllerRef.current[stateOwnerKey] === controller) {
              delete loadAbortControllerRef.current[stateOwnerKey]
            }
            if (isViewerScopeCurrent(requestScope)) setLoading(false)
          }
        }
      }

      await loadPage(page, true)
    },
    [accessToken, setError, setLoading, setPagination, setUsers, stateOwnerKey, t]
  )

  const banUser = useCallback(
    async (userId: string, reason?: string) => {
      if (!accessToken) return false

      setActionLoading((prev) => ({ ...prev, [userId]: true }))

      try {
        const res = await fetch(`/api/admin/users/${userId}/ban`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ reason }),
        })
        const data = await res.json()

        if (data.success) {
          const bannedAt = new Date().toISOString()
          // Update local state
          setUsers((prev) =>
            prev.map((u) =>
              u.id === userId
                ? {
                    ...u,
                    banned_at: bannedAt,
                    banned_reason: reason || null,
                    is_banned: true,
                    ban_expires_at: null,
                    is_effectively_banned: isProfileBanned({
                      banned_at: bannedAt,
                      is_banned: true,
                      ban_expires_at: null,
                    }),
                  }
                : u
            )
          )
          return true
        } else {
          showToast?.(data.error || t('adminOperationFailed'), 'error')
          return false
        }
      } catch (_err) {
        showToast?.(t('adminNetworkError'), 'error')
        return false
      } finally {
        setActionLoading((prev) => ({ ...prev, [userId]: false }))
      }
    },
    [accessToken, setActionLoading, setUsers, showToast, t]
  )

  const unbanUser = useCallback(
    async (userId: string) => {
      if (!accessToken) return false

      setActionLoading((prev) => ({ ...prev, [userId]: true }))

      try {
        const res = await fetch(`/api/admin/users/${userId}/unban`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
        })
        const data = await res.json()

        if (data.success) {
          // Update local state
          setUsers((prev) =>
            prev.map((u) =>
              u.id === userId
                ? {
                    ...u,
                    banned_at: null,
                    banned_reason: null,
                    banned_by: null,
                    is_banned: false,
                    ban_expires_at: null,
                    is_effectively_banned: isProfileBanned({
                      banned_at: null,
                      is_banned: false,
                      ban_expires_at: null,
                    }),
                  }
                : u
            )
          )
          return true
        } else {
          showToast?.(data.error || t('adminOperationFailed'), 'error')
          return false
        }
      } catch (_err) {
        showToast?.(t('adminNetworkError'), 'error')
        return false
      } finally {
        setActionLoading((prev) => ({ ...prev, [userId]: false }))
      }
    },
    [accessToken, setActionLoading, setUsers, showToast, t]
  )

  return {
    users,
    pagination,
    loading,
    error,
    actionLoading,
    loadUsers,
    banUser,
    unbanUser,
  }
}
