'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
// MobileBottomNav is rendered by root layout — do not duplicate here
import dynamic from 'next/dynamic'
import PageHeader from '@/app/components/ui/PageHeader'
import ErrorState from '@/app/components/ui/ErrorState'
import PortfolioOverview from '@/app/components/portfolio/PortfolioOverview'
import PositionList from '@/app/components/portfolio/PositionList'

// Lazy load: modal only opens on user action; analytics is below-the-fold
const AddExchangeModal = dynamic(() => import('@/app/components/portfolio/AddExchangeModal'), {
  ssr: false,
})
const PortfolioAnalytics = dynamic(() => import('@/app/components/portfolio/PortfolioAnalytics'), {
  ssr: false,
})
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { authedFetch, type ScopedFetchResult } from '@/lib/api/client'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  captureExchangeViewer,
  isExchangeViewerCurrent,
  type ExchangeViewerSnapshot,
} from '@/lib/exchange/viewer-scope'
import { logger } from '@/lib/logger'

interface Portfolio {
  id: string
  exchange: string
  label: string
  created_at: string
  is_active: boolean
}

interface Position {
  id: string
  symbol: string
  side: 'long' | 'short'
  entry_price: number
  mark_price: number
  size: number
  pnl: number
  pnl_pct: number
  leverage: number
  updated_at: string
  user_portfolios?: { exchange: string; label: string }
}

interface Snapshot {
  total_equity: number
  total_pnl: number
  total_pnl_pct: number
  snapshot_at: string
}

function readListResult<T>(result: ScopedFetchResult<unknown>, endpoint: string): T[] {
  if (!result.ok) {
    throw new Error(`${endpoint} returned HTTP ${result.status}`)
  }

  const payload = result.data as { data?: unknown } | null
  if (!Array.isArray(payload?.data)) {
    throw new Error(`${endpoint} returned an invalid portfolio payload`)
  }

  return payload.data as T[]
}

export default function PortfolioPage() {
  const router = useRouter()
  const auth = useAuthSession()
  const { t } = useLanguage()

  useEffect(() => {
    if (auth.authChecked && !auth.loading && !auth.userId) {
      router.push('/login?redirect=/portfolio')
    }
  }, [auth.authChecked, auth.loading, auth.userId, router])

  const viewer = captureExchangeViewer(auth, auth.userId)

  if (!viewer) {
    const inconsistentAuth = auth.authChecked && !auth.loading && !!auth.userId
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <PageHeader title={t('portfolioTitle')} compact />
          {inconsistentAuth ? (
            <ErrorState
              title={t('somethingWentWrong')}
              description={t('loadFailedRetryShort')}
              retry={() => void auth.refreshSession()}
              variant="compact"
            />
          ) : (
            <PortfolioOverview
              totalEquity={0}
              totalPnl={0}
              totalPnlPct={0}
              snapshots={[]}
              isLoading
            />
          )}
        </div>
      </div>
    )
  }

  const scopeKey = `${viewer.viewerKey}\u0000${viewer.sessionGeneration}`
  return <PortfolioPageContent key={scopeKey} auth={auth} viewer={viewer} />
}

type PortfolioOperation = {
  controller: AbortController
  id: number
  viewer: ExchangeViewerSnapshot
}

function PortfolioPageContent({
  auth,
  viewer,
}: {
  auth: AuthSessionReturn
  viewer: ExchangeViewerSnapshot
}) {
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()
  const [loading, setLoading] = useState(true)
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [hasSuccessfulLoad, setHasSuccessfulLoad] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const authRef = useRef(auth)
  authRef.current = auth
  const operationSequenceRef = useRef(0)
  const loadOperationRef = useRef<PortfolioOperation | null>(null)
  const addOperationRef = useRef<PortfolioOperation | null>(null)
  const syncOperationRef = useRef<PortfolioOperation | null>(null)
  const deleteOperationRef = useRef<PortfolioOperation | null>(null)

  const beginOperation = useCallback((): PortfolioOperation => {
    const operation = {
      controller: new AbortController(),
      id: ++operationSequenceRef.current,
      viewer,
    }
    return operation
  }, [viewer])

  const operationIsCurrent = useCallback((operation: PortfolioOperation) => {
    return isExchangeViewerCurrent(operation.viewer, authRef.current, operation.viewer.userId)
  }, [])

  useEffect(() => {
    return () => {
      loadOperationRef.current?.controller.abort()
      addOperationRef.current?.controller.abort()
      syncOperationRef.current?.controller.abort()
      deleteOperationRef.current?.controller.abort()
    }
  }, [])

  // Load portfolios + positions in parallel with request dedup
  const lastFetchRef = useRef<number>(0)
  const loadAll = useCallback(
    async (force = false) => {
      if (loadOperationRef.current) return
      // Skip if fetched < 30s ago (dedup rapid remounts)
      if (!force && Date.now() - lastFetchRef.current < 30_000) return
      lastFetchRef.current = Date.now()
      const operation = beginOperation()
      loadOperationRef.current = operation
      setLoading(true)
      try {
        const scope = {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
        const [portfolioResult, positionResult, snapshotResult] = await Promise.all([
          authedFetch<unknown>(
            '/api/portfolio',
            'GET',
            operation.viewer.accessToken,
            undefined,
            15_000,
            scope
          ),
          authedFetch<unknown>(
            '/api/portfolio/positions',
            'GET',
            operation.viewer.accessToken,
            undefined,
            15_000,
            scope
          ),
          authedFetch<unknown>(
            '/api/portfolio/snapshots',
            'GET',
            operation.viewer.accessToken,
            undefined,
            15_000,
            scope
          ),
        ])
        const nextPortfolios = readListResult<Portfolio>(portfolioResult, '/api/portfolio')
        const nextPositions = readListResult<Position>(positionResult, '/api/portfolio/positions')
        const nextSnapshots = readListResult<Snapshot>(snapshotResult, '/api/portfolio/snapshots')

        if (loadOperationRef.current?.id !== operation.id || !operationIsCurrent(operation)) {
          return
        }

        // Treat the three endpoints as one snapshot. A partial refresh must not
        // replace last-good data with misleading empty/$0 sections.
        setPortfolios(nextPortfolios)
        setPositions(nextPositions)
        setSnapshots(nextSnapshots)
        setHasSuccessfulLoad(true)
        setLoadFailed(false)
      } catch (error) {
        if (loadOperationRef.current?.id !== operation.id || !operationIsCurrent(operation)) {
          return
        }
        logger.error('Failed to refresh portfolio:', error)
        setLoadFailed(true)
        showToast(t('portfolioLoadFailed'), 'error')
      } finally {
        if (loadOperationRef.current?.id === operation.id) {
          loadOperationRef.current = null
          if (operationIsCurrent(operation)) setLoading(false)
        }
      }
    },
    [beginOperation, operationIsCurrent, showToast, t]
  )

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const handleAddExchange = async (data: {
    exchange: string
    api_key: string
    api_secret: string
    api_passphrase?: string
    label: string
  }) => {
    if (addOperationRef.current) throw new Error(t('portfolioAddFailed'))
    const operation = beginOperation()
    addOperationRef.current = operation
    try {
      const result = await authedFetch<{
        data?: { exchange?: unknown; viewer_id?: unknown }
        error?: unknown
      }>('/api/portfolio', 'POST', operation.viewer.accessToken, data, 15_000, {
        expectedUserId: operation.viewer.userId,
        expectedSessionGeneration: operation.viewer.sessionGeneration,
        signal: operation.controller.signal,
      })
      if (!operationIsCurrent(operation) || addOperationRef.current?.id !== operation.id) return
      if (
        !result.ok ||
        result.data?.data?.viewer_id !== operation.viewer.userId ||
        result.data?.data?.exchange !== data.exchange.toLowerCase()
      ) {
        const error = typeof result.data?.error === 'string' ? result.data.error : null
        throw new Error(error || t('portfolioAddFailed'))
      }
      showToast(t('portfolioConnectSuccess'), 'success')
      await loadAll(true)
    } finally {
      if (addOperationRef.current?.id === operation.id) addOperationRef.current = null
    }
  }

  const handleSync = async (portfolioId: string) => {
    if (syncOperationRef.current) return
    const operation = beginOperation()
    syncOperationRef.current = operation
    setSyncingId(portfolioId)
    try {
      const result = await authedFetch<{
        data?: {
          portfolio_id?: unknown
          reason?: string
          synced?: boolean
          viewer_id?: unknown
        }
      }>(
        '/api/portfolio/sync',
        'POST',
        operation.viewer.accessToken,
        { portfolio_id: portfolioId },
        30_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (!operationIsCurrent(operation) || syncOperationRef.current?.id !== operation.id) return
      const payload = result.data?.data
      const exactAck =
        payload?.viewer_id === operation.viewer.userId && payload.portfolio_id === portfolioId
      const reason = payload?.reason
      // Map stable server reason codes → localized copy.
      const reasonKey: Record<string, string> = {
        geo_unavailable: 'portfolioSyncGeoUnavailable',
        passphrase_required: 'portfolioSyncPassphraseRequired',
        unsupported: 'portfolioSyncUnsupported',
        keys_unreadable: 'portfolioSyncKeysUnreadable',
        exchange_error: 'portfolioSyncExchangeError',
      }
      if (!result.ok || !exactAck) {
        const key = reason ? reasonKey[reason] : undefined
        showToast(key ? t(key) : t('portfolioSyncFailed'), 'error')
        return
      }
      if (payload?.synced === false) {
        // Soft outcome (geo/passphrase/unsupported) — inform, don't error.
        const key = reason ? reasonKey[reason] : undefined
        showToast(key ? t(key) : t('portfolioSyncFailed'), 'info')
        return
      }
      await loadAll(true)
      showToast(t('portfolioSyncSuccess'), 'success')
    } catch {
      if (operationIsCurrent(operation)) showToast(t('portfolioNetworkError'), 'error')
    } finally {
      if (syncOperationRef.current?.id === operation.id) {
        syncOperationRef.current = null
        if (operationIsCurrent(operation)) setSyncingId(null)
      }
    }
  }

  const handleDelete = async (portfolioId: string) => {
    if (deleteOperationRef.current) return
    const operation = beginOperation()
    deleteOperationRef.current = operation
    setDeletingId(portfolioId)
    try {
      const confirmed = await showConfirm(t('portfolioRemoveExchange'), t('portfolioRemoveConfirm'))
      if (!confirmed || !operationIsCurrent(operation)) return
      const result = await authedFetch<{
        data?: { deleted?: unknown; portfolio_id?: unknown; viewer_id?: unknown }
      }>(
        `/api/portfolio?id=${encodeURIComponent(portfolioId)}`,
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
      if (!operationIsCurrent(operation) || deleteOperationRef.current?.id !== operation.id) return
      if (
        !result.ok ||
        result.data?.data?.deleted !== true ||
        result.data.data.portfolio_id !== portfolioId ||
        result.data.data.viewer_id !== operation.viewer.userId
      ) {
        showToast(t('portfolioRemoveFailed'), 'error')
        return
      }
      await loadAll(true)
      showToast(t('portfolioRemoved'), 'success')
    } catch {
      if (operationIsCurrent(operation)) showToast(t('portfolioNetworkError'), 'error')
    } finally {
      if (deleteOperationRef.current?.id === operation.id) {
        deleteOperationRef.current = null
        if (operationIsCurrent(operation)) setDeletingId(null)
      }
    }
  }

  // Totals from positions
  const totalPnl = positions.reduce((sum, p) => sum + Number(p.pnl), 0)
  const totalEquity = positions.reduce((sum, p) => sum + Number(p.size) * Number(p.mark_price), 0)
  const totalPnlPct = totalEquity > 0 ? (totalPnl / totalEquity) * 100 : 0
  const isInitialLoad = loading && !hasSuccessfulLoad

  return (
    <>
      <div style={styles.page}>
        <div style={styles.container}>
          <PageHeader
            title={t('portfolioTitle')}
            compact
            actions={
              <button style={styles.addBtn} onClick={() => setShowAddModal(true)}>
                + {t('portfolioConnectExchange')}
              </button>
            }
          />

          {loadFailed && (
            <ErrorState
              title={t('failedToLoad')}
              description={t('portfolioLoadFailed')}
              retry={() => void loadAll(true)}
              variant="compact"
            />
          )}

          {/* First-run: no connected exchange yet → a focused connect prompt
              instead of hollow $0.00 metric cards + "no positions". */}
          {hasSuccessfulLoad && portfolios.length === 0 ? (
            <div style={styles.emptyState}>
              <div style={styles.emptyIcon} aria-hidden="true">
                📊
              </div>
              <h2 style={styles.emptyTitle}>{t('portfolioEmptyTitle')}</h2>
              <p style={styles.emptyDesc}>{t('apiKeyReadOnlyHint')}</p>
              <button style={styles.addBtn} onClick={() => setShowAddModal(true)}>
                + {t('portfolioConnectExchange')}
              </button>
            </div>
          ) : hasSuccessfulLoad || isInitialLoad ? (
            <PortfolioOverview
              totalEquity={totalEquity}
              totalPnl={totalPnl}
              totalPnlPct={totalPnlPct}
              snapshots={snapshots}
              isLoading={isInitialLoad}
            />
          ) : null}

          {/* Connected exchanges */}
          {portfolios.length > 0 && (
            <div style={styles.section}>
              <h2 style={styles.sectionTitle}>{t('portfolioConnectedExchanges')}</h2>
              <div style={styles.exchangeList}>
                {portfolios.map((p) => (
                  <div key={p.id} style={styles.exchangeCard}>
                    <div style={styles.exchangeInfo}>
                      <span style={styles.exchangeName}>
                        {p.exchange.charAt(0).toUpperCase() + p.exchange.slice(1)}
                      </span>
                      {p.label !== p.exchange && (
                        <span style={styles.exchangeLabel}>{p.label}</span>
                      )}
                    </div>
                    <div style={styles.exchangeActions}>
                      <button
                        style={{ ...styles.syncBtn, opacity: syncingId === p.id ? 0.6 : 1 }}
                        onClick={() => handleSync(p.id)}
                        disabled={!!syncingId || p.is_active === false}
                        title={p.is_active === false ? t('portfolioSyncKeysUnreadable') : undefined}
                      >
                        {syncingId === p.id ? t('portfolioSyncing') : t('portfolioSync')}
                      </button>
                      <button
                        style={{ ...styles.deleteBtn, opacity: deletingId === p.id ? 0.6 : 1 }}
                        onClick={() => handleDelete(p.id)}
                        disabled={!!deletingId}
                      >
                        {deletingId === p.id ? '...' : t('portfolioRemove')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Analytics Dashboard */}
          {hasSuccessfulLoad && positions.length > 0 && (
            <div style={styles.section}>
              <h2 style={styles.sectionTitle}>{t('portfolioAnalytics')}</h2>
              <PortfolioAnalytics positions={positions} snapshots={snapshots} />
            </div>
          )}

          {/* Positions — hidden on the first-run empty state (handled above) */}
          {(isInitialLoad || (hasSuccessfulLoad && portfolios.length > 0)) && (
            <div style={styles.section}>
              <h2 style={styles.sectionTitle}>{t('openPositions')}</h2>
              <PositionList positions={positions} isLoading={isInitialLoad} />
            </div>
          )}
        </div>
      </div>
      {/* MobileBottomNav rendered in root layout */}

      <AddExchangeModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSubmit={handleAddExchange}
      />
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: '12px',
    padding: '48px 24px',
    borderRadius: '16px',
    backgroundColor: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-primary)',
  },
  emptyIcon: {
    fontSize: '40px',
    lineHeight: 1,
  },
  emptyTitle: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
  },
  emptyDesc: {
    margin: 0,
    maxWidth: '420px',
    fontSize: '14px',
    lineHeight: 1.5,
    color: 'var(--color-text-secondary)',
  },
  page: {
    minHeight: '100vh',
    backgroundColor: 'var(--color-bg-primary)',
    // Was 60px, which stacked with the container's 24px top padding (~84px gap
    // before the H1). Other (app) pages rely on the container padding alone.
    paddingTop: '0',
    paddingBottom: '80px',
  },
  container: {
    maxWidth: '960px',
    margin: '0 auto',
    padding: '24px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '12px',
  },
  title: {
    margin: 0,
    fontSize: '24px',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
  },
  addBtn: {
    padding: '10px 20px',
    borderRadius: '10px',
    border: 'none',
    backgroundColor: 'var(--color-brand)',
    color: 'var(--color-on-accent, #fff)',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
  },
  exchangeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  exchangeCard: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderRadius: '12px',
    backgroundColor: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-primary)',
    flexWrap: 'wrap',
    gap: '8px',
  },
  exchangeInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  exchangeName: {
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    fontSize: '14px',
  },
  exchangeLabel: {
    fontSize: '12px',
    color: 'var(--color-text-secondary)',
  },
  exchangeActions: {
    display: 'flex',
    gap: '8px',
  },
  syncBtn: {
    padding: '6px 14px',
    borderRadius: '8px',
    border: '1px solid var(--color-border-primary)',
    backgroundColor: 'transparent',
    color: 'var(--color-brand)',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
  },
  deleteBtn: {
    padding: '6px 14px',
    borderRadius: '8px',
    border: '1px solid var(--color-border-primary)',
    backgroundColor: 'transparent',
    color: 'var(--color-error)',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
  },
}
