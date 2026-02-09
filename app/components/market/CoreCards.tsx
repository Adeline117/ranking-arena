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

// TopTrader interface removed - trader card removed from market page

function CardWrapper({ title, linkText, linkHref, children }: {
  title: string
  linkText: string
  linkHref: string
  children: React.ReactNode
}) {
  return (
    <div style={{
      flex: '1 1 0',
      minWidth: 0,
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

    setLoading(false)
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

    </div>
  )
}
