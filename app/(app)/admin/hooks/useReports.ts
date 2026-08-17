'use client'

import { useCallback, useRef } from 'react'
import { authedFetch } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import { jwtSubject } from '@/lib/auth/token-subject'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'
import { logger } from '@/lib/logger'

type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void
type ReportStatus = 'pending' | 'resolved' | 'dismissed'
type ReportContentType = 'post' | 'comment' | 'message' | 'user'
type ReportAction = 'resolve' | 'dismiss'
type ReportStatusFilter = ReportStatus | 'all'
type ReportContentTypeFilter = ReportContentType | 'all'

const REPORTS_PAGE_LIMIT = 20
const REPORT_STATUSES = new Set<ReportStatus>(['pending', 'resolved', 'dismissed'])
const REPORT_CONTENT_TYPES = new Set<ReportContentType>(['post', 'comment', 'message', 'user'])

export interface ContentReport {
  id: string
  reporter_id: string
  content_type: ReportContentType
  content_id: string
  reason: string
  description: string | null
  images: string[] | null
  status: ReportStatus
  resolved_by: string | null
  resolved_at: string | null
  action_taken: string | null
  created_at: string
  reporter: {
    id: string
    handle: string | null
    avatar_url: string | null
  } | null
  contentPreview: {
    title?: string
    content?: string
  } | null
  contentAuthor: {
    id: string
    handle: string | null
  } | null
}

export interface ReportsPagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

type ReportsEnvelope = {
  success: true
  data: ContentReport[]
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

type ApiContentReport = Omit<ContentReport, 'contentAuthor' | 'contentPreview'> & {
  details: string | null
}

type ReportResolutionAcknowledgement = {
  ok: true
  applied: boolean
  result: string
  report: {
    id: string
    status: ReportStatus
    content_type: ReportContentType
    content_id: string
  }
  action_taken: string
  content_affected_count: number
  message: string
}

function emptyPagination(page = 1): ReportsPagination {
  return {
    page,
    limit: REPORTS_PAGE_LIMIT,
    total: 0,
    totalPages: 0,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
}

function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === 'string' && REPORT_STATUSES.has(value as ReportStatus)
}

function isReportContentType(value: unknown): value is ReportContentType {
  return typeof value === 'string' && REPORT_CONTENT_TYPES.has(value as ReportContentType)
}

function isReporter(value: unknown): value is ContentReport['reporter'] {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['avatar_url', 'handle', 'id']) &&
      typeof value.id === 'string' &&
      isNullableString(value.handle) &&
      isNullableString(value.avatar_url))
  )
}

function isImages(value: unknown): value is string[] | null {
  return (
    value === null || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  )
}

function isApiContentReport(value: unknown): value is ApiContentReport {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'action_taken',
      'content_id',
      'content_type',
      'created_at',
      'description',
      'details',
      'id',
      'images',
      'reason',
      'reporter',
      'reporter_id',
      'resolved_at',
      'resolved_by',
      'status',
    ]) &&
    typeof value.id === 'string' &&
    typeof value.reporter_id === 'string' &&
    isReportContentType(value.content_type) &&
    typeof value.content_id === 'string' &&
    typeof value.reason === 'string' &&
    isNullableString(value.description) &&
    isImages(value.images) &&
    isReportStatus(value.status) &&
    isNullableString(value.resolved_by) &&
    isNullableString(value.resolved_at) &&
    isNullableString(value.action_taken) &&
    typeof value.created_at === 'string' &&
    Number.isFinite(Date.parse(value.created_at)) &&
    (value.resolved_at === null || Number.isFinite(Date.parse(value.resolved_at))) &&
    isReporter(value.reporter) &&
    isNullableString(value.details) &&
    value.details === value.description
  )
}

function parseReportsEnvelope(
  value: unknown,
  expectedPage: number,
  expectedStatus: ReportStatusFilter,
  expectedContentType: ReportContentTypeFilter
): ReportsEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, ['data', 'meta', 'success'])) return null
  if (value.success !== true || !Array.isArray(value.data) || !isRecord(value.meta)) return null
  if (!hasExactKeys(value.meta, ['pagination', 'timestamp'])) return null
  if (
    typeof value.meta.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(value.meta.timestamp)) ||
    !isRecord(value.meta.pagination) ||
    !hasExactKeys(value.meta.pagination, ['has_more', 'limit', 'offset', 'total'])
  ) {
    return null
  }

  const pagination = value.meta.pagination
  const limit = pagination.limit
  const offset = pagination.offset
  const total = pagination.total
  const hasMore = pagination.has_more
  const expectedOffset = (expectedPage - 1) * REPORTS_PAGE_LIMIT

  if (
    limit !== REPORTS_PAGE_LIMIT ||
    !isFiniteInteger(offset) ||
    offset !== expectedOffset ||
    !isFiniteInteger(total) ||
    total < 0 ||
    typeof hasMore !== 'boolean' ||
    hasMore !== total > offset + limit
  ) {
    return null
  }

  if (
    !value.data.every(isApiContentReport) ||
    value.data.length > limit ||
    value.data.length > Math.max(0, total - offset) ||
    (expectedStatus !== 'all' && value.data.some((report) => report.status !== expectedStatus)) ||
    (expectedContentType !== 'all' &&
      value.data.some((report) => report.content_type !== expectedContentType))
  ) {
    return null
  }

  return {
    success: true,
    data: value.data.map((report) => ({
      id: report.id,
      reporter_id: report.reporter_id,
      content_type: report.content_type,
      content_id: report.content_id,
      reason: report.reason,
      description: report.description,
      images: report.images,
      status: report.status,
      resolved_by: report.resolved_by,
      resolved_at: report.resolved_at,
      action_taken: report.action_taken,
      created_at: report.created_at,
      reporter: report.reporter,
      contentPreview: null,
      contentAuthor: null,
    })),
    meta: {
      timestamp: value.meta.timestamp,
      pagination: { limit, offset, has_more: hasMore, total },
    },
  }
}

function toReportsPagination(envelope: ReportsEnvelope, page: number): ReportsPagination {
  const { limit, total } = envelope.meta.pagination
  return {
    page,
    limit,
    total,
    totalPages: total > 0 ? Math.ceil(total / limit) : 0,
  }
}

function parseResolutionAcknowledgement(
  value: unknown,
  expectedReportId: string,
  action: ReportAction
): ReportResolutionAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'action_taken',
      'applied',
      'content_affected_count',
      'message',
      'ok',
      'report',
      'result',
    ])
  ) {
    return null
  }
  if (
    value.ok !== true ||
    typeof value.applied !== 'boolean' ||
    typeof value.result !== 'string' ||
    typeof value.action_taken !== 'string' ||
    !isFiniteInteger(value.content_affected_count) ||
    value.content_affected_count < 0 ||
    typeof value.message !== 'string' ||
    !isRecord(value.report) ||
    !hasExactKeys(value.report, ['content_id', 'content_type', 'id', 'status'])
  ) {
    return null
  }

  const expectedStatus: ReportStatus = action === 'resolve' ? 'resolved' : 'dismissed'
  if (
    value.report.id !== expectedReportId ||
    !isReportStatus(value.report.status) ||
    value.report.status !== expectedStatus ||
    !isReportContentType(value.report.content_type) ||
    typeof value.report.content_id !== 'string'
  ) {
    return null
  }

  if (value.result !== (value.applied ? 'applied' : 'already_processed')) return null

  if (action === 'dismiss') {
    if (
      value.content_affected_count !== 0 ||
      (value.applied
        ? value.action_taken !== 'dismissed'
        : !['dismissed', 'approved_content'].includes(value.action_taken))
    ) {
      return null
    }
  } else if (
    !['post', 'comment'].includes(value.report.content_type) ||
    (value.applied
      ? !(
          (value.action_taken === 'content_deleted' && value.content_affected_count > 0) ||
          (value.action_taken === 'content_already_absent' && value.content_affected_count === 0)
        )
      : value.content_affected_count !== 0 ||
        !['content_deleted', 'content_already_absent', 'user_banned'].includes(value.action_taken))
  ) {
    return null
  }

  return {
    ok: true,
    applied: value.applied,
    result: value.result,
    report: {
      id: value.report.id,
      status: value.report.status,
      content_type: value.report.content_type,
      content_id: value.report.content_id,
    },
    action_taken: value.action_taken,
    content_affected_count: value.content_affected_count,
    message: value.message,
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

function normalizeReason(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string') return undefined
  const trimmed = reason.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function deriveScopeKey(accessToken: string | null) {
  const scope = getViewerScope()
  const actorId = jwtSubject(accessToken)
  if (
    accessToken &&
    actorId &&
    scope.userId === actorId &&
    scope.viewerKey === `user:${actorId}` &&
    isViewerScopeCurrent(scope)
  ) {
    return {
      actorId,
      scope,
      scopeKey: `${scope.viewerKey}\u0000${scope.sessionGeneration}\u0000${actorId}`,
    }
  }
  return {
    actorId,
    scope,
    scopeKey: `unbound\u0000${scope.viewerKey}\u0000${scope.sessionGeneration}\u0000${actorId ?? ''}`,
  }
}

export function useReports(accessToken: string | null, showToast?: ToastFn) {
  const { t } = useLanguage()
  const { scopeKey } = deriveScopeKey(accessToken)
  const [reports, setReports] = useViewerOwnedState<ContentReport[]>([], () => [], scopeKey)
  const [pagination, setPagination] = useViewerOwnedState<ReportsPagination>(
    emptyPagination(),
    () => emptyPagination(),
    scopeKey
  )
  const [loading, setLoading] = useViewerOwnedState(false, () => false, scopeKey)
  const [error, setError] = useViewerOwnedState<string | null>(null, () => null, scopeKey)
  const [actionLoading, setActionLoading] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const loadRequestSequenceRef = useRef(0)
  const loadRequestIdRef = useRef<Record<string, number>>({})
  const loadAbortControllerRef = useRef<Record<string, AbortController | null>>({})
  const mutationEpochRef = useRef<Record<string, number>>({})
  const reportFlightRef = useRef<Record<string, true>>({})
  const lastQueryRef = useRef<
    Record<
      string,
      { contentType: ReportContentTypeFilter; page: number; status: ReportStatusFilter }
    >
  >({})

  const loadReports = useCallback(
    async (
      page: number = 1,
      status: ReportStatusFilter = 'pending',
      contentType: ReportContentTypeFilter = 'all'
    ) => {
      const loadPage = async (requestedPage: number, allowPageFallback: boolean): Promise<void> => {
        const {
          actorId,
          scope: requestScope,
          scopeKey: requestScopeKey,
        } = deriveScopeKey(accessToken)

        if (
          !accessToken ||
          !actorId ||
          requestScope.viewerKey !== `user:${actorId}` ||
          requestScope.userId !== actorId ||
          requestScopeKey !== scopeKey ||
          !isViewerScopeCurrent(requestScope)
        ) {
          setError(t('adminNotLoggedIn'))
          setReports([])
          setPagination(emptyPagination(requestedPage))
          return
        }

        const requestId = ++loadRequestSequenceRef.current
        loadRequestIdRef.current[scopeKey] = requestId
        loadAbortControllerRef.current[scopeKey]?.abort()
        const controller = new AbortController()
        loadAbortControllerRef.current[scopeKey] = controller
        const mutationEpochAtStart = mutationEpochRef.current[scopeKey] ?? 0
        lastQueryRef.current[scopeKey] = { page: requestedPage, status, contentType }

        setLoading(true)
        setError(null)

        try {
          const params = new URLSearchParams({
            page: String(requestedPage),
            limit: String(REPORTS_PAGE_LIMIT),
            status,
            content_type: contentType,
          })

          const result = await authedFetch<unknown>(
            `/api/admin/reports?${params.toString()}`,
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
            loadRequestIdRef.current[scopeKey] !== requestId ||
            (mutationEpochRef.current[scopeKey] ?? 0) !== mutationEpochAtStart
          ) {
            return
          }

          if (!result.ok) {
            setError(extractErrorMessage(result.data) || t('adminLoadFailed'))
            setReports([])
            setPagination(emptyPagination(requestedPage))
            return
          }

          const envelope = parseReportsEnvelope(result.data, requestedPage, status, contentType)
          if (!envelope) {
            setError(t('adminLoadFailed'))
            setReports([])
            setPagination(emptyPagination(requestedPage))
            return
          }

          const nextPagination = toReportsPagination(envelope, requestedPage)
          if (
            allowPageFallback &&
            envelope.data.length === 0 &&
            nextPagination.totalPages > 0 &&
            requestedPage > nextPagination.totalPages
          ) {
            await loadPage(nextPagination.totalPages, false)
            return
          }

          if (
            loadRequestIdRef.current[scopeKey] !== requestId ||
            (mutationEpochRef.current[scopeKey] ?? 0) !== mutationEpochAtStart
          ) {
            return
          }

          setReports(envelope.data)
          setPagination(nextPagination)
        } catch (err) {
          if (
            controller.signal.aborted ||
            !isViewerScopeCurrent(requestScope) ||
            loadRequestIdRef.current[scopeKey] !== requestId ||
            (mutationEpochRef.current[scopeKey] ?? 0) !== mutationEpochAtStart
          ) {
            return
          }
          logger.error('Error loading reports:', err)
          setError(t('adminNetworkError'))
          setReports([])
          setPagination(emptyPagination(requestedPage))
        } finally {
          if (loadRequestIdRef.current[scopeKey] === requestId) {
            delete loadRequestIdRef.current[scopeKey]
            if (loadAbortControllerRef.current[scopeKey] === controller) {
              delete loadAbortControllerRef.current[scopeKey]
            }
            if (isViewerScopeCurrent(requestScope)) setLoading(false)
          }
        }
      }

      await loadPage(page, true)
    },
    [accessToken, scopeKey, setError, setLoading, setPagination, setReports, t]
  )

  const resolveReport = useCallback(
    async (reportId: string, action: ReportAction, reason?: string) => {
      const {
        actorId,
        scope: requestScope,
        scopeKey: requestScopeKey,
      } = deriveScopeKey(accessToken)
      const normalizedReason = normalizeReason(reason)
      const flightKey = `${requestScopeKey}\u0000${reportId}`

      if (
        !accessToken ||
        !actorId ||
        requestScope.viewerKey !== `user:${actorId}` ||
        requestScope.userId !== actorId ||
        requestScopeKey !== scopeKey ||
        !isViewerScopeCurrent(requestScope) ||
        reportFlightRef.current[flightKey]
      ) {
        return false
      }

      const currentReport = reports.find((entry) => entry.id === reportId)
      if (!currentReport || currentReport.status !== 'pending') return false
      if (action === 'resolve' && !['post', 'comment'].includes(currentReport.content_type)) {
        showToast?.(t('adminOperationFailed'), 'error')
        return false
      }

      reportFlightRef.current[flightKey] = true
      setActionLoading((prev) => ({ ...prev, [reportId]: true }))

      try {
        const result = await authedFetch<unknown>(
          `/api/admin/reports/${reportId}/resolve`,
          'POST',
          accessToken,
          normalizedReason ? { action, reason: normalizedReason } : { action },
          15_000,
          {
            expectedUserId: actorId,
            expectedSessionGeneration: requestScope.sessionGeneration,
          }
        )

        if (
          result.stale ||
          !isViewerScopeCurrent(requestScope) ||
          !reportFlightRef.current[flightKey]
        ) {
          return false
        }

        if (!result.ok) {
          showToast?.(extractErrorMessage(result.data) || t('adminOperationFailed'), 'error')
          return false
        }

        const acknowledgement = parseResolutionAcknowledgement(result.data, reportId, action)
        if (
          !acknowledgement ||
          acknowledgement.report.content_type !== currentReport.content_type ||
          acknowledgement.report.content_id !== currentReport.content_id
        ) {
          showToast?.(t('adminOperationFailed'), 'error')
          return false
        }

        mutationEpochRef.current[scopeKey] = (mutationEpochRef.current[scopeKey] ?? 0) + 1
        const currentQuery = lastQueryRef.current[scopeKey]
        if (currentQuery) {
          await loadReports(currentQuery.page, currentQuery.status, currentQuery.contentType)
        } else {
          setReports((previous) => previous.filter((report) => report.id !== reportId))
          setPagination((previous) => {
            const total = Math.max(0, previous.total - 1)
            return {
              ...previous,
              total,
              totalPages: total > 0 ? Math.ceil(total / previous.limit) : 0,
            }
          })
        }
        return true
      } catch (err) {
        if (!isViewerScopeCurrent(requestScope) || !reportFlightRef.current[flightKey]) {
          return false
        }
        logger.error('Error resolving report:', err)
        showToast?.(t('adminNetworkError'), 'error')
        return false
      } finally {
        delete reportFlightRef.current[flightKey]
        if (requestScopeKey === scopeKey && isViewerScopeCurrent(requestScope)) {
          setActionLoading((prev) => {
            if (!prev[reportId]) return prev
            const next = { ...prev }
            delete next[reportId]
            return next
          })
        }
      }
    },
    [
      accessToken,
      loadReports,
      reports,
      scopeKey,
      setActionLoading,
      setPagination,
      setReports,
      showToast,
      t,
    ]
  )

  return {
    reports,
    pagination,
    loading,
    error,
    actionLoading,
    loadReports,
    resolveReport,
    canResolveReport: (report: ContentReport) =>
      report.status === 'pending' &&
      (report.content_type === 'post' || report.content_type === 'comment'),
  }
}
