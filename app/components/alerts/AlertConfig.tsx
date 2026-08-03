'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Box, Text, Button } from '../base'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import EmptyState from '@/app/components/ui/EmptyState'
import ErrorMessage from '@/app/components/ui/ErrorMessage'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

import { AlertRow } from './AlertRowComponents'
import { AlertHistory, type HistoryItem } from './AlertHistory'

interface AlertConfigProps {
  traderId: string
  traderHandle: string
  source?: string
  userId?: string
  onClose?: () => void
  resourceScopeRef?: { current: string }
}

interface AlertData {
  id?: string
  alert_roi_change: boolean
  roi_change_threshold: number
  alert_drawdown: boolean
  drawdown_threshold: number
  alert_score_change: boolean
  score_change_threshold: number
  alert_rank_change: boolean
  rank_change_threshold: number
  one_time: boolean
  enabled: boolean
}

interface TraderAlertsPayload {
  error?: unknown
  data?: { alerts?: unknown; alert?: AlertMutationResult }
  alerts?: unknown
}

interface AlertHistoryPayload {
  error?: unknown
  data?: { history?: unknown }
  history?: unknown
}

interface AlertMutationResult {
  id?: unknown
  enabled?: unknown
}

interface AlertMutationPayload {
  success?: unknown
  error?: unknown
  data?: {
    alert?: AlertMutationResult
    deleted?: unknown
    id?: unknown
  }
}

type AlertOperation = {
  id: number
  resourceScopeKey: string
  viewer: SettingsViewerSnapshot
  controller: AbortController
}

const defaultAlert = (): AlertData => ({
  alert_roi_change: true,
  roi_change_threshold: 10,
  alert_drawdown: true,
  drawdown_threshold: 20,
  alert_score_change: false,
  score_change_threshold: 5,
  alert_rank_change: false,
  rank_change_threshold: 5,
  one_time: false,
  enabled: true,
})

function alertConfigScopeKey(
  viewer: SettingsViewerSnapshot,
  traderId: string,
  source?: string
): string {
  return `${viewer.viewerKey}\u0000${viewer.sessionGeneration}\u0000${traderId}\u0000${source ?? ''}`
}

function responseError(payload: { error?: unknown } | null, fallback: string): string {
  return typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : fallback
}

function readAlerts(payload: TraderAlertsPayload | null): unknown[] | null {
  const alerts = payload?.data?.alerts ?? payload?.alerts
  return Array.isArray(alerts) ? alerts : null
}

function readHistory(payload: AlertHistoryPayload | null): HistoryItem[] | null {
  const history = payload?.data?.history ?? payload?.history
  return Array.isArray(history) ? (history as HistoryItem[]) : null
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readAlert(value: unknown): AlertData | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id.trim()) return null
  return {
    id: record.id,
    alert_roi_change: booleanOr(record.alert_roi_change, true),
    roi_change_threshold: numberOr(record.roi_change_threshold, 10),
    alert_drawdown: booleanOr(record.alert_drawdown, true),
    drawdown_threshold: numberOr(record.drawdown_threshold, 20),
    alert_score_change: booleanOr(record.alert_score_change, false),
    score_change_threshold: numberOr(record.score_change_threshold, 5),
    alert_rank_change: booleanOr(record.alert_rank_change, false),
    rank_change_threshold: numberOr(record.rank_change_threshold, 5),
    one_time: booleanOr(record.one_time, false),
    enabled: booleanOr(record.enabled, true),
  }
}

function readMutationAlert(payload: AlertMutationPayload | null): AlertMutationResult | null {
  return payload?.data?.alert ?? null
}

function isSuccessfulMutationPayload(payload: AlertMutationPayload | null): boolean {
  return payload?.success === true && payload.error === undefined
}

function isDeleteAcknowledged(
  payload: AlertMutationPayload | null,
  expectedAlertId: string
): boolean {
  return payload?.data?.deleted === true && payload.data.id === expectedAlertId
}

/**
 * The auth gate owns the remount boundary. A principal or trader identity
 * change cannot reuse local alert/history state from the previous scope.
 */
export default function AlertConfig(props: AlertConfigProps) {
  const auth = useAuthSession()
  const { t } = useLanguage()
  const viewer = captureSettingsViewer(auth)
  const exactViewer = viewer && viewer.userId === props.userId ? viewer : null
  const scopeKey = exactViewer
    ? alertConfigScopeKey(exactViewer, props.traderId, props.source)
    : `invalid:${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${props.traderId}\u0000${props.source ?? ''}`
  const localResourceScopeRef = useRef(scopeKey)
  localResourceScopeRef.current = scopeKey
  const resourceScopeRef = props.resourceScopeRef ?? localResourceScopeRef

  if (!exactViewer) {
    if (!props.userId || (auth.authChecked && !auth.loading && !auth.userId)) {
      return (
        <Box style={{ padding: 16, textAlign: 'center' }}>
          <Text style={{ color: tokens.colors.text.secondary }}>{t('loginRequired')}</Text>
        </Box>
      )
    }
    if (!auth.authChecked || auth.loading) {
      return (
        <Box style={{ padding: 16, textAlign: 'center' }}>
          <Text style={{ color: tokens.colors.text.secondary }}>{t('loading')}</Text>
        </Box>
      )
    }
    return (
      <Box style={{ padding: tokens.spacing[4] }}>
        <ErrorMessage message={t('loginRequired')} />
      </Box>
    )
  }

  return (
    <ViewerScopedAlertConfig
      key={scopeKey}
      {...props}
      operationResourceScopeKey={scopeKey}
      resourceScopeRef={resourceScopeRef}
      viewer={exactViewer}
    />
  )
}

function ViewerScopedAlertConfig({
  traderId,
  traderHandle,
  source,
  onClose,
  viewer,
  operationResourceScopeKey,
  resourceScopeRef,
}: AlertConfigProps & {
  viewer: SettingsViewerSnapshot
  operationResourceScopeKey: string
  resourceScopeRef: { current: string }
}) {
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewerRef = useRef(viewer)
  viewerRef.current = viewer
  const { t } = useLanguage()
  const tRef = useRef(t)
  tRef.current = t
  const { showToast } = useToast()
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  const [alert, setAlert] = useState<AlertData>(defaultAlert)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)

  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const loadOperationRef = useRef<AlertOperation | null>(null)
  const saveOperationRef = useRef<AlertOperation | null>(null)
  const deleteOperationRef = useRef<AlertOperation | null>(null)
  const toggleOperationRef = useRef<AlertOperation | null>(null)

  const viewerIsCurrent = (snapshot: SettingsViewerSnapshot): boolean =>
    mountedRef.current && isSettingsViewerCurrent(snapshot, authRef.current)

  const operationIsCurrent = (
    operation: AlertOperation,
    operationRef: { current: AlertOperation | null }
  ): boolean =>
    operationRef.current?.id === operation.id &&
    resourceScopeRef.current === operation.resourceScopeKey &&
    viewerIsCurrent(operation.viewer)

  const mutationsInFlight = (): boolean =>
    Boolean(saveOperationRef.current || deleteOperationRef.current || toggleOperationRef.current)
  const resourceIsCurrent = (): boolean => resourceScopeRef.current === operationResourceScopeKey

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadOperationRef.current?.controller.abort()
      saveOperationRef.current?.controller.abort()
      deleteOperationRef.current?.controller.abort()
      toggleOperationRef.current?.controller.abort()
      loadOperationRef.current = null
      saveOperationRef.current = null
      deleteOperationRef.current = null
      toggleOperationRef.current = null
    }
  }, [])

  useEffect(() => {
    const operation: AlertOperation = {
      id: ++nextOperationIdRef.current,
      resourceScopeKey: operationResourceScopeKey,
      viewer: viewerRef.current,
      controller: new AbortController(),
    }
    if (
      resourceScopeRef.current !== operationResourceScopeKey ||
      !viewerIsCurrent(operation.viewer)
    ) {
      return
    }
    loadOperationRef.current = operation
    const loadIsCurrent = () =>
      loadOperationRef.current?.id === operation.id &&
      resourceScopeRef.current === operation.resourceScopeKey &&
      viewerIsCurrent(operation.viewer)
    setLoading(true)
    setLoadError(null)
    setForbidden(false)
    setAlert(defaultAlert())
    setHistory([])

    void (async () => {
      try {
        const query = new URLSearchParams({ trader_id: traderId })
        if (source) query.set('source', source)
        const result = await authedFetch<TraderAlertsPayload>(
          `/api/trader-alerts?${query}`,
          'GET',
          operation.viewer.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        if (!loadIsCurrent() || result.stale) return
        if (result.status === 403) {
          setForbidden(true)
          return
        }
        if (!result.ok) {
          throw new Error(responseError(result.data, tRef.current('adminLoadFailed')))
        }
        const rows = readAlerts(result.data)
        if (!rows) throw new Error(tRef.current('adminLoadFailed'))
        if (rows.length === 0) return

        const existing = readAlert(rows[0])
        if (!existing) throw new Error(tRef.current('adminLoadFailed'))
        let nextHistory: HistoryItem[] = []
        if (existing.id) {
          const historyResult = await authedFetch<AlertHistoryPayload>(
            `/api/alerts?alert_id=${encodeURIComponent(existing.id)}&limit=20`,
            'GET',
            operation.viewer.accessToken,
            undefined,
            15_000,
            {
              expectedUserId: operation.viewer.userId,
              expectedSessionGeneration: operation.viewer.sessionGeneration,
              signal: operation.controller.signal,
            }
          )
          if (!loadIsCurrent() || historyResult.stale) return
          if (historyResult.status === 403) {
            setForbidden(true)
            return
          }
          if (!historyResult.ok) {
            throw new Error(responseError(historyResult.data, tRef.current('adminLoadFailed')))
          }
          const parsedHistory = readHistory(historyResult.data)
          if (!parsedHistory) throw new Error(tRef.current('adminLoadFailed'))
          nextHistory = parsedHistory
        }
        if (!loadIsCurrent()) return
        setAlert(existing)
        setHistory(nextHistory)
      } catch (error) {
        if (!loadIsCurrent()) return
        const message =
          error instanceof Error && error.message ? error.message : tRef.current('adminLoadFailed')
        setLoadError(message)
        showToastRef.current(message, 'error')
      } finally {
        if (loadIsCurrent()) {
          setLoading(false)
          loadOperationRef.current = null
        }
      }
    })()

    return () => {
      operation.controller.abort()
      if (loadOperationRef.current?.id === operation.id) loadOperationRef.current = null
    }
    // Viewer/token freshness is deliberately read through refs. Identity and
    // resource changes remount this keyed component; retries change loadAttempt.
  }, [loadAttempt, operationResourceScopeKey, resourceScopeRef, source, traderId])

  const handleSave = async () => {
    const operationViewer = viewerRef.current
    if (!resourceIsCurrent() || !viewerIsCurrent(operationViewer) || mutationsInFlight()) return
    const operation: AlertOperation = {
      id: ++nextOperationIdRef.current,
      resourceScopeKey: operationResourceScopeKey,
      viewer: operationViewer,
      controller: new AbortController(),
    }
    const alertSnapshot = { ...alert }
    saveOperationRef.current = operation
    setSaving(true)
    try {
      const result = await authedFetch<AlertMutationPayload>(
        '/api/trader-alerts',
        'POST',
        operation.viewer.accessToken,
        { trader_id: traderId, source, ...alertSnapshot },
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent(operation, saveOperationRef) || result.stale) return
      if (!result.ok) {
        throw new Error(responseError(result.data, tRef.current('saveFailed2')))
      }
      if (!isSuccessfulMutationPayload(result.data)) {
        throw new Error(responseError(result.data, tRef.current('saveFailed2')))
      }
      const savedAlert = readMutationAlert(result.data)
      if (
        typeof savedAlert?.id !== 'string' ||
        !savedAlert.id.trim() ||
        (alertSnapshot.id !== undefined && savedAlert.id !== alertSnapshot.id)
      ) {
        throw new Error(tRef.current('saveFailed2'))
      }
      const savedAlertId = savedAlert.id
      setAlert((current) => ({ ...current, id: savedAlertId }))
      showToastRef.current(tRef.current('alertEnabled'), 'success')
    } catch (error) {
      if (!operationIsCurrent(operation, saveOperationRef)) return
      showToastRef.current(
        error instanceof Error && error.message ? error.message : tRef.current('saveFailed2'),
        'error'
      )
    } finally {
      const canCommit = operationIsCurrent(operation, saveOperationRef)
      if (saveOperationRef.current?.id === operation.id) saveOperationRef.current = null
      if (canCommit) setSaving(false)
    }
  }

  const handleDelete = async () => {
    const operationViewer = viewerRef.current
    const alertId = alert.id
    if (
      !alertId ||
      !resourceIsCurrent() ||
      !viewerIsCurrent(operationViewer) ||
      mutationsInFlight()
    ) {
      return
    }
    const operation: AlertOperation = {
      id: ++nextOperationIdRef.current,
      resourceScopeKey: operationResourceScopeKey,
      viewer: operationViewer,
      controller: new AbortController(),
    }
    deleteOperationRef.current = operation
    setDeleting(true)
    try {
      const result = await authedFetch<AlertMutationPayload>(
        `/api/trader-alerts?id=${encodeURIComponent(alertId)}`,
        'DELETE',
        operation.viewer.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent(operation, deleteOperationRef) || result.stale) return
      if (!result.ok) {
        throw new Error(responseError(result.data, tRef.current('saveFailed2')))
      }
      if (!isSuccessfulMutationPayload(result.data)) {
        throw new Error(responseError(result.data, tRef.current('saveFailed2')))
      }
      if (!isDeleteAcknowledged(result.data, alertId)) throw new Error(tRef.current('saveFailed2'))
      setAlert(defaultAlert())
      setHistory([])
      showToastRef.current(tRef.current('alertDisabled'), 'success')
    } catch (error) {
      if (!operationIsCurrent(operation, deleteOperationRef)) return
      showToastRef.current(
        error instanceof Error && error.message ? error.message : tRef.current('saveFailed2'),
        'error'
      )
    } finally {
      const canCommit = operationIsCurrent(operation, deleteOperationRef)
      if (deleteOperationRef.current?.id === operation.id) deleteOperationRef.current = null
      if (canCommit) setDeleting(false)
    }
  }

  const handleToggle = async () => {
    const operationViewer = viewerRef.current
    if (
      !alert.id ||
      !resourceIsCurrent() ||
      !viewerIsCurrent(operationViewer) ||
      mutationsInFlight()
    ) {
      return
    }
    const operation: AlertOperation = {
      id: ++nextOperationIdRef.current,
      resourceScopeKey: operationResourceScopeKey,
      viewer: operationViewer,
      controller: new AbortController(),
    }
    const alertSnapshot = { ...alert }
    const previousEnabled = alertSnapshot.enabled
    const newEnabled = !previousEnabled
    toggleOperationRef.current = operation
    setToggling(true)
    setAlert((current) => ({ ...current, enabled: newEnabled }))

    try {
      const result = await authedFetch<AlertMutationPayload>(
        '/api/trader-alerts',
        'POST',
        operation.viewer.accessToken,
        { trader_id: traderId, source, ...alertSnapshot, enabled: newEnabled },
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent(operation, toggleOperationRef) || result.stale) return
      if (!result.ok) {
        throw new Error(responseError(result.data, tRef.current('saveFailed2')))
      }
      if (!isSuccessfulMutationPayload(result.data)) {
        throw new Error(responseError(result.data, tRef.current('saveFailed2')))
      }
      const updatedAlert = readMutationAlert(result.data)
      if (
        typeof updatedAlert?.id !== 'string' ||
        !updatedAlert.id.trim() ||
        updatedAlert.id !== alertSnapshot.id ||
        updatedAlert.enabled !== newEnabled
      ) {
        throw new Error(tRef.current('saveFailed2'))
      }
      showToastRef.current(
        newEnabled ? tRef.current('alertEnabled') : tRef.current('alertDisabled'),
        'success'
      )
    } catch (error) {
      if (!operationIsCurrent(operation, toggleOperationRef)) return
      setAlert((current) => ({ ...current, enabled: previousEnabled }))
      showToastRef.current(
        error instanceof Error && error.message ? error.message : tRef.current('saveFailed2'),
        'error'
      )
    } finally {
      const canCommit = operationIsCurrent(operation, toggleOperationRef)
      if (toggleOperationRef.current?.id === operation.id) toggleOperationRef.current = null
      if (canCommit) setToggling(false)
    }
  }

  if (loading) {
    return (
      <Box style={{ padding: 16, textAlign: 'center' }}>
        <Text style={{ color: tokens.colors.text.secondary }}>{t('loading')}</Text>
      </Box>
    )
  }

  if (forbidden) {
    return (
      <EmptyState
        variant="card"
        title={t('traderAlertsProRequired')}
        description={t('pricingProAlerts')}
        action={
          <Link
            href="/pricing"
            className="tap-target"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.md,
              background: tokens.colors.accent.primary,
              color: tokens.colors.white,
              fontWeight: tokens.typography.fontWeight.bold,
              textDecoration: 'none',
            }}
          >
            {t('upgrade')}
          </Link>
        }
      />
    )
  }

  if (loadError) {
    return (
      <Box style={{ padding: tokens.spacing[4] }}>
        <ErrorMessage
          message={loadError}
          onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
        />
      </Box>
    )
  }

  const alertTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      roi_change: t('alertRoiChangeLabel'),
      drawdown: t('alertDrawdownLabel'),
      score_change: 'Arena Score',
      rank_change: t('alertRankChangeLabel'),
    }
    return labels[type] || type
  }

  const mutationBusy = saving || deleting || toggling

  return (
    <Box
      style={{
        padding: 16,
        borderRadius: tokens.radius.lg,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <Text
          style={{
            fontWeight: tokens.typography.fontWeight.semibold,
            fontSize: tokens.typography.fontSize.md,
          }}
        >
          {t('alertSettings')} - {traderHandle}
        </Text>
        <Box style={{ display: 'flex', gap: 8 }}>
          {alert.id && (
            <Button
              onClick={handleToggle}
              disabled={mutationBusy}
              aria-busy={toggling}
              style={{
                padding: '4px 12px',
                fontSize: tokens.typography.fontSize.sm,
                borderRadius: tokens.radius.sm,
                background: alert.enabled
                  ? tokens.colors.accent.success
                  : tokens.colors.bg.tertiary,
                color: alert.enabled ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                border: 'none',
                cursor: mutationBusy ? 'not-allowed' : 'pointer',
                opacity: mutationBusy ? 0.6 : 1,
              }}
            >
              {alert.enabled ? t('alertEnabled') : t('alertDisabled')}
            </Button>
          )}
          {onClose && (
            <Button
              onClick={onClose}
              style={{
                padding: '4px 8px',
                fontSize: tokens.typography.fontSize.sm,
                borderRadius: tokens.radius.sm,
                background: 'transparent',
                border: `1px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
              }}
            >
              X
            </Button>
          )}
        </Box>
      </Box>

      <Text
        style={{
          marginBottom: 12,
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.tertiary,
        }}
      >
        {t('alertCheckCadence')}
      </Text>

      {/* Alert rows */}
      <AlertRow
        label={t('alertRoiChangeLabel')}
        desc={t('alertRoiChangeDesc')}
        checked={alert.alert_roi_change}
        onToggle={() => setAlert((prev) => ({ ...prev, alert_roi_change: !prev.alert_roi_change }))}
        threshold={alert.roi_change_threshold}
        onThresholdChange={(v) => setAlert((prev) => ({ ...prev, roi_change_threshold: v }))}
        unit="%"
      />
      <AlertRow
        label={t('alertDrawdownLabel')}
        desc={t('alertDrawdownDesc')}
        checked={alert.alert_drawdown}
        onToggle={() => setAlert((prev) => ({ ...prev, alert_drawdown: !prev.alert_drawdown }))}
        threshold={alert.drawdown_threshold}
        onThresholdChange={(v) => setAlert((prev) => ({ ...prev, drawdown_threshold: v }))}
        unit="%"
      />
      <AlertRow
        label={t('alertRankChangeLabel')}
        desc={t('alertRankChangeDesc')}
        checked={alert.alert_rank_change}
        onToggle={() =>
          setAlert((prev) => ({ ...prev, alert_rank_change: !prev.alert_rank_change }))
        }
        threshold={alert.rank_change_threshold}
        onThresholdChange={(v) => setAlert((prev) => ({ ...prev, rank_change_threshold: v }))}
        unit={t('alertRankUnit')}
      />
      <AlertRow
        label={t('alertScoreChangeLabel')}
        desc={t('alertScoreChangeDesc')}
        checked={alert.alert_score_change}
        onToggle={() =>
          setAlert((prev) => ({ ...prev, alert_score_change: !prev.alert_score_change }))
        }
        threshold={alert.score_change_threshold}
        onThresholdChange={(v) => setAlert((prev) => ({ ...prev, score_change_threshold: v }))}
        unit={t('alertScoreUnit')}
      />
      {/* One-time toggle */}
      <Box
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 16 }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={alert.one_time}
            onChange={() => setAlert((prev) => ({ ...prev, one_time: !prev.one_time }))}
          />
          <Text
            style={{
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
            }}
          >
            {t('alertOneTime')}
          </Text>
        </label>
      </Box>

      {/* Action buttons */}
      <Box style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Button
          onClick={handleSave}
          disabled={mutationBusy}
          style={{
            flex: 1,
            padding: '8px 16px',
            borderRadius: tokens.radius.md,
            background: tokens.colors.accent.primary,
            color: 'var(--color-on-accent)',
            border: 'none',
            cursor: mutationBusy ? 'not-allowed' : 'pointer',
            opacity: mutationBusy ? 0.6 : 1,
            fontWeight: tokens.typography.fontWeight.semibold,
          }}
        >
          {saving ? `\u23F3 ${t('saving')}` : t('save')}
        </Button>
        {alert.id && (
          <Button
            onClick={handleDelete}
            disabled={mutationBusy}
            aria-busy={deleting}
            style={{
              padding: '8px 16px',
              borderRadius: tokens.radius.md,
              background: 'transparent',
              color: tokens.colors.accent.error,
              border: `1px solid ${tokens.colors.accent.error}`,
              cursor: mutationBusy ? 'not-allowed' : 'pointer',
              opacity: mutationBusy ? 0.6 : 1,
            }}
          >
            {t('delete')}
          </Button>
        )}
      </Box>

      {/* Alert history */}
      {alert.id && <AlertHistory history={history} alertTypeLabel={alertTypeLabel} />}
    </Box>
  )
}
