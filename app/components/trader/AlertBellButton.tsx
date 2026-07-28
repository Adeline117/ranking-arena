'use client'

/**
 * AlertBellButton — surfaces the per-trader alert config on the trader profile
 * (A4 retention). The full AlertConfig UI + the check-trader-alerts cron
 * evaluation + notification delivery already existed, but there was NO entry
 * point on the trader page: users could Follow/Watchlist a trader but not
 * "notify me when this trader's rank/ROI/score moves". This bell closes that
 * gap by opening the existing AlertConfig in a modal — explicit opt-in per
 * trader (no notification spam), reusing all existing infra.
 */

import { useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
import { trackEvent } from '@/lib/analytics/track'
import { authedFetch } from '@/lib/api/client'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

// Heavy config panel — load only when the modal opens (keeps the header light).
const AlertConfig = dynamic(() => import('@/app/components/alerts/AlertConfig'), { ssr: false })

interface AlertBellButtonProps {
  traderId: string
  traderHandle: string
  source?: string
}

type TraderAlertsPayload = {
  data?: { alerts?: unknown }
  alerts?: unknown
}

type ActiveStatusOperation = {
  id: number
  resourceScopeKey: string
  viewer: SettingsViewerSnapshot
}

function alertResourceScopeKey(
  viewer: SettingsViewerSnapshot | null,
  fallback: { viewerKey: string; sessionGeneration: number },
  traderId: string,
  source?: string
): string {
  const viewerScope = viewer
    ? `${viewer.viewerKey}\u0000${viewer.sessionGeneration}`
    : `invalid:${fallback.viewerKey}\u0000${fallback.sessionGeneration}`
  return `${viewerScope}\u0000${traderId}\u0000${source ?? ''}`
}

function hasPersistedAlerts(payload: TraderAlertsPayload | null): boolean {
  const alerts = payload?.data?.alerts ?? payload?.alerts
  return Array.isArray(alerts) && alerts.length > 0
}

export default function AlertBellButton({ traderId, traderHandle, source }: AlertBellButtonProps) {
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const { t } = useLanguage()
  const currentViewer = captureSettingsViewer(auth)
  const scopeKey = alertResourceScopeKey(currentViewer, auth, traderId, source)
  const resourceScopeKeyRef = useRef(scopeKey)
  resourceScopeKeyRef.current = scopeKey
  const [open, setOpen] = useViewerOwnedState(false, () => false, scopeKey)
  const [active, setActive] = useViewerOwnedState(false, () => false, scopeKey)
  const [loadAttempt, setLoadAttempt] = useViewerOwnedState(0, () => 0, scopeKey)
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const statusOperationRef = useRef<ActiveStatusOperation | null>(null)

  const operationIsCurrent = (operation: ActiveStatusOperation): boolean =>
    mountedRef.current &&
    statusOperationRef.current?.id === operation.id &&
    resourceScopeKeyRef.current === operation.resourceScopeKey &&
    isSettingsViewerCurrent(operation.viewer, authRef.current)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      statusOperationRef.current = null
    }
  }, [])

  useEffect(() => {
    const viewer = captureSettingsViewer(authRef.current)
    if (!viewer || resourceScopeKeyRef.current !== scopeKey) return
    const operation: ActiveStatusOperation = {
      id: ++nextOperationIdRef.current,
      resourceScopeKey: scopeKey,
      viewer,
    }
    const controller = new AbortController()
    statusOperationRef.current = operation
    setActive(false)
    const query = new URLSearchParams({ trader_id: traderId })
    if (source) query.set('source', source)

    void (async () => {
      try {
        const result = await authedFetch<TraderAlertsPayload>(
          `/api/trader-alerts?${query}`,
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
        if (!operationIsCurrent(operation) || result.stale || !result.ok) return
        setActive(hasPersistedAlerts(result.data))
      } catch {
        // The bell remains usable when status lookup temporarily fails.
      } finally {
        if (statusOperationRef.current?.id === operation.id) {
          statusOperationRef.current = null
        }
      }
    })()

    return () => {
      controller.abort()
      if (statusOperationRef.current?.id === operation.id) {
        statusOperationRef.current = null
      }
    }
    // Token rotation does not change viewer ownership, but does give a later
    // lookup fresh credentials.
  }, [auth.accessToken, loadAttempt, scopeKey, setActive, source, traderId])

  const handleClick = () => {
    const viewer = captureSettingsViewer(authRef.current)
    if (!viewer || resourceScopeKeyRef.current !== scopeKey) {
      if (authRef.current.authChecked && !authRef.current.loading && !authRef.current.userId) {
        useLoginModal.getState().openLoginModal()
      }
      return
    }
    trackEvent('create_trader_alert', { traderId, source: source || '', step: 'open' })
    setOpen(true)
  }

  const signedOut = auth.authChecked && !auth.loading && !auth.userId
  const authPending = !currentViewer && !signedOut

  return (
    <>
      <button
        onClick={handleClick}
        disabled={authPending}
        aria-label={active ? t('alertsActive') : t('setAlert')}
        aria-pressed={active}
        title={active ? t('alertsActive') : t('setAlert')}
        className="interactive-scale"
        style={{
          padding: '8px 12px',
          minHeight: 44,
          borderRadius: tokens.radius.lg,
          border: active
            ? `1px solid var(--color-accent-warning, #f59e0b)`
            : `1px solid ${tokens.colors.border.primary}`,
          background: active
            ? 'var(--color-accent-warning-10, rgba(245, 158, 11, 0.1))'
            : tokens.glass.bg.light,
          color: active ? 'var(--color-accent-warning, #f59e0b)' : tokens.colors.text.secondary,
          cursor: authPending ? 'not-allowed' : 'pointer',
          opacity: authPending ? 0.6 : 1,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.borderColor = 'var(--color-accent-warning, #f59e0b)'
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.borderColor = tokens.colors.border.primary
        }}
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill={active ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      </button>

      <ModalOverlay
        open={open && Boolean(currentViewer)}
        onClose={() => {
          setOpen(false)
          setLoadAttempt((attempt) => attempt + 1)
        }}
        label={t('setAlert')}
        maxWidth={480}
      >
        <div style={{ padding: 24 }}>
          {currentViewer && (
            <>
              <AlertConfig
                traderId={traderId}
                traderHandle={traderHandle}
                source={source}
                userId={currentViewer.userId}
                resourceScopeRef={resourceScopeKeyRef}
              />
              <Link
                href="/saved?tab=alerts"
                onClick={() => setOpen(false)}
                aria-label={t('viewAllAlerts')}
                style={{
                  display: 'inline-flex',
                  minHeight: 44,
                  alignItems: 'center',
                  marginTop: tokens.spacing[3],
                  color: tokens.colors.accent.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  textDecoration: 'none',
                }}
              >
                {t('viewAllAlerts')} →
              </Link>
            </>
          )}
        </div>
      </ModalOverlay>
    </>
  )
}
