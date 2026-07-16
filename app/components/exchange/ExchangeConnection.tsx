'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, Button } from '@/app/components/base'
import { tokens, alpha } from '@/lib/design-tokens'
import type { ExchangeConnection } from '@/lib/exchange'
import ExchangeLogo from '../ui/ExchangeLogo'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { getCsrfHeaders } from '@/lib/api/client'
import { EXCHANGE_BIND_LIST } from '@/app/(app)/exchange/auth/api-key/exchange-configs'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureExchangeViewer,
  isExchangeViewerCurrent,
  type ExchangeViewerSnapshot,
} from '@/lib/exchange/viewer-scope'

interface ExchangeConnectionProps {
  userId: string
}

// Single source of truth: exchange list + display names live in exchange-configs.
const EXCHANGES = EXCHANGE_BIND_LIST

type ConnectionState = {
  viewerKey: `user:${string}` | null
  sessionGeneration: number
  connections: ExchangeConnection[]
  loading: boolean
  error: string | null
}

type SyncState = {
  viewerKey: `user:${string}`
  sessionGeneration: number
  exchange: string
} | null

export default function ExchangeConnectionManager({ userId }: ExchangeConnectionProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const userIdRef = useRef(userId)
  userIdRef.current = userId
  const mountedRef = useRef(false)
  const loadGenerationRef = useRef(0)
  const mutationRef = useRef<{ id: number } | null>(null)
  const nextMutationIdRef = useRef(0)
  const renderedScope = captureExchangeViewer(auth, userId)

  const [connectionState, setConnectionState] = useState<ConnectionState>({
    viewerKey: null,
    sessionGeneration: -1,
    connections: [],
    loading: true,
    error: null,
  })
  const [syncState, setSyncState] = useState<SyncState>(null)

  const isCurrentSnapshot = useCallback((snapshot: ExchangeViewerSnapshot) => {
    return (
      mountedRef.current && isExchangeViewerCurrent(snapshot, authRef.current, userIdRef.current)
    )
  }, [])

  const captureSnapshot = useCallback((): ExchangeViewerSnapshot | null => {
    return captureExchangeViewer(authRef.current, userIdRef.current)
  }, [])

  const loadConnections = useCallback(
    async (snapshot: ExchangeViewerSnapshot, toastOnFailure = true) => {
      if (!isCurrentSnapshot(snapshot)) return
      const loadGeneration = ++loadGenerationRef.current
      const loadIsCurrent = () =>
        loadGenerationRef.current === loadGeneration && isCurrentSnapshot(snapshot)

      setConnectionState({
        viewerKey: snapshot.viewerKey,
        sessionGeneration: snapshot.sessionGeneration,
        connections: [],
        loading: true,
        error: null,
      })

      const failureMessage = t('loadConnectionsFailed')
      let nextError: string | null = null

      try {
        const response = await fetch('/api/exchange/connections', {
          headers: { Authorization: `Bearer ${snapshot.accessToken}` },
          cache: 'no-store',
        })
        if (!loadIsCurrent()) return

        const payload = (await response.json()) as {
          data?: { connections?: ExchangeConnection[] }
        }
        if (!loadIsCurrent()) return

        const nextConnections = payload.data?.connections
        if (
          !response.ok ||
          !Array.isArray(nextConnections) ||
          nextConnections.some((connection) => connection.user_id !== snapshot.userId)
        ) {
          throw new Error(failureMessage)
        }

        setConnectionState({
          viewerKey: snapshot.viewerKey,
          sessionGeneration: snapshot.sessionGeneration,
          connections: nextConnections,
          loading: false,
          error: null,
        })
      } catch {
        if (!loadIsCurrent()) return
        nextError = failureMessage
        setConnectionState({
          viewerKey: snapshot.viewerKey,
          sessionGeneration: snapshot.sessionGeneration,
          connections: [],
          loading: false,
          error: failureMessage,
        })
        if (toastOnFailure) showToast(failureMessage, 'error')
      } finally {
        if (!loadIsCurrent() || nextError) return
        setConnectionState((current) =>
          current.viewerKey === snapshot.viewerKey &&
          current.sessionGeneration === snapshot.sessionGeneration &&
          current.loading
            ? { ...current, loading: false }
            : current
        )
      }
    },
    [isCurrentSnapshot, showToast, t]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadGenerationRef.current += 1
      mutationRef.current = null
    }
  }, [])

  useEffect(() => {
    loadGenerationRef.current += 1
    mutationRef.current = null
    setSyncState(null)
    const snapshot = captureSnapshot()
    if (!snapshot) return
    void loadConnections(snapshot)
  }, [
    auth.accessToken,
    auth.sessionGeneration,
    auth.userId,
    captureSnapshot,
    loadConnections,
    userId,
  ])

  const beginMutation = () => {
    const snapshot = captureSnapshot()
    if (!snapshot || mutationRef.current) return null
    const operation = { id: ++nextMutationIdRef.current, snapshot }
    mutationRef.current = operation
    return operation
  }

  const mutationIsCurrent = (operation: { id: number; snapshot: ExchangeViewerSnapshot }) =>
    mutationRef.current?.id === operation.id && isCurrentSnapshot(operation.snapshot)

  const finishMutation = (operation: { id: number; snapshot: ExchangeViewerSnapshot }) => {
    if (mutationRef.current?.id !== operation.id) return
    mutationRef.current = null
    if (isCurrentSnapshot(operation.snapshot)) setSyncState(null)
  }

  const handleRetry = () => {
    const snapshot = captureSnapshot()
    if (snapshot) void loadConnections(snapshot)
  }

  const handleStartAuth = (exchange: string) => {
    const snapshot = captureSnapshot()
    if (!snapshot || !isCurrentSnapshot(snapshot)) return
    // 跳转到授权引导页面
    window.location.href = `/exchange/auth?exchange=${exchange}`
  }

  const handleSync = async (exchange: string) => {
    if (mutationRef.current) return
    const operation = beginMutation()
    if (!operation) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }
    const { snapshot } = operation

    setSyncState({
      viewerKey: snapshot.viewerKey,
      sessionGeneration: snapshot.sessionGeneration,
      exchange,
    })

    try {
      const response = await fetch('/api/exchange/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${snapshot.accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ exchange }),
      })
      if (!mutationIsCurrent(operation)) return

      const result = (await response.json()) as { error?: unknown }
      if (!mutationIsCurrent(operation)) return

      if (!response.ok) {
        showToast(typeof result.error === 'string' ? result.error : t('syncError'), 'error')
        return
      }

      showToast(t('syncSuccess'), 'success')
      await loadConnections(snapshot)
      if (!mutationIsCurrent(operation)) return
    } catch (err: unknown) {
      if (!mutationIsCurrent(operation)) return
      showToast(err instanceof Error ? err.message : t('syncError'), 'error')
    } finally {
      finishMutation(operation)
    }
  }

  const handleDisconnect = async (exchange: string) => {
    // Capture both the viewer and credential before the confirmation dialog.
    // Never re-read global auth after the user has had time to switch accounts.
    if (mutationRef.current) return
    const operation = beginMutation()
    if (!operation) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }
    const { snapshot } = operation

    let confirmed = false
    try {
      confirmed = await showConfirm(
        t('disconnect'),
        t('confirmDisconnect').replace('{exchange}', exchange)
      )
    } catch {
      if (mutationIsCurrent(operation)) showToast(t('disconnectFailed'), 'error')
    }
    if (!mutationIsCurrent(operation)) return
    if (!confirmed) {
      finishMutation(operation)
      return
    }

    try {
      const response = await fetch('/api/exchange/disconnect', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${snapshot.accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ exchange }),
      })
      if (!mutationIsCurrent(operation)) return

      const result = (await response.json()) as { error?: unknown }
      if (!mutationIsCurrent(operation)) return

      if (!response.ok) {
        showToast(typeof result.error === 'string' ? result.error : t('disconnectFailed'), 'error')
        return
      }

      showToast(t('disconnected'), 'success')
      await loadConnections(snapshot)
      if (!mutationIsCurrent(operation)) return
    } catch (err) {
      if (!mutationIsCurrent(operation)) return
      const errorMessage = err instanceof Error ? err.message : t('disconnectFailed')
      showToast(errorMessage, 'error')
    } finally {
      finishMutation(operation)
    }
  }

  const stateIsCurrent =
    !!renderedScope &&
    connectionState.viewerKey === renderedScope.viewerKey &&
    connectionState.sessionGeneration === renderedScope.sessionGeneration
  const connections = stateIsCurrent ? connectionState.connections : []
  const loading =
    auth.loading ||
    !auth.authChecked ||
    (!!renderedScope && (!stateIsCurrent || connectionState.loading))
  const error = stateIsCurrent
    ? connectionState.error
    : auth.authChecked && !auth.loading && !renderedScope
      ? t('pleaseLogin')
      : null
  const syncing =
    !!renderedScope &&
    syncState?.viewerKey === renderedScope.viewerKey &&
    syncState.sessionGeneration === renderedScope.sessionGeneration
      ? syncState.exchange
      : null

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[4] }}>
        <Text color="tertiary">{t('loading')}</Text>
      </Box>
    )
  }

  if (error) {
    return (
      <Box
        style={{
          padding: tokens.spacing[4],
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[3],
          alignItems: 'center',
        }}
      >
        <Text style={{ textAlign: 'center', color: tokens.colors.accent.error }}>{error}</Text>
        <Button onClick={handleRetry} size="sm" style={{ marginTop: tokens.spacing[2] }}>
          {t('retry')}
        </Button>
      </Box>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      <Text size="lg" weight="black">
        {t('bindExchangeAccount')}
      </Text>
      <Text size="sm" color="tertiary">
        {t('bindExchangeAccountFull')}
      </Text>

      {EXCHANGES.map((exchange) => {
        const connection = connections.find((c) => c.exchange === exchange.id && c.is_active)
        const isSyncing = syncing === exchange.id

        return (
          <Box key={exchange.id} bg="secondary" p={6} radius="xl" border="primary">
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: tokens.spacing[4],
              }}
            >
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <ExchangeLogo
                  exchange={exchange.id as 'binance' | 'bybit' | 'bitget' | 'mexc' | 'coinex'}
                  size={32}
                />
                <Text size="lg" weight="bold">
                  {exchange.name}
                </Text>
                {connection && (
                  <Box
                    style={{
                      padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                      borderRadius: tokens.radius.sm,
                      background:
                        connection.last_sync_status === 'success'
                          ? alpha(tokens.colors.accent.success, 8)
                          : connection.last_sync_status === 'error'
                            ? alpha(tokens.colors.accent.error, 8)
                            : tokens.colors.bg.tertiary,
                      fontSize: tokens.typography.fontSize.xs,
                      color:
                        connection.last_sync_status === 'success'
                          ? tokens.colors.accent.success
                          : connection.last_sync_status === 'error'
                            ? tokens.colors.accent.error
                            : tokens.colors.text.secondary,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {connection.last_sync_status === 'success' && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                    {connection.last_sync_status === 'error' && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                      </svg>
                    )}
                    {connection.last_sync_status === 'pending' && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    )}
                    {connection.last_sync_status === 'success'
                      ? t('connected')
                      : connection.last_sync_status === 'error'
                        ? t('syncFailed')
                        : connection.last_sync_status === 'pending'
                          ? t('syncing')
                          : t('connected')}
                  </Box>
                )}
              </Box>

              {connection ? (
                <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleSync(exchange.id)}
                    disabled={isSyncing}
                  >
                    {isSyncing ? t('syncing') : t('refreshData')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleDisconnect(exchange.id)}
                  >
                    {t('disconnect')}
                  </Button>
                </Box>
              ) : (
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => handleStartAuth(exchange.id)}
                  style={{
                    minWidth: 120,
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                  }}
                >
                  <ExchangeLogo exchange={exchange.id} size={20} />
                  {t('bindExchange')} {exchange.name}
                </Button>
              )}
            </Box>

            {connection && connection.last_sync_at && (
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                {t('lastSync')}
                {new Date(connection.last_sync_at).toLocaleString()}
              </Text>
            )}

            {connection && connection.last_sync_error && (
              <Box
                style={{
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  background: 'var(--color-accent-error-10)',
                  border: '1px solid var(--color-red-border)',
                  marginBottom: tokens.spacing[2],
                }}
              >
                <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                  {t('syncErrorMsg')}
                  {connection.last_sync_error}
                </Text>
              </Box>
            )}

            {!connection && (
              <Box
                style={{
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  marginTop: tokens.spacing[3],
                }}
              >
                <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                  {t('clickToBind').replace('{exchange}', exchange.name)}
                </Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
