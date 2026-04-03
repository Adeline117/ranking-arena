'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import EmptyState from '@/app/components/ui/EmptyState'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { formatPnL } from '@/lib/utils/format'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'

interface WatchlistItem {
  source: string
  source_trader_id: string
  handle: string | null
  created_at: string
  // Enriched fields from leaderboard_ranks
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
  vertex: 'Vertex',
  drift: 'Drift',
  aevo: 'Aevo',
  gains: 'Gains Network',
}

function formatRoi(roi: number | null | undefined): string {
  if (roi == null) return '--'
  const sign = roi >= 0 ? '+' : ''
  return `${sign}${roi.toFixed(2)}%`
}

function formatScore(score: number | null | undefined): string {
  if (score == null) return '--'
  return score.toFixed(1)
}

export default function WatchlistClient() {
  const [email, setEmail] = useState<string | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [removing, setRemoving] = useState<string | null>(null)

  // Check auth and fetch watchlist
  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setIsAuthenticated(false)
        setLoading(false)
        return
      }
      setIsAuthenticated(true)
      setEmail(user.email ?? null)

      // Fetch watchlist via session token
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setLoading(false)
        return
      }

      try {
        const res = await fetch('/api/watchlist', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (res.ok) {
          const json = await res.json()
          setWatchlist(json.watchlist || [])
        }
      } catch (err) {
        console.error('[watchlist] fetch failed:', err)
      }
      setLoading(false)
    }
    init()
  }, [])

  const handleRemove = useCallback(async (source: string, sourceTraderI: string) => {
    const key = `${source}:${sourceTraderI}`
    setRemoving(key)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const res = await fetch('/api/watchlist', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source, source_trader_id: sourceTraderI }),
      })

      if (res.ok) {
        setWatchlist(prev => prev.filter(
          w => !(w.source === source && w.source_trader_id === sourceTraderI)
        ))
      }
    } catch (err) {
      console.error('[watchlist] remove failed:', err)
    } finally {
      setRemoving(null)
    }
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
      <TopNav email={email} />

      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px 60px' }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: '-0.5px' }}>
            Watchlist
          </h1>
          <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', marginTop: 6 }}>
            Your saved traders. Track performance and get notified of significant changes.
          </p>
        </div>

        {/* Auth gate */}
        {isAuthenticated === false && (
          <EmptyState
            variant="card"
            icon={
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            }
            title="Sign in to view your watchlist"
            description="Create an account or log in to save and track your favorite traders."
            action={
              <Link
                href="/auth/login"
                style={{
                  display: 'inline-block',
                  padding: '10px 24px',
                  background: 'var(--color-accent-primary)',
                  color: 'var(--color-bg-primary)',
                  borderRadius: tokens.radius.md,
                  fontWeight: 600,
                  fontSize: 14,
                  textDecoration: 'none',
                }}
              >
                Sign In
              </Link>
            }
          />
        )}

        {/* Loading */}
        {loading && isAuthenticated !== false && (
          <LoadingSkeleton variant="list" count={5} />
        )}

        {/* Empty watchlist */}
        {!loading && isAuthenticated && watchlist.length === 0 && (
          <EmptyState
            variant="card"
            icon={
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
              </svg>
            }
            title="Your watchlist is empty"
            description="Browse the rankings and save traders you want to track."
            action={
              <Link
                href="/rankings"
                style={{
                  display: 'inline-block',
                  padding: '10px 24px',
                  background: 'var(--color-accent-primary)',
                  color: 'var(--color-bg-primary)',
                  borderRadius: tokens.radius.md,
                  fontWeight: 600,
                  fontSize: 14,
                  textDecoration: 'none',
                }}
              >
                Browse Rankings
              </Link>
            }
          />
        )}

        {/* Watchlist table */}
        {!loading && isAuthenticated && watchlist.length > 0 && (
          <>
            <div style={{
              fontSize: 13,
              color: 'var(--color-text-tertiary)',
              marginBottom: 12,
            }}>
              {watchlist.length} trader{watchlist.length !== 1 ? 's' : ''} saved
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid var(--color-border-primary)` }}>
                    <th style={thStyle}>Trader</th>
                    <th style={thStyle}>Exchange</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>ROI</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>PnL</th>
                    <th style={{ ...thStyle, textAlign: 'center' }}>Rank</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Arena Score</th>
                    <th style={{ ...thStyle, textAlign: 'center', width: 80 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {watchlist.map(item => {
                    const key = `${item.source}:${item.source_trader_id}`
                    const isRemoving = removing === key
                    const roiColor = item.roi != null
                      ? item.roi >= 0 ? 'var(--color-sentiment-bull)' : 'var(--color-sentiment-bear)'
                      : 'var(--color-text-tertiary)'

                    return (
                      <tr
                        key={key}
                        style={{
                          borderBottom: `1px solid var(--color-border-secondary)`,
                          transition: 'background 0.15s',
                          opacity: isRemoving ? 0.5 : 1,
                          cursor: 'pointer',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-bg-hover)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        onClick={() => {
                          window.location.href = `/trader/${encodeURIComponent(item.handle || item.source_trader_id)}?platform=${item.source}`
                        }}
                      >
                        <td style={{ padding: '12px 16px' }}>
                          <Link
                            href={`/trader/${encodeURIComponent(item.handle || item.source_trader_id)}?platform=${item.source}`}
                            style={{
                              color: 'var(--color-text-primary)',
                              fontWeight: 600,
                              textDecoration: 'none',
                            }}
                            onClick={e => e.stopPropagation()}
                          >
                            {item.handle || item.source_trader_id}
                          </Link>
                        </td>
                        <td style={{ padding: '12px 16px', color: 'var(--color-text-secondary)' }}>
                          {PLATFORM_LABELS[item.source] || item.source}
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', color: roiColor, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                          {formatRoi(item.roi)}
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                          {item.pnl != null ? formatPnL(item.pnl) : '--'}
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                          {item.rank != null ? `#${item.rank}` : '--'}
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', color: 'var(--color-text-primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                          {formatScore(item.arena_score)}
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRemove(item.source, item.source_trader_id)
                            }}
                            disabled={isRemoving}
                            style={{
                              padding: '4px 12px',
                              borderRadius: tokens.radius.sm,
                              border: `1px solid var(--color-accent-error)`,
                              background: 'transparent',
                              color: 'var(--color-accent-error)',
                              fontSize: 12,
                              fontWeight: 500,
                              cursor: isRemoving ? 'not-allowed' : 'pointer',
                              transition: 'background 0.15s',
                            }}
                            onMouseEnter={e => {
                              if (!isRemoving) e.currentTarget.style.background = 'rgba(255,59,48,0.1)'
                            }}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <FloatingActionButton />
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '12px 16px',
  textAlign: 'left',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
}
