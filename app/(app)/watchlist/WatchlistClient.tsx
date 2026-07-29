'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import EmptyState from '@/app/components/ui/EmptyState'
import ErrorState from '@/app/components/ui/ErrorState'
import PageHeader from '@/app/components/ui/PageHeader'
import { tokens, alpha } from '@/lib/design-tokens'
import { formatPnL } from '@/lib/utils/format'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useToast } from '@/app/components/ui/Toast'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

interface WatchlistItem {
  source: string
  source_trader_id: string
  handle: string | null
  created_at: string
  roi?: number | null
  pnl?: number | null
  rank?: number | null
  arena_score?: number | null
  win_rate?: number | null
  avatar_url?: string | null
}

type WatchlistPayload = {
  watchlist?: unknown
}

type RemoveOperation = {
  controller: AbortController
  id: number
  source: string
  sourceTraderId: string
  viewer: SettingsViewerSnapshot
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
  )
}

function optionalFiniteNumber(value: unknown): number | null | undefined {
  return value === null
    ? null
    : typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined
}

function readWatchlist(value: WatchlistPayload | null): WatchlistItem[] | null {
  if (!Array.isArray(value?.watchlist)) return null
  const rows: WatchlistItem[] = []
  for (const candidate of value.watchlist) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const row = candidate as Record<string, unknown>
    if (
      typeof row.source !== 'string' ||
      !row.source ||
      typeof row.source_trader_id !== 'string' ||
      !row.source_trader_id ||
      (row.handle !== null && typeof row.handle !== 'string') ||
      typeof row.created_at !== 'string' ||
      !row.created_at ||
      !isOptionalFiniteNumber(row.roi) ||
      !isOptionalFiniteNumber(row.pnl) ||
      !isOptionalFiniteNumber(row.rank) ||
      !isOptionalFiniteNumber(row.arena_score) ||
      !isOptionalFiniteNumber(row.win_rate) ||
      (row.avatar_url !== undefined &&
        row.avatar_url !== null &&
        typeof row.avatar_url !== 'string')
    ) {
      return null
    }
    rows.push({
      source: row.source,
      source_trader_id: row.source_trader_id,
      handle: row.handle,
      created_at: row.created_at,
      roi: optionalFiniteNumber(row.roi),
      pnl: optionalFiniteNumber(row.pnl),
      rank: optionalFiniteNumber(row.rank),
      arena_score: optionalFiniteNumber(row.arena_score),
      win_rate: optionalFiniteNumber(row.win_rate),
      avatar_url:
        row.avatar_url === null
          ? null
          : typeof row.avatar_url === 'string'
            ? row.avatar_url
            : undefined,
    })
  }
  return rows
}

const PLATFORM_LABELS: Record<string, string> = {
  binance: 'Binance',
  binance_futures: 'Binance Futures',
  binance_spot: 'Binance Spot',
  bybit: 'Bybit',
  okx: 'OKX',
  bitget: 'Bitget',
  mexc: 'MEXC',
  kucoin: 'KuCoin',
  htx: 'HTX',
  coinex: 'CoinEx',
  hyperliquid: 'Hyperliquid',
  gmx: 'GMX',
  dydx: 'dYdX',
  drift: 'Drift',
  aevo: 'Aevo',
  gains: 'Gains Network',
  etoro: 'eToro',
  jupiter_perps: 'Jupiter Perps',
  bitfinex: 'Bitfinex',
  toobit: 'Toobit',
}

function formatRoi(roi: number | null | undefined): string {
  if (roi == null) return '--'
  return `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`
}
function formatScore(score: number | null | undefined): string {
  if (score == null) return '--'
  return score.toFixed(1)
}

type SortKey = 'added' | 'roi' | 'pnl' | 'score' | 'rank'

function traderHref(item: WatchlistItem): string {
  return `/trader/${encodeURIComponent(item.handle || item.source_trader_id)}?platform=${item.source}`
}

export default function WatchlistClient({ embedded = false }: { embedded?: boolean } = {}) {
  const auth = useAuthSession()
  const viewer = captureSettingsViewer(auth)
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}`
  return (
    <ViewerScopedWatchlistClient
      key={scopeKey}
      authResolved={auth.authChecked && !auth.loading}
      embedded={embedded}
      viewer={viewer}
    />
  )
}

function ViewerScopedWatchlistClient({
  authResolved,
  embedded,
  viewer,
}: {
  authResolved: boolean
  embedded: boolean
  viewer: SettingsViewerSnapshot | null
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const router = useRouter()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortKey>('added')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  const [isMobile, setIsMobile] = useState(false)
  const mountedRef = useRef(false)
  const nextOperationIdRef = useRef(0)
  const removeOperationRef = useRef<RemoveOperation | null>(null)
  const isAuthenticated = viewer ? true : authResolved ? false : null

  // Responsive: below 640px render cards instead of a wide table. Starts false on
  // server + first client render (no hydration mismatch), then syncs.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      removeOperationRef.current?.controller.abort()
      removeOperationRef.current = null
    }
  }, [])

  // Retryable loader — distinguishes a real fetch/auth failure (ERROR) from a
  // genuinely empty watchlist (EMPTY). Previously a fetch error was swallowed
  // into console.error and looked identical to an empty list.
  const loadWatchlist = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      setError(null)
      if (!viewer) {
        setWatchlist([])
        setLoading(false)
        return
      }
      try {
        const result = await authedFetch<WatchlistPayload>(
          '/api/watchlist',
          'GET',
          viewer.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: viewer.userId,
            expectedSessionGeneration: viewer.sessionGeneration,
            signal,
          }
        )
        if (
          result.stale ||
          signal?.aborted ||
          !mountedRef.current ||
          !isSettingsViewerCurrent(viewer, authRef.current)
        ) {
          return
        }
        if (!result.ok) throw new Error(`Watchlist request failed (${result.status})`)
        const list = readWatchlist(result.data)
        if (!list) throw new Error('Watchlist returned an invalid snapshot')
        setWatchlist(list)
      } catch (err) {
        if (
          signal?.aborted ||
          !mountedRef.current ||
          !isSettingsViewerCurrent(viewer, authRef.current)
        )
          return
        console.error('[watchlist] fetch failed:', err)
        setError(err instanceof Error ? err.message : 'Failed to load watchlist')
      } finally {
        if (
          !signal?.aborted &&
          mountedRef.current &&
          isSettingsViewerCurrent(viewer, authRef.current)
        ) {
          setLoading(false)
        }
      }
    },
    [viewer]
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadWatchlist(controller.signal)
    return () => controller.abort()
  }, [loadWatchlist])

  const handleRemove = useCallback(
    async (source: string, id: string) => {
      if (!viewer || removeOperationRef.current) return
      const operation: RemoveOperation = {
        controller: new AbortController(),
        id: ++nextOperationIdRef.current,
        source,
        sourceTraderId: id,
        viewer,
      }
      removeOperationRef.current = operation
      setRemoving(`${source}:${id}`)
      try {
        const result = await authedFetch<WatchlistPayload>(
          '/api/watchlist',
          'DELETE',
          operation.viewer.accessToken,
          {
            source: operation.source,
            source_trader_id: operation.sourceTraderId,
          },
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        const operationIsCurrent =
          mountedRef.current &&
          removeOperationRef.current?.id === operation.id &&
          isSettingsViewerCurrent(operation.viewer, authRef.current)
        if (result.stale || !operationIsCurrent) return
        if (!result.ok) throw new Error(`Watchlist remove failed (${result.status})`)
        const updated = readWatchlist(result.data)
        if (
          !updated ||
          updated.some(
            (item) =>
              item.source === operation.source && item.source_trader_id === operation.sourceTraderId
          )
        ) {
          throw new Error('Watchlist remove returned an invalid snapshot')
        }

        setWatchlist((prev) =>
          prev.filter(
            (item) =>
              !(
                item.source === operation.source &&
                item.source_trader_id === operation.sourceTraderId
              )
          )
        )
      } catch (err) {
        if (
          !mountedRef.current ||
          removeOperationRef.current?.id !== operation.id ||
          !isSettingsViewerCurrent(operation.viewer, authRef.current)
        ) {
          return
        }
        console.error('[watchlist] remove failed:', err)
        showToast(t('watchlistError'), 'error')
      } finally {
        if (removeOperationRef.current?.id === operation.id) {
          removeOperationRef.current = null
          if (mountedRef.current && isSettingsViewerCurrent(operation.viewer, authRef.current)) {
            setRemoving(null)
          }
        }
      }
    },
    [showToast, t, viewer]
  )

  const platforms = useMemo(
    () => Array.from(new Set(watchlist.map((w) => w.source))).sort(),
    [watchlist]
  )
  const displayList = useMemo(() => {
    const f =
      platformFilter === 'all' ? watchlist : watchlist.filter((w) => w.source === platformFilter)
    return [...f].sort((a, b) => {
      const d = sortDir === 'asc' ? 1 : -1
      switch (sortBy) {
        case 'roi':
          return d * ((a.roi ?? -Infinity) - (b.roi ?? -Infinity))
        case 'pnl':
          return d * ((a.pnl ?? -Infinity) - (b.pnl ?? -Infinity))
        case 'score':
          return d * ((a.arena_score ?? -Infinity) - (b.arena_score ?? -Infinity))
        case 'rank':
          return d * ((a.rank ?? Infinity) - (b.rank ?? Infinity))
        default:
          return d * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      }
    })
  }, [watchlist, platformFilter, sortBy, sortDir])

  const doSort = (col: SortKey) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortBy(col)
      setSortDir(col === 'rank' ? 'asc' : 'desc')
    }
  }
  const sa = (col: SortKey) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '')
  const ariaSort = (col: SortKey): React.AriaAttributes['aria-sort'] =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
  const onSortKeyDown = (col: SortKey) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      doSort(col)
    }
  }

  // Remove control shared by the desktop table and the mobile cards. `stop`
  // prevents the click from bubbling to the row/card navigation.
  const renderRemoveControl = (item: WatchlistItem) => {
    const key = `${item.source}:${item.source_trader_id}`
    const isRemoving = removing === key
    const stop = (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
    }
    if (confirmRemove === key) {
      return (
        <span style={{ display: 'inline-flex', gap: 4 }}>
          <button
            onClick={(e) => {
              stop(e)
              handleRemove(item.source, item.source_trader_id)
              setConfirmRemove(null)
            }}
            style={{
              padding: '4px 8px',
              borderRadius: tokens.radius.sm,
              border: 'none',
              background: 'var(--color-accent-error)',
              color: tokens.colors.white,
              // eslint-disable-next-line no-restricted-syntax -- off-scale micro label by design
              fontSize: 11,
              fontWeight: tokens.typography.fontWeight.semibold,
              cursor: 'pointer',
            }}
          >
            {t('watchlistConfirmYes')}
          </button>
          <button
            onClick={(e) => {
              stop(e)
              setConfirmRemove(null)
            }}
            style={{
              padding: '4px 8px',
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent',
              color: tokens.colors.text.secondary,
              // eslint-disable-next-line no-restricted-syntax -- off-scale micro label by design
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {t('watchlistConfirmNo')}
          </button>
        </span>
      )
    }
    return (
      <button
        onClick={(e) => {
          stop(e)
          setConfirmRemove(key)
        }}
        disabled={isRemoving}
        style={{
          padding: '4px 12px',
          borderRadius: tokens.radius.sm,
          border: '1px solid var(--color-accent-error)',
          background: 'transparent',
          color: 'var(--color-accent-error)',
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.medium,
          cursor: isRemoving ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => {
          if (!isRemoving) e.currentTarget.style.background = alpha('var(--color-accent-error)', 10)
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
        }}
      >
        {t('watchlistRemove')}
      </button>
    )
  }

  return (
    <div
      style={
        embedded
          ? { color: 'var(--color-text-primary)' }
          : {
              minHeight: '100vh',
              background: 'var(--color-bg-primary)',
              color: 'var(--color-text-primary)',
            }
      }
    >
      <div
        style={
          embedded
            ? { maxWidth: 1000, margin: '0 auto', paddingBottom: 60 }
            : { maxWidth: 1000, margin: '0 auto', padding: '24px 16px 60px' }
        }
      >
        {/* Embedded in /saved hub: the hub renders the h1 + tab bar, so suppress
            this page's own PageHeader to avoid stacked duplicate headers. */}
        {!embedded && (
          <PageHeader title={t('watchlistTitle')} subtitle={t('watchlistSubtitle')} compact />
        )}
        {isAuthenticated === false && (
          <EmptyState
            variant="card"
            icon={
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            }
            title={t('watchlistSignInTitle')}
            description={t('watchlistSignInDesc')}
            action={
              <Link
                href={embedded ? '/login?redirect=/saved' : '/login'}
                style={{
                  display: 'inline-block',
                  padding: '10px 24px',
                  background: 'var(--color-accent-primary)',
                  color: 'var(--color-bg-primary)',
                  borderRadius: tokens.radius.md,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  fontSize: tokens.typography.fontSize.base,
                  textDecoration: 'none',
                }}
              >
                {t('login')}
              </Link>
            }
          />
        )}
        {loading && isAuthenticated !== false && <LoadingSkeleton variant="list" count={5} />}
        {!loading && isAuthenticated && error && (
          <ErrorState title={t('failedToLoad')} description={t('tryAgain')} retry={loadWatchlist} />
        )}
        {!loading && isAuthenticated && !error && watchlist.length === 0 && (
          <EmptyState
            variant="card"
            icon={
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
              </svg>
            }
            title={t('watchlistEmptyTitle')}
            description={t('watchlistEmptyDesc')}
            action={
              <Link
                href="/rankings"
                style={{
                  display: 'inline-block',
                  padding: '10px 24px',
                  background: 'var(--color-accent-primary)',
                  color: 'var(--color-bg-primary)',
                  borderRadius: tokens.radius.md,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  fontSize: tokens.typography.fontSize.base,
                  textDecoration: 'none',
                }}
              >
                {t('watchlistBrowseRankings')}
              </Link>
            }
          />
        )}
        {!loading && isAuthenticated && !error && watchlist.length > 0 && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  color:
                    watchlist.length >= 180
                      ? 'var(--color-accent-warning)'
                      : 'var(--color-text-tertiary)',
                }}
              >
                {watchlist.length} / 200 {t('watchlistSaved')}
                {platformFilter !== 'all' ? ` (${displayList.length} ${t('watchlistShown')})` : ''}
              </div>
              {platforms.length > 1 && (
                <select
                  value={platformFilter}
                  onChange={(e) => setPlatformFilter(e.target.value)}
                  aria-label={t('watchlistAllPlatforms')}
                  style={{
                    padding: '6px 10px',
                    borderRadius: tokens.radius.sm,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.xs,
                    cursor: 'pointer',
                  }}
                >
                  <option value="all">{t('watchlistAllPlatforms')}</option>
                  {platforms.map((p) => (
                    <option key={p} value={p}>
                      {PLATFORM_LABELS[p] || p}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {isMobile && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {displayList.map((item) => {
                  const key = `${item.source}:${item.source_trader_id}`
                  const isRemoving = removing === key
                  const roiColor =
                    item.roi != null
                      ? item.roi >= 0
                        ? 'var(--color-sentiment-bull)'
                        : 'var(--color-sentiment-bear)'
                      : 'var(--color-text-tertiary)'
                  return (
                    <Link
                      key={key}
                      href={traderHref(item)}
                      style={{
                        display: 'block',
                        textDecoration: 'none',
                        color: 'inherit',
                        border: '1px solid var(--color-border-secondary)',
                        borderRadius: tokens.radius.lg,
                        background: tokens.colors.bg.secondary,
                        padding: 14,
                        opacity: isRemoving ? 0.5 : 1,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          justifyContent: 'space-between',
                          gap: 8,
                          marginBottom: 10,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: tokens.typography.fontWeight.semibold,
                              color: 'var(--color-text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {item.handle || item.source_trader_id}
                          </div>
                          <div
                            style={{
                              fontSize: tokens.typography.fontSize.xs,
                              color: 'var(--color-text-secondary)',
                              marginTop: 2,
                            }}
                          >
                            {PLATFORM_LABELS[item.source] || item.source}
                            {item.rank != null ? ` · #${item.rank}` : ''}
                          </div>
                        </div>
                        {renderRemoveControl(item)}
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, 1fr)',
                          gap: 8,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        <div>
                          <div style={mobileStatLabel}>{t('roi')}</div>
                          <div
                            style={{
                              color: roiColor,
                              fontWeight: tokens.typography.fontWeight.semibold,
                            }}
                          >
                            {formatRoi(item.roi)}
                          </div>
                        </div>
                        <div>
                          <div style={mobileStatLabel}>{t('pnl')}</div>
                          <div style={{ color: 'var(--color-text-secondary)' }}>
                            {item.pnl != null ? formatPnL(item.pnl) : '--'}
                          </div>
                        </div>
                        <div>
                          <div style={mobileStatLabel}>{t('score')}</div>
                          <div
                            style={{
                              color: 'var(--color-text-primary)',
                              fontWeight: tokens.typography.fontWeight.semibold,
                            }}
                          >
                            {formatScore(item.arena_score)}
                          </div>
                        </div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
            {!isMobile && (
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: tokens.typography.fontSize.base,
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: `1px solid var(--color-border-primary)` }}>
                      <th scope="col" style={thStyle}>
                        {t('trader')}
                      </th>
                      <th scope="col" style={thStyle}>
                        {t('exchange')}
                      </th>
                      <th
                        scope="col"
                        aria-sort={ariaSort('roi')}
                        tabIndex={0}
                        style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }}
                        onClick={() => doSort('roi')}
                        onKeyDown={onSortKeyDown('roi')}
                      >
                        {t('roi')}
                        {sa('roi')}
                      </th>
                      <th
                        scope="col"
                        aria-sort={ariaSort('pnl')}
                        tabIndex={0}
                        style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }}
                        onClick={() => doSort('pnl')}
                        onKeyDown={onSortKeyDown('pnl')}
                      >
                        {t('pnl')}
                        {sa('pnl')}
                      </th>
                      <th
                        scope="col"
                        aria-sort={ariaSort('rank')}
                        tabIndex={0}
                        style={{ ...thStyle, textAlign: 'center', cursor: 'pointer' }}
                        onClick={() => doSort('rank')}
                        onKeyDown={onSortKeyDown('rank')}
                      >
                        {t('rank')}
                        {sa('rank')}
                      </th>
                      <th
                        scope="col"
                        aria-sort={ariaSort('score')}
                        tabIndex={0}
                        style={{ ...thStyle, textAlign: 'right', cursor: 'pointer' }}
                        onClick={() => doSort('score')}
                        onKeyDown={onSortKeyDown('score')}
                      >
                        {t('score')}
                        {sa('score')}
                      </th>
                      <th scope="col" style={{ ...thStyle, textAlign: 'center', width: 100 }}>
                        {t('watchlistActions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayList.map((item) => {
                      const key = `${item.source}:${item.source_trader_id}`
                      const isRemoving = removing === key
                      const roiColor =
                        item.roi != null
                          ? item.roi >= 0
                            ? 'var(--color-sentiment-bull)'
                            : 'var(--color-sentiment-bear)'
                          : 'var(--color-text-tertiary)'
                      return (
                        <tr
                          key={key}
                          style={{
                            borderBottom: '1px solid var(--color-border-secondary)',
                            transition: 'background 0.15s',
                            opacity: isRemoving ? 0.5 : 1,
                            cursor: 'pointer',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--color-bg-hover)'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent'
                          }}
                          onClick={() => {
                            router.push(traderHref(item))
                          }}
                        >
                          <td style={{ padding: '12px 16px' }}>
                            <Link
                              href={traderHref(item)}
                              style={{
                                color: 'var(--color-text-primary)',
                                fontWeight: tokens.typography.fontWeight.semibold,
                                textDecoration: 'none',
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {item.handle || item.source_trader_id}
                            </Link>
                          </td>
                          <td
                            style={{ padding: '12px 16px', color: 'var(--color-text-secondary)' }}
                          >
                            {PLATFORM_LABELS[item.source] || item.source}
                          </td>
                          <td
                            style={{
                              padding: '12px 16px',
                              textAlign: 'right',
                              color: roiColor,
                              fontWeight: tokens.typography.fontWeight.semibold,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {formatRoi(item.roi)}
                          </td>
                          <td
                            style={{
                              padding: '12px 16px',
                              textAlign: 'right',
                              color: 'var(--color-text-secondary)',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {item.pnl != null ? formatPnL(item.pnl) : '--'}
                          </td>
                          <td
                            style={{
                              padding: '12px 16px',
                              textAlign: 'center',
                              color: 'var(--color-text-secondary)',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {item.rank != null ? `#${item.rank}` : '--'}
                          </td>
                          <td
                            style={{
                              padding: '12px 16px',
                              textAlign: 'right',
                              color: 'var(--color-text-primary)',
                              fontWeight: tokens.typography.fontWeight.semibold,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {formatScore(item.arena_score)}
                          </td>
                          <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                            {renderRemoveControl(item)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
      {/* FAB is a page-level widget; when embedded the hub page owns layout —
          suppress to avoid a duplicate/overlapping FAB. */}
      {!embedded && <FloatingActionButton />}
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '12px 16px',
  textAlign: 'left',
  fontWeight: tokens.typography.fontWeight.semibold,
  color: 'var(--color-text-secondary)',
  fontSize: tokens.typography.fontSize.xs,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
}

const mobileStatLabel: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.xs,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 2,
}
