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

interface ExchangeConnectionProps {
  userId: string
}

// Single source of truth: exchange list + display names live in exchange-configs.
const EXCHANGES = EXCHANGE_BIND_LIST

type ViewerSnapshot = {
  viewerKey: string | null
  accessToken: string | null
  generation: number
}

type ConnectionState = {
  viewerKey: string | null
  generation: number
  connections: ExchangeConnection[]
  loading: boolean
  error: string | null
}

type SyncState = {
  viewerKey: string
  generation: number
  exchange: string
} | null

function getAccessTokenSubject(token: string): string | null {
  try {
    const encodedPayload = token.split('.')[1]
    if (!encodedPayload) return null
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const payload = JSON.parse(atob(padded)) as { sub?: unknown }
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

export default function ExchangeConnectionManager({ userId }: ExchangeConnectionProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const auth = useAuthSession()
  const tokenSubject = auth.accessToken ? getAccessTokenSubject(auth.accessToken) : null
  const viewerKey =
    auth.userId && auth.userId === userId && tokenSubject === auth.userId ? auth.userId : null
  const validAccessToken = viewerKey ? auth.accessToken : null
  const scopeRef = useRef<ViewerSnapshot>({
    viewerKey,
    accessToken: validAccessToken,
    generation: 0,
  })

  // Advance ownership during render, before effects. A late viewer-A request is
  // therefore unable to commit state after the first render for viewer B.
  if (
    scopeRef.current.viewerKey !== viewerKey ||
    scopeRef.current.accessToken !== validAccessToken
  ) {
    scopeRef.current = {
      viewerKey,
      accessToken: validAccessToken,
      generation: scopeRef.current.generation + 1,
    }
  }
  const renderedScope = scopeRef.current

  const [connectionState, setConnectionState] = useState<ConnectionState>({
    viewerKey: null,
    generation: -1,
    connections: [],
    loading: true,
    error: null,
  })
  const [syncState, setSyncState] = useState<SyncState>(null)

  const isCurrentSnapshot = useCallback((snapshot: ViewerSnapshot) => {
    const current = scopeRef.current
    return (
      snapshot.viewerKey !== null &&
      snapshot.accessToken !== null &&
      current.viewerKey === snapshot.viewerKey &&
      current.accessToken === snapshot.accessToken &&
      current.generation === snapshot.generation
    )
  }, [])

  const captureSnapshot = useCallback((): ViewerSnapshot | null => {
    const snapshot = scopeRef.current
    if (!snapshot.viewerKey || !snapshot.accessToken) return null
    return { ...snapshot }
  }, [])

  const loadConnections = useCallback(
    async (snapshot: ViewerSnapshot, toastOnFailure = true) => {
      if (!isCurrentSnapshot(snapshot)) return

      setConnectionState({
        viewerKey: snapshot.viewerKey,
        generation: snapshot.generation,
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
        if (!isCurrentSnapshot(snapshot)) return

        const payload = (await response.json()) as {
          data?: { connections?: ExchangeConnection[] }
        }
        if (!isCurrentSnapshot(snapshot)) return

        const nextConnections = payload.data?.connections
        if (
          !response.ok ||
          !Array.isArray(nextConnections) ||
          nextConnections.some((connection) => connection.user_id !== snapshot.viewerKey)
        ) {
          throw new Error(failureMessage)
        }

        setConnectionState({
          viewerKey: snapshot.viewerKey,
          generation: snapshot.generation,
          connections: nextConnections,
          loading: false,
          error: null,
        })
      } catch {
        if (!isCurrentSnapshot(snapshot)) return
        nextError = failureMessage
        setConnectionState({
          viewerKey: snapshot.viewerKey,
          generation: snapshot.generation,
          connections: [],
          loading: false,
          error: failureMessage,
        })
        if (toastOnFailure) showToast(failureMessage, 'error')
      } finally {
        if (!isCurrentSnapshot(snapshot) || nextError) return
        setConnectionState((current) =>
          current.viewerKey === snapshot.viewerKey &&
          current.generation === snapshot.generation &&
          current.loading
            ? { ...current, loading: false }
            : current
        )
      }
    },
    [isCurrentSnapshot, showToast, t]
  )

  useEffect(() => {
    if (!renderedScope.viewerKey || !renderedScope.accessToken) return
    void loadConnections(renderedScope)
  }, [loadConnections, renderedScope])

  const handleRetry = () => {
    const snapshot = captureSnapshot()
    if (snapshot) void loadConnections(snapshot)
  }

  const handleStartAuth = (exchange: string) => {
    // 跳转到授权引导页面
    window.location.href = `/exchange/auth?exchange=${exchange}`
  }

  const handleSync = async (exchange: string) => {
    const snapshot = captureSnapshot()
    if (!snapshot?.viewerKey) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    setSyncState({
      viewerKey: snapshot.viewerKey,
      generation: snapshot.generation,
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
      if (!isCurrentSnapshot(snapshot)) return

      const result = (await response.json()) as { error?: unknown }
      if (!isCurrentSnapshot(snapshot)) return

      if (!response.ok) {
        showToast(typeof result.error === 'string' ? result.error : t('syncError'), 'error')
        return
      }

      showToast(t('syncSuccess'), 'success')
      await loadConnections(snapshot)
      if (!isCurrentSnapshot(snapshot)) return
    } catch (err: unknown) {
      if (!isCurrentSnapshot(snapshot)) return
      showToast(err instanceof Error ? err.message : t('syncError'), 'error')
    } finally {
      if (!isCurrentSnapshot(snapshot)) return
      setSyncState((current) =>
        current?.viewerKey === snapshot.viewerKey &&
        current.generation === snapshot.generation &&
        current.exchange === exchange
          ? null
          : current
      )
    }
  }

  const handleDisconnect = async (exchange: string) => {
    // Capture both the viewer and credential before the confirmation dialog.
    // Never re-read global auth after the user has had time to switch accounts.
    const snapshot = captureSnapshot()
    if (!snapshot) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    const confirmed = await showConfirm(
      t('disconnect'),
      t('confirmDisconnect').replace('{exchange}', exchange)
    )
    if (!isCurrentSnapshot(snapshot)) return
    if (!confirmed) {
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
      if (!isCurrentSnapshot(snapshot)) return

      const result = (await response.json()) as { error?: unknown }
      if (!isCurrentSnapshot(snapshot)) return

      if (!response.ok) {
        showToast(typeof result.error === 'string' ? result.error : t('disconnectFailed'), 'error')
        return
      }

      showToast(t('disconnected'), 'success')
      await loadConnections(snapshot)
      if (!isCurrentSnapshot(snapshot)) return
    } catch (err) {
      if (!isCurrentSnapshot(snapshot)) return
      const errorMessage = err instanceof Error ? err.message : t('disconnectFailed')
      showToast(errorMessage, 'error')
    }
  }

  const stateIsCurrent =
    connectionState.viewerKey === renderedScope.viewerKey &&
    connectionState.generation === renderedScope.generation
  const connections = stateIsCurrent ? connectionState.connections : []
  const loading =
    auth.loading ||
    !auth.authChecked ||
    (!!renderedScope.viewerKey && (!stateIsCurrent || connectionState.loading))
  const error = stateIsCurrent
    ? connectionState.error
    : auth.authChecked && !auth.loading && !renderedScope.viewerKey
      ? t('pleaseLogin')
      : null
  const syncing =
    syncState?.viewerKey === renderedScope.viewerKey &&
    syncState.generation === renderedScope.generation
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
