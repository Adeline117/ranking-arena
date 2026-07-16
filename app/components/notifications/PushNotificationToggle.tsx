'use client'

import React, { useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { ToggleSwitch } from '@/app/(app)/settings/components/shared'
import { logger } from '@/lib/logger'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

type PushStatus = 'loading' | 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

interface PushNotificationToggleProps {
  onToast?: (message: string, type: 'success' | 'error') => void
}

type PushUiState = {
  status: PushStatus
  busy: boolean
}

type PushOperation = {
  id: number
  viewer: SettingsViewerSnapshot
}

type PushSubscriptionStatusPayload = {
  data?: { subscribed?: unknown }
}

const emptyPushUiState = (): PushUiState => ({ status: 'loading', busy: false })

function pushScopeKey(
  viewer: SettingsViewerSnapshot | null,
  fallback: { viewerKey: string; sessionGeneration: number }
): string {
  return viewer
    ? `${viewer.viewerKey}\u0000${viewer.sessionGeneration}`
    : `invalid:${fallback.viewerKey}\u0000${fallback.sessionGeneration}`
}

function pushIsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  )
}

function readSubscribed(payload: PushSubscriptionStatusPayload | null): boolean | null {
  return typeof payload?.data?.subscribed === 'boolean' ? payload.data.subscribed : null
}

export function PushNotificationToggle({ onToast }: PushNotificationToggleProps) {
  const { t } = useLanguage()
  const tRef = useRef(t)
  tRef.current = t
  const toastRef = useRef(onToast || ((message: string) => logger.warn(message)))
  toastRef.current = onToast || ((message: string) => logger.warn(message))
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const currentViewer = captureSettingsViewer(auth)
  const scopeKey = pushScopeKey(currentViewer, auth)
  const [ui, setUi] = useViewerOwnedState<PushUiState>(emptyPushUiState, emptyPushUiState, scopeKey)
  const uiRef = useRef(ui)
  uiRef.current = ui
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const loadOperationRef = useRef<PushOperation | null>(null)
  const actionOperationRef = useRef<PushOperation | null>(null)

  const viewerIsCurrent = (viewer: SettingsViewerSnapshot): boolean =>
    mountedRef.current && isSettingsViewerCurrent(viewer, authRef.current)

  const operationIsCurrent = (
    operation: PushOperation,
    operationRef: { current: PushOperation | null }
  ): boolean => operationRef.current?.id === operation.id && viewerIsCurrent(operation.viewer)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadOperationRef.current = null
      actionOperationRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!currentViewer) return
    const operation: PushOperation = {
      id: ++nextOperationIdRef.current,
      viewer: currentViewer,
    }
    const controller = new AbortController()
    loadOperationRef.current = operation
    setUi(emptyPushUiState())

    void (async () => {
      if (!pushIsSupported()) {
        if (operationIsCurrent(operation, loadOperationRef)) {
          setUi({ status: 'unsupported', busy: false })
          loadOperationRef.current = null
        }
        return
      }
      if (Notification.permission === 'denied') {
        if (operationIsCurrent(operation, loadOperationRef)) {
          setUi({ status: 'denied', busy: false })
          loadOperationRef.current = null
        }
        return
      }

      try {
        const registration = await navigator.serviceWorker.ready
        if (!operationIsCurrent(operation, loadOperationRef)) return
        const subscription = await registration.pushManager.getSubscription()
        if (!operationIsCurrent(operation, loadOperationRef)) return
        if (!subscription) {
          setUi({ status: 'unsubscribed', busy: false })
          return
        }

        const result = await authedFetch<PushSubscriptionStatusPayload>(
          '/api/push/subscribe/status',
          'POST',
          operation.viewer.accessToken,
          { token: subscription.endpoint },
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: controller.signal,
          }
        )
        if (!operationIsCurrent(operation, loadOperationRef) || result.stale) return
        const subscribed = readSubscribed(result.data)
        if (!result.ok || subscribed === null) {
          throw new Error('Failed to read push subscription status')
        }
        setUi({ status: subscribed ? 'subscribed' : 'unsubscribed', busy: false })
      } catch {
        if (operationIsCurrent(operation, loadOperationRef)) {
          setUi({ status: 'unsupported', busy: false })
        }
      } finally {
        if (operationIsCurrent(operation, loadOperationRef)) loadOperationRef.current = null
      }
    })()

    return () => {
      controller.abort()
      if (loadOperationRef.current?.id === operation.id) loadOperationRef.current = null
    }
    // Access-token rotation does not change the viewer-owned browser resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const subscribe = async () => {
    const viewer = captureSettingsViewer(authRef.current)
    const activeOperation = actionOperationRef.current
    if (
      !viewer ||
      uiRef.current.busy ||
      (activeOperation && viewerIsCurrent(activeOperation.viewer)) ||
      !pushIsSupported()
    ) {
      return
    }
    const operation: PushOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
    }
    actionOperationRef.current = operation
    setUi((current) => ({ ...current, busy: true }))
    try {
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      if (!vapidKey) {
        toastRef.current(tRef.current('pushNotificationError'), 'error')
        return
      }

      const permission = await Notification.requestPermission()
      if (!operationIsCurrent(operation, actionOperationRef)) return
      if (permission !== 'granted') {
        setUi((current) => ({
          ...current,
          status: permission === 'denied' ? 'denied' : 'unsubscribed',
        }))
        toastRef.current(tRef.current('allowNotificationPermission'), 'error')
        return
      }

      const registration = await navigator.serviceWorker.ready
      if (!operationIsCurrent(operation, actionOperationRef)) return
      let subscription = await registration.pushManager.getSubscription()
      if (!operationIsCurrent(operation, actionOperationRef)) return
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
        })
        if (!operationIsCurrent(operation, actionOperationRef)) return
      }

      const json = subscription.toJSON()
      const result = await authedFetch<{ success?: boolean }>(
        '/api/push/subscribe',
        'POST',
        operation.viewer.accessToken,
        {
          token: subscription.endpoint,
          provider: 'web',
          platform: 'web',
          endpoint: subscription.endpoint,
          p256dh: json.keys?.p256dh,
          auth: json.keys?.auth,
        },
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
        }
      )
      if (!operationIsCurrent(operation, actionOperationRef) || result.stale) return
      if (!result.ok) throw new Error('Failed to register push subscription')

      setUi((current) => ({ ...current, status: 'subscribed' }))
      toastRef.current(tRef.current('pushNotificationsEnabled'), 'success')
    } catch (err) {
      if (operationIsCurrent(operation, actionOperationRef)) {
        logger.error('[PushToggle] subscribe error:', err)
        toastRef.current(tRef.current('pushNotificationError'), 'error')
      }
    } finally {
      if (operationIsCurrent(operation, actionOperationRef)) {
        setUi((current) => ({ ...current, busy: false }))
        actionOperationRef.current = null
      }
    }
  }

  const unsubscribe = async () => {
    const viewer = captureSettingsViewer(authRef.current)
    const activeOperation = actionOperationRef.current
    if (
      !viewer ||
      uiRef.current.busy ||
      uiRef.current.status !== 'subscribed' ||
      (activeOperation && viewerIsCurrent(activeOperation.viewer)) ||
      !pushIsSupported()
    ) {
      return
    }
    const operation: PushOperation = {
      id: ++nextOperationIdRef.current,
      viewer,
    }
    actionOperationRef.current = operation
    setUi((current) => ({ ...current, busy: true }))
    try {
      const registration = await navigator.serviceWorker.ready
      if (!operationIsCurrent(operation, actionOperationRef)) return
      const subscription = await registration.pushManager.getSubscription()
      if (!operationIsCurrent(operation, actionOperationRef)) return
      if (!subscription) {
        setUi((current) => ({ ...current, status: 'unsubscribed' }))
        return
      }

      const result = await authedFetch<{ success?: boolean }>(
        '/api/push/subscribe',
        'DELETE',
        operation.viewer.accessToken,
        { token: subscription.endpoint },
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
        }
      )
      if (!operationIsCurrent(operation, actionOperationRef) || result.stale) return
      if (!result.ok) throw new Error('Failed to unregister push subscription')

      // Do not call subscription.unsubscribe(): the same origin endpoint can
      // still be registered to another local account. The authenticated DELETE
      // above disables delivery only for the current viewer.
      setUi((current) => ({ ...current, status: 'unsubscribed' }))
    } catch (err) {
      if (operationIsCurrent(operation, actionOperationRef)) {
        logger.error('[PushToggle] unsubscribe error:', err)
        toastRef.current(tRef.current('pushNotificationError'), 'error')
      }
    } finally {
      if (operationIsCurrent(operation, actionOperationRef)) {
        setUi((current) => ({ ...current, busy: false }))
        actionOperationRef.current = null
      }
    }
  }

  const handleToggle = async (enabled: boolean) => {
    if (enabled) await subscribe()
    else await unsubscribe()
  }

  if (!currentViewer || ui.status === 'unsupported') return null

  const isOn = ui.status === 'subscribed'
  const isDenied = ui.status === 'denied'
  const isLoading = ui.status === 'loading' || ui.busy

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        background: tokens.colors.bg.primary,
        opacity: isLoading ? 0.6 : 1,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
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
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <Box>
          <Text size="sm" weight="medium">
            {t('enablePushNotifications')}
          </Text>
          {isDenied && (
            <Text size="xs" color="tertiary">
              {t('allowNotificationPermission')}
            </Text>
          )}
        </Box>
      </Box>
      {!(isDenied || isLoading) ? (
        <ToggleSwitch checked={isOn} onChange={handleToggle} />
      ) : (
        <Box style={{ opacity: 0.4, pointerEvents: 'none' }}>
          <ToggleSwitch checked={isOn} onChange={() => {}} />
        </Box>
      )}
    </Box>
  )
}
