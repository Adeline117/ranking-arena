'use client'

import { useCallback, useRef } from 'react'
import { authedFetch } from '@/lib/api/client'
import { jwtSubject } from '@/lib/auth/token-subject'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import { useViewerSlotState } from '@/lib/groups/use-viewer-slot-state'
import { parseFreshnessReport, type FreshnessReport } from '@/lib/rankings/freshness-report'
import { logger } from '@/lib/logger'

export type FreshnessLoadErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'network'
  | 'server'
  | 'invalid_response'

export interface FreshnessLoadError {
  kind: FreshnessLoadErrorKind
  status: number
}

function errorForStatus(status: number): FreshnessLoadError {
  if (status === 401) return { kind: 'unauthorized', status }
  if (status === 403) return { kind: 'forbidden', status }
  if (status >= 500) return { kind: 'server', status }
  return { kind: 'network', status }
}

export function useFreshness(accessToken: string | null) {
  const renderScope = getViewerScope()
  const renderActorId = jwtSubject(accessToken)
  const stateOwnerKey =
    renderActorId &&
    renderScope.userId === renderActorId &&
    renderScope.viewerKey === `user:${renderActorId}`
      ? `${renderScope.viewerKey}:${renderScope.sessionGeneration}`
      : `unbound:${renderActorId ?? 'none'}:${renderScope.sessionGeneration}`

  const [freshnessReport, setFreshnessReport] = useViewerSlotState<FreshnessReport | null>(
    stateOwnerKey,
    null
  )
  const [loading, setLoading] = useViewerSlotState(stateOwnerKey, false)
  const [error, setError] = useViewerSlotState<FreshnessLoadError | null>(stateOwnerKey, null)
  const requestSequenceRef = useRef(0)
  const activeRequestByOwnerRef = useRef(new Map<string, number>())

  const loadFreshnessReport = useCallback(async (): Promise<boolean> => {
    const actorId = jwtSubject(accessToken)
    const requestScope = getViewerScope()
    const requestOwnerKey = `${requestScope.viewerKey}:${requestScope.sessionGeneration}`
    if (
      !accessToken ||
      !actorId ||
      requestScope.userId !== actorId ||
      requestScope.viewerKey !== `user:${actorId}` ||
      stateOwnerKey !== requestOwnerKey ||
      !isViewerScopeCurrent(requestScope)
    ) {
      return false
    }

    const requestId = ++requestSequenceRef.current
    activeRequestByOwnerRef.current.set(stateOwnerKey, requestId)
    setLoading(true)
    setError(null)

    try {
      const result = await authedFetch<unknown>(
        '/api/admin/data-freshness',
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
        activeRequestByOwnerRef.current.get(stateOwnerKey) !== requestId
      ) {
        return false
      }
      if (!result.ok) {
        setError(errorForStatus(result.status))
        return false
      }

      try {
        setFreshnessReport(parseFreshnessReport(result.data))
      } catch (parseError) {
        logger.error('Freshness report contract validation failed:', parseError)
        setError({ kind: 'invalid_response', status: result.status })
        return false
      }
      return true
    } catch (requestError) {
      if (
        isViewerScopeCurrent(requestScope) &&
        activeRequestByOwnerRef.current.get(stateOwnerKey) === requestId
      ) {
        logger.error('Error loading freshness report:', requestError)
        setError({ kind: 'network', status: 0 })
      }
      return false
    } finally {
      if (activeRequestByOwnerRef.current.get(stateOwnerKey) === requestId) {
        activeRequestByOwnerRef.current.delete(stateOwnerKey)
        if (isViewerScopeCurrent(requestScope)) setLoading(false)
      }
    }
  }, [accessToken, stateOwnerKey, setError, setFreshnessReport, setLoading])

  return {
    freshnessReport,
    loading,
    error,
    loadFreshnessReport,
  }
}

export type { FreshnessReport, PlatformFreshnessStatus } from '@/lib/rankings/freshness-report'
