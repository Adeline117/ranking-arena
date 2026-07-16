'use client'

import { useCallback, useRef } from 'react'
import { authedFetch } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import {
  acquireGroupApplicationOperation,
  completeGroupApplicationOperation,
  groupProfileEditReviewScope,
  isCurrentGroupApplicationOperation,
  isExactApproveGroupApplicationAck,
  isExactApproveGroupProfileEditAck,
  isExactRejectGroupApplicationAck,
  isExactRejectGroupProfileEditAck,
  runGroupApplicationSingleFlight,
  startGroupApplicationSingleFlight,
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
  const editActionOperationIdRef = useRef<Record<string, string>>({})
  const editLoadRequestIdRef = useRef<Record<string, number>>({})
  const editRequestSequenceRef = useRef(0)

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

  const loadEditApplicationsGuarded = useCallback(
    async (commitGuard?: () => boolean) => {
      const actorId = jwtSubject(accessToken)
      const requestScope = getViewerScope()
      const requestStateOwnerKey = `${requestScope.viewerKey}:${requestScope.sessionGeneration}`
      if (
        !accessToken ||
        !actorId ||
        requestScope.userId !== actorId ||
        requestScope.viewerKey !== `user:${actorId}` ||
        stateOwnerKey !== requestStateOwnerKey ||
        !isViewerScopeCurrent(requestScope) ||
        (commitGuard && !commitGuard())
      )
        return

      const requestId = ++editRequestSequenceRef.current
      editLoadRequestIdRef.current[stateOwnerKey] = requestId
      setEditApplicationsLoading(true)

      try {
        const result = await authedFetch<{ applications?: GroupEditApplication[] }>(
          '/api/groups/edit-applications?status=pending',
          'GET',
          accessToken,
          undefined,
          15_000,
          {
            expectedUserId: actorId,
            expectedSessionGeneration: requestScope.sessionGeneration,
          }
        )
        if (
          result.stale ||
          !isViewerScopeCurrent(requestScope) ||
          editLoadRequestIdRef.current[stateOwnerKey] !== requestId ||
          (commitGuard && !commitGuard())
        )
          return

        if (result.data?.applications) {
          setEditApplications(result.data.applications)
        }
      } catch (err) {
        if (
          isViewerScopeCurrent(requestScope) &&
          editLoadRequestIdRef.current[stateOwnerKey] === requestId
        ) {
          logger.error('Error loading edit applications:', err)
        }
      } finally {
        if (editLoadRequestIdRef.current[stateOwnerKey] === requestId) {
          delete editLoadRequestIdRef.current[stateOwnerKey]
          if (isViewerScopeCurrent(requestScope)) setEditApplicationsLoading(false)
        }
      }
    },
    [accessToken, stateOwnerKey]
  )

  const loadEditApplications = useCallback(
    () => loadEditApplicationsGuarded(),
    [loadEditApplicationsGuarded]
  )

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

  const runEditApplicationAction = useCallback(
    async (applicationId: string, decision: 'approve' | 'reject', reason?: string) => {
      const actorId = jwtSubject(accessToken)
      const requestScope = getViewerScope()
      const requestStateOwnerKey = `${requestScope.viewerKey}:${requestScope.sessionGeneration}`
      const expectedApplication = editApplications.find(
        (application) => application.id === applicationId
      )
      if (
        !accessToken ||
        !actorId ||
        !expectedApplication ||
        requestScope.userId !== actorId ||
        requestScope.viewerKey !== `user:${actorId}` ||
        stateOwnerKey !== requestStateOwnerKey ||
        !isViewerScopeCurrent(requestScope)
      )
        return false

      const loadingKey = `edit_${applicationId}`
      const actionOwnerKey = `${stateOwnerKey}:${loadingKey}`
      const expectedGroupId = expectedApplication.group_id
      const normalizedReason = reason?.trim().normalize('NFC') || null
      let operation: GroupApplicationOperation | null = null
      let ownsPhysicalRequest = false

      try {
        operation = await acquireGroupApplicationOperation(
          groupProfileEditReviewScope(actorId, applicationId),
          actorId,
          {
            application_id: applicationId,
            decision,
            reason: decision === 'reject' ? normalizedReason : null,
          }
        )
        if (!isViewerScopeCurrent(requestScope)) return false

        const flight = startGroupApplicationSingleFlight(operation, () =>
          authedFetch<unknown>(
            `/api/groups/edit-applications/${applicationId}/${decision}`,
            'POST',
            accessToken,
            decision === 'reject'
              ? { operation_id: operation!.operationId, reason: normalizedReason }
              : { operation_id: operation!.operationId },
            15_000,
            {
              expectedUserId: actorId,
              expectedSessionGeneration: requestScope.sessionGeneration,
            }
          )
        )
        if (!flight.started) {
          await flight.promise.catch(() => undefined)
          return false
        }

        ownsPhysicalRequest = true
        editActionOperationIdRef.current[actionOwnerKey] = operation.operationId
        setActionLoading((prev) => ({ ...prev, [loadingKey]: true }))

        const result = await flight.promise
        if (result.stale || !isViewerScopeCurrent(requestScope)) return false
        const ownsActiveIntent = () =>
          editActionOperationIdRef.current[actionOwnerKey] === operation!.operationId &&
          isCurrentGroupApplicationOperation(operation!)
        if (!ownsActiveIntent()) return false

        const exactAcknowledgement =
          decision === 'approve'
            ? isExactApproveGroupProfileEditAck(
                result.data,
                operation,
                applicationId,
                expectedGroupId
              )
            : isExactRejectGroupProfileEditAck(
                result.data,
                operation,
                applicationId,
                expectedGroupId,
                normalizedReason
              )
        const terminalConflict = !result.ok && result.status === 409

        if (result.ok && exactAcknowledgement) {
          await loadEditApplicationsGuarded(ownsActiveIntent)
          if (!isViewerScopeCurrent(requestScope) || !ownsActiveIntent()) return false
          return completeGroupApplicationOperation(operation)
        }

        if (terminalConflict) {
          await loadEditApplicationsGuarded(ownsActiveIntent)
          if (!isViewerScopeCurrent(requestScope) || !ownsActiveIntent()) return false
        }

        if (!result.ok && result.status >= 400 && result.status < 500) {
          if (!completeGroupApplicationOperation(operation)) return false
        }
        const errorMessage =
          typeof result.data === 'object' &&
          result.data !== null &&
          'error' in result.data &&
          typeof (result.data as { error?: unknown }).error === 'string'
            ? (result.data as { error: string }).error
            : t('adminOperationFailed')
        showToast?.(errorMessage, 'error')
        return false
      } catch (_err) {
        if (
          isViewerScopeCurrent(requestScope) &&
          (!operation || editActionOperationIdRef.current[actionOwnerKey] === operation.operationId)
        ) {
          showToast?.(t('adminNetworkError'), 'error')
        }
        return false
      } finally {
        const completedOperation = operation
        if (ownsPhysicalRequest && completedOperation)
          queueMicrotask(() => {
            if (
              editActionOperationIdRef.current[actionOwnerKey] === completedOperation.operationId
            ) {
              delete editActionOperationIdRef.current[actionOwnerKey]
              if (isViewerScopeCurrent(requestScope)) {
                setActionLoading((prev) => ({ ...prev, [loadingKey]: false }))
              }
            }
          })
      }
    },
    [accessToken, editApplications, loadEditApplicationsGuarded, showToast, stateOwnerKey, t]
  )

  const approveEditApplication = useCallback(
    (applicationId: string) => runEditApplicationAction(applicationId, 'approve'),
    [runEditApplicationAction]
  )

  const rejectEditApplication = useCallback(
    (applicationId: string, reason?: string) =>
      runEditApplicationAction(applicationId, 'reject', reason),
    [runEditApplicationAction]
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
