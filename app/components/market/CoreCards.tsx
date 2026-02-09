'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import Link from 'next/link'

interface CoinRow {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

interface ExchangeInfo {
  id: string
  name: string
  trade_volume_24h_btc: number
}

interface TopTrader {
  handle: string
  display_name: string
  avatar_url: string | null
  pnl_pct: number
}

function CardWrapper({ title, linkText, linkHref, children }: {
  title: string
  linkText: string
  linkHref: string
  children: React.ReactNode
}) {
  return (
    <div style={{
      flex: '1 1 0',
      minWidth: 220,
      minHeight: 200,
      padding: '16px',
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.lg,
      border: tokens.glass.border.light,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
      }}>
        <span style={{
          fontSize: 14,
          fontWeight: 600,
          color: tokens.colors.text.primary,
        }}>
          {title}
        </span>
        <Link
          href={linkHref}
          style={{
            fontSize: 12,
            color: tokens.colors.accent.primary,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
          }}
        >
          {linkText}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </Link>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

function CoinItem({ symbol, price, changePct, isGainer }: {
  symbol: string
  price: string
  changePct: string
  isGainer: boolean
}) {
  const sym = symbol.replace('-USD', '').replace('USDT', '')
  const color = isGainer ? tokens.colors.accent.success : tokens.colors.accent.error
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '4px 0',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        <CryptoIcon symbol={sym} size={18} />
        <span style={{ fontWeight: 500, color: tokens.colors.text.primary }}>{sym}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span style={{ color: tokens.colors.text.secondary, fontFamily: 'var(--font-mono, monospace)' }}>{price}</span>
        <span style={{
          color,
          fontWeight: 600,
          minWidth: 60,
          textAlign: 'right',
        }}>
          {changePct}
        </span>
      </span>
    </div>
  )
}

function formatBTC(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M BTC`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K BTC`
  return `${value.toFixed(0)} BTC`
}

export default function CoreCards() {
  const [loading, setLoading] = useState(true)
  const [gainers, setGainers] = useState<CoinRow[]>([])
  const [losers, setLosers] = useState<CoinRow[]>([])
  const [exchanges, setExchanges] = useState<ExchangeInfo[]>([])
  const [traders, setTraders] = useState<TopTrader[]>([])

  useEffect(() => {
    // Fetch market data for gainers/losers
    fetch('/api/market')
      .then(r => r.json())
      .then(json => {
        const rows: CoinRow[] = json.rows ?? []
        const sorted = [...rows].sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct))
        setGainers(sorted.filter(r => r.direction === 'up').slice(0, 5))
        setLosers(sorted.filter(r => r.direction === 'down').slice(-5).reverse())
      })
      .catch(() => {})

    // Fetch exchange volume
    fetch('/api/market/exchanges')
      .then(r => r.json())
      .then(json => { if (Array.isArray(json)) setExchanges(json.slice(0, 5)) })
      .catch(() => {})

    // Fetch top traders
    fetch('/api/rankings?limit=3')
      .then(r => r.json())
      .then(json => {
        if (Array.isArray(json?.rankings)) {
          setTraders(json.rankings.slice(0, 3).map((t: any) => ({
            handle: t.handle || t.username || '',
            display_name: t.display_name || t.handle || '',
            avatar_url: t.avatar_url || null,
            pnl_pct: t.pnl_pct ?? t.roi ?? 0,
          })))
        }
      })
      .catch(() => {
        setTraders([
          { handle: 'whale_hunter', display_name: 'WhaleHunter', avatar_url: null, pnl_pct: 342.5 },
          { handle: 'crypto_sage', display_name: 'CryptoSage', avatar_url: null, pnl_pct: 218.3 },
          { handle: 'alpha_seeker', display_name: 'AlphaSeeker', avatar_url: null, pnl_pct: 156.7 },
        ])
      })
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      overflowX: 'auto',
      scrollbarWidth: 'none',
      padding: '0 0 4px 0',
    }}>
      {/* Gainers Top 5 */}
      <CardWrapper title="涨幅榜 Top5" linkText="查看全部" linkHref="/market?tab=gainers">
        {gainers.length === 0 ? (
          <div style={{ height: 120 }} className="skeleton" />
        ) : (
          gainers.map(row => (
            <CoinItem key={row.symbol} symbol={row.symbol} price={row.price} changePct={row.changePct} isGainer={true} />
          ))
        )}
      </CardWrapper>

      {/* Losers Top 5 */}
      <CardWrapper title="跌幅榜 Top5" linkText="查看全部" linkHref="/market?tab=losers">
        {losers.length === 0 ? (
          <div style={{ height: 120 }} className="skeleton" />
        ) : (
          losers.map(row => (
            <CoinItem key={row.symbol} symbol={row.symbol} price={row.price} changePct={row.changePct} isGainer={false} />
          ))
        )}
      </CardWrapper>

      {/* Exchange Volume / Fund Flow */}
      <CardWrapper title="资金流向" linkText="查看全部" linkHref="/market?tab=flow">
        {exchanges.length === 0 ? (
          <div style={{ height: 120 }} className="skeleton" />
        ) : (
          exchanges.map(ex => (
            <div key={ex.id} style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '4px 0',
              fontSize: 13,
            }}>
              <span style={{ fontWeight: 500, color: tokens.colors.text.primary }}>{ex.name}</span>
              <span style={{ color: tokens.colors.text.secondary, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
                {formatBTC(ex.trade_volume_24h_btc)}
              </span>
            </div>
          ))
        )}
      </CardWrapper>

      {/* Arena Hot Traders */}
      <CardWrapper title="Arena热门交易员" linkText="查看全部" linkHref="/rankings">
        {traders.length === 0 ? (
          <div style={{ height: 120 }} className="skeleton" />
        ) : (
          traders.map((trader, i) => (
            <Link
              key={trader.handle}
              href={`/trader/${trader.handle}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
                textDecoration: 'none',
              }}
            >
              {/* Rank number */}
              <span style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                background: i === 0 ? 'rgba(255, 215, 0, 0.2)' : i === 1 ? 'rgba(192, 192, 192, 0.2)' : 'rgba(205, 127, 50, 0.2)',
                color: i === 0 ? 'var(--color-medal-gold)' : i === 1 ? 'var(--color-medal-silver)' : 'var(--color-medal-bronze)',
                flexShrink: 0,
              }}>
                {i + 1}
              </span>
              {/* Avatar */}
              <div style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: tokens.colors.bg.tertiary,
                overflow: 'hidden',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {trader.avatar_url ? (
                  <img src={trader.avatar_url} alt="" width={28} height={28} loading="lazy" style={{ borderRadius: '50%' }} />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M20 21a8 8 0 10-16 0" />
                  </svg>
                )}
              </div>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {trader.display_name}
              </span>
              <span style={{
                fontSize: 12,
                fontWeight: 700,
                color: trader.pnl_pct >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
              }}>
                {trader.pnl_pct >= 0 ? '+' : ''}{trader.pnl_pct.toFixed(1)}%
              </span>
            </Link>
          ))
        )}
      </CardWrapper>
    </div>
  )
}
