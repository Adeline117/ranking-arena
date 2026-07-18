'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
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
import { getCsrfHeaders } from '@/lib/api/client'
import { bootstrapClientAuth } from '@/lib/auth/client-auth-bootstrap'
import { logger } from '@/lib/logger'

interface Portfolio {
  id: string
  exchange: string
  label: string
  created_at: string
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

async function readListResponse<T>(response: Response, endpoint: string): Promise<T[]> {
  if (!response.ok) {
    throw new Error(`${endpoint} returned HTTP ${response.status}`)
  }

  const payload = (await response.json()) as { data?: unknown } | null
  if (!Array.isArray(payload?.data)) {
    throw new Error(`${endpoint} returned an invalid portfolio payload`)
  }

  return payload.data as T[]
}

export default function PortfolioPage() {
  const router = useRouter()
  const push = router.push
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()
  const [loading, setLoading] = useState(true)
  const [authStatus, setAuthStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [token, setToken] = useState<string | null>(null)
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [hasSuccessfulLoad, setHasSuccessfulLoad] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadAuth = useCallback(async () => {
    setAuthStatus('loading')
    const result = await bootstrapClientAuth(supabase.auth)

    if (result.status === 'signed-out') {
      push('/login?redirect=/portfolio')
      return
    }
    if (result.status === 'error' || !result.session?.access_token) {
      setAuthStatus('error')
      return
    }

    setToken(result.session.access_token)
    setAuthStatus('ready')
  }, [push])

  useEffect(() => {
    void loadAuth()
  }, [loadAuth])

  const fetchHeaders = useCallback((): Record<string, string> => {
    if (!token) return { ...getCsrfHeaders() }
    return { Authorization: `Bearer ${token}`, ...getCsrfHeaders() }
  }, [token])

  // Load portfolios + positions in parallel with request dedup
  const lastFetchRef = useRef<number>(0)
  const loadInFlightRef = useRef(false)
  const loadAll = useCallback(
    async (force = false) => {
      if (!token) return
      if (loadInFlightRef.current) return
      // Skip if fetched < 30s ago (dedup rapid remounts)
      if (!force && Date.now() - lastFetchRef.current < 30_000) return
      lastFetchRef.current = Date.now()
      loadInFlightRef.current = true
      setLoading(true)
      const headers = { Authorization: `Bearer ${token}` }
      try {
        const [pRes, posRes, snapRes] = await Promise.all([
          fetch('/api/portfolio', { headers }),
          fetch('/api/portfolio/positions', { headers }),
          fetch('/api/portfolio/snapshots', { headers }),
        ])
        const [nextPortfolios, nextPositions, nextSnapshots] = await Promise.all([
          readListResponse<Portfolio>(pRes, '/api/portfolio'),
          readListResponse<Position>(posRes, '/api/portfolio/positions'),
          readListResponse<Snapshot>(snapRes, '/api/portfolio/snapshots'),
        ])

        // Treat the three endpoints as one snapshot. A partial refresh must not
        // replace last-good data with misleading empty/$0 sections.
        setPortfolios(nextPortfolios)
        setPositions(nextPositions)
        setSnapshots(nextSnapshots)
        setHasSuccessfulLoad(true)
        setLoadFailed(false)
      } catch (error) {
        logger.error('Failed to refresh portfolio:', error)
        setLoadFailed(true)
        showToast(t('portfolioLoadFailed'), 'error')
      } finally {
        loadInFlightRef.current = false
        setLoading(false)
      }
    },
    [showToast, t, token]
  )

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Keep references for sync handler
  const loadPortfolios = loadAll
  const loadPositions = loadAll

  const handleAddExchange = async (data: {
    exchange: string
    api_key: string
    api_secret: string
    api_passphrase?: string
    label: string
  }) => {
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { ...fetchHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const json = await res.json()
      throw new Error(json.error || t('portfolioAddFailed'))
    }
    showToast(t('portfolioConnectSuccess'), 'success')
    await loadPortfolios()
  }

  const handleSync = async (portfolioId: string) => {
    if (!token || syncingId) return
    setSyncingId(portfolioId)
    try {
      const res = await fetch('/api/portfolio/sync', {
        method: 'POST',
        headers: { ...fetchHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolio_id: portfolioId }),
      })
      const json = (await res.json().catch(() => null)) as {
        data?: { synced?: boolean; reason?: string }
      } | null
      const reason = json?.data?.reason
      // Map stable server reason codes → localized copy.
      const reasonKey: Record<string, string> = {
        geo_unavailable: 'portfolioSyncGeoUnavailable',
        passphrase_required: 'portfolioSyncPassphraseRequired',
        unsupported: 'portfolioSyncUnsupported',
        keys_unreadable: 'portfolioSyncKeysUnreadable',
        exchange_error: 'portfolioSyncExchangeError',
      }
      if (!res.ok) {
        showToast(reason ? t(reasonKey[reason]) : t('portfolioSyncFailed'), 'error')
        return
      }
      if (json?.data?.synced === false) {
        // Soft outcome (geo/passphrase/unsupported) — inform, don't error.
        showToast(reason ? t(reasonKey[reason]) : t('portfolioSyncFailed'), 'info')
        return
      }
      await loadPositions()
      showToast(t('portfolioSyncSuccess'), 'success')
    } catch {
      showToast(t('portfolioNetworkError'), 'error')
    } finally {
      setSyncingId(null)
    }
  }

  const handleDelete = async (portfolioId: string) => {
    if (!token || deletingId) return
    const confirmed = await showConfirm(t('portfolioRemoveExchange'), t('portfolioRemoveConfirm'))
    if (!confirmed) return
    setDeletingId(portfolioId)
    try {
      const res = await fetch(`/api/portfolio?id=${portfolioId}`, {
        method: 'DELETE',
        headers: fetchHeaders(),
      })
      if (!res.ok) {
        showToast(t('portfolioRemoveFailed'), 'error')
        return
      }
      await Promise.all([loadPortfolios(), loadPositions()])
      showToast(t('portfolioRemoved'), 'success')
    } catch {
      showToast(t('portfolioNetworkError'), 'error')
    } finally {
      setDeletingId(null)
    }
  }

  // Totals from positions
  const totalPnl = positions.reduce((sum, p) => sum + Number(p.pnl), 0)
  const totalEquity = positions.reduce((sum, p) => sum + Number(p.size) * Number(p.mark_price), 0)
  const totalPnlPct = totalEquity > 0 ? (totalPnl / totalEquity) * 100 : 0
  const isInitialLoad = loading && !hasSuccessfulLoad

  if (authStatus === 'error') {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <PageHeader title={t('portfolioTitle')} compact />
          <ErrorState
            title={t('somethingWentWrong')}
            description={t('loadFailedRetryShort')}
            retry={() => void loadAuth()}
            variant="compact"
          />
        </div>
      </div>
    )
  }

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
                        disabled={!!syncingId}
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
