'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'

interface WatchlistItem {
  source: string
  source_trader_id: string
  handle: string | null
  created_at: string
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
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px 60px' }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: '-0.5px' }}>
            Watchlist
          </h1>
          <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginTop: 6 }}>
            Your saved traders. Track performance and get notified of significant changes.
          </p>
        </div>

        {/* Auth gate */}
        {isAuthenticated === false && (
          <div style={{
            padding: '60px 20px',
            textAlign: 'center',
            background: tokens.glass.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: tokens.glass.border.light,
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, marginBottom: 16 }}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>
              Sign in to view your watchlist
            </h2>
            <p style={{ fontSize: 14, color: tokens.colors.text.secondary, margin: '0 0 20px' }}>
              Create an account or log in to save and track your favorite traders.
            </p>
            <Link
              href="/auth/login"
              style={{
                display: 'inline-block',
                padding: '10px 24px',
                background: 'var(--color-accent-primary)',
                color: '#fff',
                borderRadius: tokens.radius.md,
                fontWeight: 600,
                fontSize: 14,
                textDecoration: 'none',
              }}
            >
              Sign In
            </Link>
          </div>
        )}

        {/* Loading */}
        {loading && isAuthenticated !== false && (
          <LoadingSkeleton variant="list" count={5} />
        )}

        {/* Empty watchlist */}
        {!loading && isAuthenticated && watchlist.length === 0 && (
          <div style={{
            padding: '60px 20px',
            textAlign: 'center',
            background: tokens.glass.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: tokens.glass.border.light,
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, marginBottom: 16 }}>
              <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
            </svg>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>
              Your watchlist is empty
            </h2>
            <p style={{ fontSize: 14, color: tokens.colors.text.secondary, margin: '0 0 20px' }}>
              Browse the rankings and save traders you want to track.
            </p>
            <Link
              href="/rankings"
              style={{
                display: 'inline-block',
                padding: '10px 24px',
                background: 'var(--color-accent-primary)',
                color: '#fff',
                borderRadius: tokens.radius.md,
                fontWeight: 600,
                fontSize: 14,
                textDecoration: 'none',
              }}
            >
              Browse Rankings
            </Link>
          </div>
        )}

        {/* Watchlist table */}
        {!loading && isAuthenticated && watchlist.length > 0 && (
          <>
            <div style={{
              fontSize: 13,
              color: tokens.colors.text.tertiary,
              marginBottom: 12,
            }}>
              {watchlist.length} trader{watchlist.length !== 1 ? 's' : ''} saved
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                    <th style={thStyle}>Trader</th>
                    <th style={thStyle}>Exchange</th>
                    <th style={thStyle}>Added</th>
                    <th style={{ ...thStyle, textAlign: 'center', width: 80 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {watchlist.map(item => {
                    const key = `${item.source}:${item.source_trader_id}`
                    const isRemoving = removing === key

                    return (
                      <tr
                        key={key}
                        style={{
                          borderBottom: `1px solid ${tokens.colors.border.secondary}`,
                          transition: 'background 0.15s',
                          opacity: isRemoving ? 0.5 : 1,
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.hover)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <td style={{ padding: '12px 16px' }}>
                          <Link
                            href={`/trader/${item.source}/${item.source_trader_id}`}
                            style={{
                              color: tokens.colors.text.primary,
                              fontWeight: 600,
                              textDecoration: 'none',
                            }}
                          >
                            {item.handle || item.source_trader_id}
                          </Link>
                        </td>
                        <td style={{ padding: '12px 16px', color: tokens.colors.text.secondary }}>
                          {PLATFORM_LABELS[item.source] || item.source}
                        </td>
                        <td style={{ padding: '12px 16px', color: tokens.colors.text.tertiary, fontSize: 13 }}>
                          {new Date(item.created_at).toLocaleDateString()}
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                          <button
                            onClick={() => handleRemove(item.source, item.source_trader_id)}
                            disabled={isRemoving}
                            style={{
                              padding: '4px 12px',
                              borderRadius: tokens.radius.sm,
                              border: `1px solid ${tokens.colors.accent.error}`,
                              background: 'transparent',
                              color: tokens.colors.accent.error,
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
