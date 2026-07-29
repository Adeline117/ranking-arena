'use client'

import { useEffect, useRef, useState } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import type { MembershipInfo } from './membership-config'

type PortalFlow = 'payment_method_update' | 'subscription_cancel'

interface SubscriptionManagementProps {
  info: MembershipInfo | null
  cardStyle: React.CSSProperties
  /** Kept for compatibility with the parent while auth is now captured canonically here. */
  getAuthHeadersAsync: () => Promise<Record<string, string>>
  t: (key: string) => string
  /** Test seam for the irreversible browser navigation to Stripe Portal. */
  redirectToPortal?: (url: string) => void
}

type PortalOperation = {
  id: number
  viewer: SettingsViewerSnapshot
  controller: AbortController
}

type PortalUiOwner = Pick<SettingsViewerSnapshot, 'viewerKey' | 'sessionGeneration' | 'userId'>

function samePortalViewer(
  owner: PortalUiOwner | null,
  viewer: SettingsViewerSnapshot | null
): boolean {
  return (
    owner !== null &&
    viewer !== null &&
    owner.viewerKey === viewer.viewerKey &&
    owner.sessionGeneration === viewer.sessionGeneration &&
    owner.userId === viewer.userId
  )
}

function defaultPortalRedirect(url: string): void {
  window.location.href = url
}

export default function SubscriptionManagement({
  info,
  cardStyle,
  t,
  redirectToPortal = defaultPortalRedirect,
}: SubscriptionManagementProps) {
  const { showToast } = useToast()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const mountedRef = useRef(false)
  const operationRef = useRef<PortalOperation | null>(null)
  const nextOperationIdRef = useRef(0)
  const [rawShowCancelConfirm, setShowCancelConfirm] = useState(false)
  const [confirmOwner, setConfirmOwner] = useState<PortalUiOwner | null>(null)
  const [rawPortalFlow, setPortalFlow] = useState<PortalFlow | null>(null)
  const [portalUiOwner, setPortalUiOwner] = useState<PortalUiOwner | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.controller.abort()
      operationRef.current = null
    }
  }, [])

  useEffect(() => {
    const operation = operationRef.current
    if (operation && !isSettingsViewerCurrent(operation.viewer, authRef.current)) {
      operation.controller.abort()
      operationRef.current = null
    }
  }, [auth.authChecked, auth.loading, auth.sessionGeneration, auth.userId, auth.viewerKey])

  const renderViewer = captureSettingsViewer(auth)
  const showCancelConfirm = samePortalViewer(confirmOwner, renderViewer)
    ? rawShowCancelConfirm
    : false
  const portalFlow = samePortalViewer(portalUiOwner, renderViewer) ? rawPortalFlow : null
  const controlsDisabled = !renderViewer || portalFlow !== null

  const openPortal = async (flow: PortalFlow, viewer: SettingsViewerSnapshot) => {
    if (!isSettingsViewerCurrent(viewer, authRef.current)) return

    const activeOperation = operationRef.current
    if (activeOperation && isSettingsViewerCurrent(activeOperation.viewer, authRef.current)) return
    activeOperation?.controller.abort()

    const operation: PortalOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
      controller: new AbortController(),
    }
    operationRef.current = operation
    setPortalUiOwner(viewer)
    setPortalFlow(flow)
    const operationIsCurrent = () =>
      mountedRef.current &&
      operationRef.current?.id === operation.id &&
      isSettingsViewerCurrent(viewer, authRef.current)

    let navigating = false
    try {
      const res = await authedFetch<{ url?: unknown; error?: unknown }>(
        '/api/stripe/portal',
        'POST',
        viewer.accessToken,
        {
          flow,
          scope: 'membership',
        },
        15_000,
        {
          expectedUserId: viewer.userId,
          expectedSessionGeneration: viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent() || res.stale) return

      if (res.ok && typeof res.data?.url === 'string' && res.data.url.startsWith('https://')) {
        // Last CAS immediately before the irreversible browser navigation.
        if (!operationIsCurrent()) return
        navigating = true
        redirectToPortal(res.data.url)
        return
      } else {
        showToast(t('paymentSystemComingSoon'), 'error')
      }
    } catch {
      if (operationIsCurrent()) showToast(t('operationFailedTryAgain'), 'error')
    } finally {
      if (!navigating && operationIsCurrent()) {
        setPortalFlow(null)
        operationRef.current = null
      }
    }
  }

  return (
    <div style={{ ...cardStyle, marginBottom: 0 }}>
      <h3
        style={{
          fontSize: 16,
          fontWeight: 700,
          marginBottom: 16,
          color: tokens.colors.text.primary,
        }}
      >
        {t('manageSubscription')}
      </h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <button
          onClick={() => {
            if (renderViewer) void openPortal('payment_method_update', renderViewer)
          }}
          disabled={controlsDisabled}
          style={{
            padding: '10px 20px',
            background: tokens.colors.accent.brand,
            border: 'none',
            borderRadius: tokens.radius.lg,
            color: tokens.colors.white,
            fontWeight: 600,
            cursor: controlsDisabled ? 'wait' : 'pointer',
            fontSize: 14,
            opacity: portalFlow === null ? 1 : 0.65,
          }}
        >
          {t('paymentMethods')}
        </button>
        {info?.subscription && !info.subscription.cancelAtPeriodEnd && !showCancelConfirm && (
          <button
            onClick={() => {
              if (!renderViewer || !isSettingsViewerCurrent(renderViewer, authRef.current)) return
              setConfirmOwner(renderViewer)
              setShowCancelConfirm(true)
            }}
            disabled={controlsDisabled}
            style={{
              padding: '10px 20px',
              background: 'transparent',
              border: `1px solid ${alpha(tokens.colors.accent.error, 25)}`,
              borderRadius: tokens.radius.lg,
              color: tokens.colors.accent.error,
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {t('cancelSubscription')}
          </button>
        )}
        {showCancelConfirm && (
          <div
            style={{
              width: '100%',
              padding: 16,
              background: `${alpha(tokens.colors.accent.error, 3)}`,
              border: `1px solid ${alpha(tokens.colors.accent.error, 19)}`,
              borderRadius: tokens.radius.lg,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                color: tokens.colors.text.primary,
              }}
            >
              {t('cancelSubscriptionConfirm')}
            </p>
            <p style={{ margin: 0, fontSize: 13, color: tokens.colors.text.secondary }}>
              {t('cancelSubscriptionNote')}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                disabled={controlsDisabled}
                onClick={() => {
                  if (
                    !renderViewer ||
                    !samePortalViewer(confirmOwner, renderViewer) ||
                    !isSettingsViewerCurrent(renderViewer, authRef.current)
                  ) {
                    return
                  }
                  setShowCancelConfirm(false)
                  void openPortal('subscription_cancel', renderViewer)
                }}
                style={{
                  padding: '8px 16px',
                  background: tokens.colors.accent.error,
                  border: 'none',
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.white,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                {t('confirmCancel')}
              </button>
              <button
                onClick={() => {
                  if (
                    renderViewer &&
                    samePortalViewer(confirmOwner, renderViewer) &&
                    isSettingsViewerCurrent(renderViewer, authRef.current)
                  ) {
                    setShowCancelConfirm(false)
                  }
                }}
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.secondary,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                {t('keepSubscription')}
              </button>
            </div>
          </div>
        )}
        {info?.subscription?.cancelAtPeriodEnd && (
          <div
            style={{
              padding: '10px 20px',
              background: `${alpha(tokens.colors.accent.warning, 8)}`,
              border: `1px solid ${alpha(tokens.colors.accent.warning, 25)}`,
              borderRadius: tokens.radius.lg,
              color: tokens.colors.accent.warning,
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {t('subscriptionCancelAtEnd')}
          </div>
        )}
      </div>
    </div>
  )
}
