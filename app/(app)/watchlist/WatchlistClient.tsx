'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import EmptyState from '@/app/components/ui/EmptyState'
import ErrorState from '@/app/components/ui/ErrorState'
import PageHeader from '@/app/components/ui/PageHeader'
import { tokens, alpha } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { formatPnL } from '@/lib/utils/format'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'

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
  const { t } = useLanguage()
  const { showToast } = useToast()
  const router = useRouter()
  const [, setEmail] = useState<string | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortKey>('added')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  const [isMobile, setIsMobile] = useState(false)

  // Responsive: below 640px render cards instead of a wide table. Starts false on
  // server + first client render (no hydration mismatch), then syncs.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Retryable loader — distinguishes a real fetch/auth failure (ERROR) from a
  // genuinely empty watchlist (EMPTY). Previously a fetch error was swallowed
  // into console.error and looked identical to an empty list.
  const loadWatchlist = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser()
      if (userErr) throw new Error(userErr.message)
      if (!user) {
        setIsAuthenticated(false)
        setLoading(false)
        return
      }
      setIsAuthenticated(true)
      setEmail(user.email ?? null)
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) {
        // Authenticated but no usable session token → treat as a real error, not empty.
        throw new Error('Session expired — please sign in again')
      }
      const res = await fetch('/api/watchlist', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) {
        throw new Error(`Watchlist request failed (${res.status})`)
      }
      const json = await res.json()
      setWatchlist(json.watchlist || [])
    } catch (err) {
      // Logged out: supabase.auth.getUser() THROWS AuthSessionMissingError
      // (it does not resolve to {user:null}). That's not a failure — render the
      // sign-in gate instead of logging an error + leaving the tab blank (the
      // login-gate and error branches are both gated on isAuthenticated, so a
      // null state renders nothing). Fixes /saved?tab=traders + /watchlist when
      // signed out.
      const msg = err instanceof Error ? err.message : ''
      if (/Auth session missing/i.test(msg)) {
        setIsAuthenticated(false)
        setLoading(false)
        return
      }
      console.error('[watchlist] fetch failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to load watchlist')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadWatchlist()
  }, [loadWatchlist])

  const handleRemove = useCallback(
    async (source: string, id: string) => {
      setRemoving(`${source}:${id}`)
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (!session) throw new Error('Watchlist session is unavailable')

        const res = await fetch('/api/watchlist', {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ source, source_trader_id: id }),
        })
        if (!res.ok) throw new Error(`Watchlist remove failed (${res.status})`)

        setWatchlist((prev) =>
          prev.filter((w) => !(w.source === source && w.source_trader_id === id))
        )
      } catch (err) {
        console.error('[watchlist] remove failed:', err)
        showToast(t('watchlistError'), 'error')
      } finally {
        setRemoving(null)
      }
    },
    [showToast, t]
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
