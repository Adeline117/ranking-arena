'use client'

import { useCallback, useRef } from 'react'
import { authedFetch, getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import {
  acquireGroupApplicationOperation,
  completeGroupApplicationOperation,
  isCurrentGroupApplicationOperation,
  isExactApproveGroupApplicationAck,
  isExactRejectGroupApplicationAck,
  runGroupApplicationSingleFlight,
  type GroupApplicationOperation,
} from '@/lib/groups/application-operation'
import { jwtSubject } from '@/lib/auth/token-subject'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import { useViewerSlotState } from '@/lib/groups/use-viewer-slot-state'

type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void

export interface GroupApplication {
  id: string
  applicant_id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  role_names?: {
    admin?: { zh?: string; en?: string }
    member?: { zh?: string; en?: string }
  } | null
  status: string
  reject_reason?: string | null
  created_at: string
  applicant?: {
    id: string
    handle?: string | null
    avatar_url?: string | null
  }
}

export interface GroupEditApplication {
  id: string
  group_id: string
  applicant_id: string
  name?: string | null
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  rules_json?: Record<string, unknown> | null
  rules?: string | null
  role_names?: {
    admin?: { zh?: string; en?: string }
    member?: { zh?: string; en?: string }
  } | null
  status: string
  reject_reason?: string | null
  created_at: string
  group?: {
    id: string
    name: string
    name_en?: string | null
  }
  applicant?: {
    handle?: string | null
    avatar_url?: string | null
  }
}

export function useApplications(accessToken: string | null, showToast?: ToastFn) {
  const { t } = useLanguage()
  const renderScope = getViewerScope()
  const renderActorId = jwtSubject(accessToken)
  const stateOwnerKey =
    renderActorId &&
    renderScope.userId === renderActorId &&
    renderScope.viewerKey === `user:${renderActorId}`
      ? `${renderScope.viewerKey}:${renderScope.sessionGeneration}`
      : `unbound:${renderActorId ?? 'none'}:${renderScope.sessionGeneration}`
  const [applications, setApplications] = useViewerSlotState<GroupApplication[]>(stateOwnerKey, [])
  const [editApplications, setEditApplications] = useViewerSlotState<GroupEditApplication[]>(
    stateOwnerKey,
    []
  )
  const [applicationsLoading, setApplicationsLoading] = useViewerSlotState(stateOwnerKey, false)
  const [editApplicationsLoading, setEditApplicationsLoading] = useViewerSlotState(
    stateOwnerKey,
    false
  )
  const [actionLoading, setActionLoading] = useViewerSlotState<Record<string, boolean>>(
    stateOwnerKey,
    {}
  )
  const actionOperationIdRef = useRef<Record<string, string>>({})

  const loadApplications = useCallback(async () => {
    const actorId = jwtSubject(accessToken)
    const requestScope = getViewerScope()
    if (
      !accessToken ||
      !actorId ||
      requestScope.userId !== actorId ||
      requestScope.viewerKey !== `user:${actorId}` ||
      !isViewerScopeCurrent(requestScope)
    )
      return

    setApplicationsLoading(true)
    try {
      const result = await authedFetch<{ applications?: GroupApplication[] }>(
        '/api/groups/applications?status=pending',
        'GET',
        accessToken,
        undefined,
        15_000,
        {
          expectedUserId: actorId,
          expectedSessionGeneration: requestScope.sessionGeneration,
        }
      )
      if (result.stale || !isViewerScopeCurrent(requestScope)) return
      if (result.data?.applications) {
        setApplications(result.data.applications)
      }
    } catch (err) {
      if (isViewerScopeCurrent(requestScope)) logger.error('Error loading applications:', err)
    } finally {
      if (isViewerScopeCurrent(requestScope)) setApplicationsLoading(false)
    }
  }, [accessToken, stateOwnerKey])

  const loadEditApplications = useCallback(async () => {
    if (!accessToken) return

    setEditApplicationsLoading(true)

    try {
      const res = await fetch('/api/groups/edit-applications?status=pending', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()

      if (data.applications) {
        setEditApplications(data.applications)
      }
    } catch (err) {
      logger.error('Error loading edit applications:', err)
    } finally {
      setEditApplicationsLoading(false)
    }
  }, [accessToken, stateOwnerKey])

  const approveApplication = useCallback(
    async (applicationId: string) => {
      const actorId = jwtSubject(accessToken)
      const requestScope = getViewerScope()
      if (
        !accessToken ||
        !actorId ||
        requestScope.userId !== actorId ||
        requestScope.viewerKey !== `user:${actorId}` ||
        !isViewerScopeCurrent(requestScope)
      )
        return false

      let operation: GroupApplicationOperation | null = null
      const actionOwnerKey = `${stateOwnerKey}:${applicationId}`
      try {
        operation = await acquireGroupApplicationOperation(
          `review:${actorId}:${applicationId}`,
          actorId,
          {
            application_id: applicationId,
            decision: 'approve',
            reason: null,
          }
        )
        if (!isViewerScopeCurrent(requestScope)) return false
        actionOperationIdRef.current[actionOwnerKey] = operation.operationId
        setActionLoading((prev) => ({ ...prev, [applicationId]: true }))

        const result = await runGroupApplicationSingleFlight(operation, () =>
          authedFetch<unknown>(
            `/api/groups/applications/${applicationId}/approve`,
            'POST',
            accessToken,
            { operation_id: operation!.operationId },
            15_000,
            {
              expectedUserId: actorId,
              expectedSessionGeneration: requestScope.sessionGeneration,
            }
          )
        )
        if (result.stale || !isViewerScopeCurrent(requestScope)) return false
        const ownsActiveIntent =
          actionOperationIdRef.current[actionOwnerKey] === operation.operationId

        if (result.ok && isExactApproveGroupApplicationAck(result.data, operation)) {
          setApplications((prev) => prev.filter((a) => a.id !== applicationId))
          if (ownsActiveIntent) {
            if (isCurrentGroupApplicationOperation(operation)) {
              completeGroupApplicationOperation(operation)
            }
            return true
          }
          return false
        }

        if (ownsActiveIntent && isCurrentGroupApplicationOperation(operation)) {
          const errorMessage =
            typeof result.data === 'object' &&
            result.data !== null &&
            'error' in result.data &&
            typeof (result.data as { error?: unknown }).error === 'string'
              ? (result.data as { error: string }).error
              : t('adminOperationFailed')
          showToast?.(errorMessage, 'error')
        }
        return false
      } catch (_err) {
        if (
          isViewerScopeCurrent(requestScope) &&
          (!operation || actionOperationIdRef.current[actionOwnerKey] === operation.operationId)
        ) {
          showToast?.(t('adminNetworkError'), 'error')
        }
        return false
      } finally {
        const completedOperation = operation
        if (completedOperation)
          queueMicrotask(() => {
            if (
              actionOperationIdRef.current[actionOwnerKey] === completedOperation.operationId &&
              isViewerScopeCurrent(requestScope)
            ) {
              delete actionOperationIdRef.current[actionOwnerKey]
              setActionLoading((prev) => ({ ...prev, [applicationId]: false }))
            }
          })
      }
    },
    [accessToken, showToast, stateOwnerKey]
  )

  const rejectApplication = useCallback(
    async (applicationId: string, reason?: string) => {
      const actorId = jwtSubject(accessToken)
      const requestScope = getViewerScope()
      if (
        !accessToken ||
        !actorId ||
        requestScope.userId !== actorId ||
        requestScope.viewerKey !== `user:${actorId}` ||
        !isViewerScopeCurrent(requestScope)
      )
        return false

      let operation: GroupApplicationOperation | null = null
      const actionOwnerKey = `${stateOwnerKey}:${applicationId}`
      try {
        const normalizedReason = reason?.trim().normalize('NFC') || null
        operation = await acquireGroupApplicationOperation(
          `review:${actorId}:${applicationId}`,
          actorId,
          {
            application_id: applicationId,
            decision: 'reject',
            reason: normalizedReason,
          }
        )
        if (!isViewerScopeCurrent(requestScope)) return false
        actionOperationIdRef.current[actionOwnerKey] = operation.operationId
        setActionLoading((prev) => ({ ...prev, [applicationId]: true }))

        const result = await runGroupApplicationSingleFlight(operation, () =>
          authedFetch<unknown>(
            `/api/groups/applications/${applicationId}/reject`,
            'POST',
            accessToken,
            {
              operation_id: operation!.operationId,
              reason: normalizedReason,
            },
            15_000,
            {
              expectedUserId: actorId,
              expectedSessionGeneration: requestScope.sessionGeneration,
            }
          )
        )
        if (result.stale || !isViewerScopeCurrent(requestScope)) return false
        const ownsActiveIntent =
          actionOperationIdRef.current[actionOwnerKey] === operation.operationId

        if (result.ok && isExactRejectGroupApplicationAck(result.data, operation)) {
          setApplications((prev) => prev.filter((a) => a.id !== applicationId))
          if (ownsActiveIntent) {
            if (isCurrentGroupApplicationOperation(operation)) {
              completeGroupApplicationOperation(operation)
            }
            return true
          }
          return false
        }

        if (ownsActiveIntent && isCurrentGroupApplicationOperation(operation)) {
          const errorMessage =
            typeof result.data === 'object' &&
            result.data !== null &&
            'error' in result.data &&
            typeof (result.data as { error?: unknown }).error === 'string'
              ? (result.data as { error: string }).error
              : t('adminOperationFailed')
          showToast?.(errorMessage, 'error')
        }
        return false
      } catch (_err) {
        if (
          isViewerScopeCurrent(requestScope) &&
          (!operation || actionOperationIdRef.current[actionOwnerKey] === operation.operationId)
        ) {
          showToast?.(t('adminNetworkError'), 'error')
        }
        return false
      } finally {
        const completedOperation = operation
        if (completedOperation)
          queueMicrotask(() => {
            if (
              actionOperationIdRef.current[actionOwnerKey] === completedOperation.operationId &&
              isViewerScopeCurrent(requestScope)
            ) {
              delete actionOperationIdRef.current[actionOwnerKey]
              setActionLoading((prev) => ({ ...prev, [applicationId]: false }))
            }
          })
      }
    },
    [accessToken, showToast, stateOwnerKey]
  )

  const approveEditApplication = useCallback(
    async (applicationId: string) => {
      if (!accessToken) return false

      setActionLoading((prev) => ({ ...prev, [`edit_${applicationId}`]: true }))

      try {
        const res = await fetch(`/api/groups/edit-applications/${applicationId}/approve`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
        })
        const data = await res.json()

        if (res.ok) {
          setEditApplications((prev) => prev.filter((a) => a.id !== applicationId))
          return true
        } else {
          showToast?.(data.error || t('adminOperationFailed'), 'error')
          return false
        }
      } catch (_err) {
        showToast?.(t('adminNetworkError'), 'error')
        return false
      } finally {
        setActionLoading((prev) => ({ ...prev, [`edit_${applicationId}`]: false }))
      }
    },
    [accessToken, showToast, stateOwnerKey]
  )

  const rejectEditApplication = useCallback(
    async (applicationId: string, reason?: string) => {
      if (!accessToken) return false

      setActionLoading((prev) => ({ ...prev, [`edit_${applicationId}`]: true }))

      try {
        const res = await fetch(`/api/groups/edit-applications/${applicationId}/reject`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ reason }),
        })
        const data = await res.json()

        if (res.ok) {
          setEditApplications((prev) => prev.filter((a) => a.id !== applicationId))
          return true
        } else {
          showToast?.(data.error || t('adminOperationFailed'), 'error')
          return false
        }
      } catch (_err) {
        showToast?.(t('adminNetworkError'), 'error')
        return false
      } finally {
        setActionLoading((prev) => ({ ...prev, [`edit_${applicationId}`]: false }))
      }
    },
    [accessToken, showToast, stateOwnerKey]
  )

  return {
    applications,
    editApplications,
    applicationsLoading,
    editApplicationsLoading,
    actionLoading,
    loadApplications,
    loadEditApplications,
    approveApplication,
    rejectApplication,
    approveEditApplication,
    rejectEditApplication,
  }
}
