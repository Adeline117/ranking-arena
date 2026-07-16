'use client'

/**
 * Account settings surface for real trader alerts.
 *
 * AlertConfig deliberately lives on a trader profile, where the user can see
 * the account they are configuring. This component provides the missing other
 * half: a truthful list of persisted alerts and a way to remove one. It never
 * manufactures local-only alert state.
 */

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { Box, Text, Button } from '@/app/components/base'
import { tokens, alpha } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { authedFetch } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import EmptyState from '@/app/components/ui/EmptyState'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

interface TraderAlert {
  id: string
  trader_id: string
  source: string | null
  alert_roi_change: boolean
  alert_drawdown: boolean
  alert_score_change: boolean
  alert_rank_change: boolean
  enabled: boolean
}

type TraderAlertsPayload = {
  data?: { alerts?: unknown }
  alerts?: unknown
}

type TraderAlertsUiState = {
  alerts: TraderAlert[]
  loading: boolean
  forbidden: boolean
  removing: string | null
}

type TraderAlertsOperation = {
  id: number
  viewer: SettingsViewerSnapshot
}

const emptyTraderAlertsUiState = (): TraderAlertsUiState => ({
  alerts: [],
  loading: true,
  forbidden: false,
  removing: null,
})

function traderAlertsScopeKey(
  viewer: SettingsViewerSnapshot | null,
  fallback: { viewerKey: string; sessionGeneration: number }
): string {
  return viewer
    ? `${viewer.viewerKey}\u0000${viewer.sessionGeneration}`
    : `invalid:${fallback.viewerKey}\u0000${fallback.sessionGeneration}`
}

function readAlerts(payload: TraderAlertsPayload | null): TraderAlert[] {
  const candidate = payload?.data?.alerts ?? payload?.alerts
  return Array.isArray(candidate) ? (candidate as TraderAlert[]) : []
}

function profileHref(alert: TraderAlert): string {
  const params = new URLSearchParams()
  if (alert.source) params.set('platform', alert.source)
  const query = params.toString()
  return `/trader/${encodeURIComponent(alert.trader_id)}${query ? `?${query}` : ''}`
}

export default function TraderAlertsManager() {
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const { t } = useLanguage()
  const tRef = useRef(t)
  tRef.current = t
  const { showToast } = useToast()
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast
  const currentViewer = captureSettingsViewer(auth)
  const scopeKey = traderAlertsScopeKey(currentViewer, auth)
  const [ui, setUi] = useViewerOwnedState<TraderAlertsUiState>(
    emptyTraderAlertsUiState,
    emptyTraderAlertsUiState,
    scopeKey
  )
  const uiRef = useRef(ui)
  uiRef.current = ui
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const loadOperationRef = useRef<TraderAlertsOperation | null>(null)
  const removeOperationRef = useRef<TraderAlertsOperation | null>(null)

  const viewerIsCurrent = (viewer: SettingsViewerSnapshot): boolean =>
    mountedRef.current && isSettingsViewerCurrent(viewer, authRef.current)

  const operationIsCurrent = (
    operation: TraderAlertsOperation,
    operationRef: { current: TraderAlertsOperation | null }
  ): boolean => operationRef.current?.id === operation.id && viewerIsCurrent(operation.viewer)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadOperationRef.current = null
      removeOperationRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!currentViewer) return
    const operation: TraderAlertsOperation = {
      id: ++nextOperationIdRef.current,
      viewer: currentViewer,
    }
    const controller = new AbortController()
    loadOperationRef.current = operation
    setUi(emptyTraderAlertsUiState())

    void (async () => {
      try {
        const result = await authedFetch<TraderAlertsPayload>(
          '/api/trader-alerts',
          'GET',
          operation.viewer.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: controller.signal,
          }
        )
        if (!operationIsCurrent(operation, loadOperationRef) || result.stale) return
        if (result.status === 403) {
          setUi((current) => ({ ...current, alerts: [], forbidden: true }))
          return
        }
        if (!result.ok) throw new Error('Failed to load trader alerts')
        setUi((current) => ({
          ...current,
          alerts: readAlerts(result.data),
          forbidden: false,
        }))
      } catch {
        if (operationIsCurrent(operation, loadOperationRef)) {
          showToastRef.current(tRef.current('traderAlertsLoadFailed'), 'error')
        }
      } finally {
        if (operationIsCurrent(operation, loadOperationRef)) {
          setUi((current) => ({ ...current, loading: false }))
          loadOperationRef.current = null
        }
      }
    })()

    return () => {
      controller.abort()
      if (loadOperationRef.current?.id === operation.id) loadOperationRef.current = null
    }
    // Access-token rotation does not change the viewer-owned resource identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const remove = async (alert: TraderAlert) => {
    const viewer = captureSettingsViewer(authRef.current)
    if (
      !viewer ||
      uiRef.current.removing !== null ||
      !uiRef.current.alerts.some((current) => current.id === alert.id)
    ) {
      return
    }
    if (!window.confirm(t('traderAlertsRemoveConfirm'))) return
    if (!viewerIsCurrent(viewer)) return
    const operation: TraderAlertsOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
    }
    removeOperationRef.current = operation
    setUi((current) => ({ ...current, removing: alert.id }))
    try {
      const result = await authedFetch<{ deleted?: boolean }>(
        `/api/trader-alerts?id=${encodeURIComponent(alert.id)}`,
        'DELETE',
        operation.viewer.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
        }
      )
      if (!operationIsCurrent(operation, removeOperationRef) || result.stale) return
      if (!result.ok) throw new Error('Failed to delete trader alert')
      setUi((current) => ({
        ...current,
        alerts: current.alerts.filter((item) => item.id !== alert.id),
      }))
      showToastRef.current(tRef.current('alertDisabled'), 'success')
    } catch {
      if (operationIsCurrent(operation, removeOperationRef)) {
        showToastRef.current(tRef.current('traderAlertsRemoveFailed'), 'error')
      }
    } finally {
      if (operationIsCurrent(operation, removeOperationRef)) {
        setUi((current) => ({ ...current, removing: null }))
        removeOperationRef.current = null
      }
    }
  }

  const signedOut = auth.authChecked && !auth.loading && !auth.userId
  if (!currentViewer && !signedOut) {
    return (
      <Text size="sm" color="tertiary">
        {t('loading')}
      </Text>
    )
  }

  if (currentViewer && ui.loading) {
    return (
      <Text size="sm" color="tertiary">
        {t('loading')}
      </Text>
    )
  }

  if (signedOut) {
    return (
      <EmptyState
        variant="card"
        title={t('watchlistSignInTitle')}
        description={t('watchlistSignInDesc')}
        action={
          <Link
            href={`/login?redirect=${encodeURIComponent('/saved?tab=alerts')}`}
            style={ctaStyle}
          >
            {t('login')}
          </Link>
        }
      />
    )
  }

  if (ui.forbidden) {
    return (
      <EmptyState
        variant="card"
        title={t('traderAlertsProRequired')}
        description={t('pricingProAlerts')}
        action={
          <Link href="/pricing" style={ctaStyle}>
            {t('upgrade')}
          </Link>
        }
      />
    )
  }

  if (ui.alerts.length === 0) {
    return (
      <EmptyState
        variant="card"
        title={t('traderAlertsNone')}
        description={t('traderAlertsDesc2')}
        action={
          <Link href="/rankings" style={ctaStyle}>
            {t('watchlistBrowseRankings')}
          </Link>
        }
      />
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {ui.alerts.map((alert) => {
        const conditions = [
          alert.alert_roi_change && t('alertRoiChangeLabel'),
          alert.alert_drawdown && t('alertDrawdownLabel'),
          alert.alert_score_change && 'Arena Score',
          alert.alert_rank_change && t('alertRankChangeLabel'),
        ].filter(Boolean)
        return (
          <Box
            key={alert.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: tokens.spacing[3],
              padding: tokens.spacing[3],
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              background: alpha(tokens.colors.bg.tertiary, 35),
            }}
          >
            <Box style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <Link
                href={profileHref(alert)}
                style={{
                  color: tokens.colors.text.primary,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  textDecoration: 'none',
                }}
              >
                {alert.trader_id}
              </Link>
              <Text size="xs" color="tertiary">
                {[alert.source, alert.enabled ? t('traderAlertsEnabled') : t('traderAlertsPaused')]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <Text size="xs" color="secondary">
                {conditions.length > 0 ? conditions.join(' · ') : t('traderAlertsNoConditions')}
              </Text>
            </Box>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void remove(alert)}
              disabled={ui.removing === alert.id}
              aria-label={t('traderAlertsRemove')}
            >
              {ui.removing === alert.id ? t('loading') : t('traderAlertsRemove')}
            </Button>
          </Box>
        )
      })}
    </Box>
  )
}

const ctaStyle: React.CSSProperties = {
  display: 'inline-flex',
  minHeight: 44,
  alignItems: 'center',
  justifyContent: 'center',
  padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
  borderRadius: tokens.radius.md,
  background: 'var(--color-accent-primary)',
  color: 'var(--color-bg-primary)',
  fontWeight: tokens.typography.fontWeight.semibold,
  textDecoration: 'none',
}
