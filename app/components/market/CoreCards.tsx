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

function CardWrapper({ title, linkText, linkHref, accentColor, children }: {
  title: string
  linkText?: string
  linkHref?: string
  accentColor?: string
  children: React.ReactNode
}) {
  return (
    <div style={{
      flex: '1 1 0',
      minWidth: 0,
      minHeight: 220,
      padding: 0,
      background: tokens.glass.bg.medium,
      backdropFilter: tokens.glass.blur.lg,
      borderRadius: tokens.radius.xl,
      border: tokens.glass.border.light,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      position: 'relative',
      transition: `all ${tokens.transition.base}`,
    }}>
      {/* Subtle top accent line */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        background: accentColor || tokens.gradient.purple,
        opacity: 0.6,
      }} />
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: `${tokens.spacing[4]} ${tokens.spacing[5]} ${tokens.spacing[2]}`,
      }}>
        <span style={{
          fontSize: tokens.typography.fontSize.base,
          fontWeight: 700,
          color: tokens.colors.text.primary,
          letterSpacing: '0.3px',
        }}>
          {title}
        </span>
        {linkText && linkHref && (
          <Link
            href={linkHref}
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.accent.primary,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.sm,
              transition: `all ${tokens.transition.fast}`,
            }}
          >
            {linkText}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </Link>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', padding: `0 ${tokens.spacing[5]} ${tokens.spacing[4]}` }}>
        {children}
      </div>
    </div>
  )
}

function CoinItem({ symbol, price, changePct, isGainer, index }: {
  symbol: string
  price: string
  changePct: string
  isGainer: boolean
  index: number
}) {
  const sym = symbol.replace('-USD', '').replace('USDT', '')
  const color = isGainer ? tokens.colors.accent.success : tokens.colors.accent.error
  const bgGradient = isGainer
    ? 'linear-gradient(90deg, var(--color-accent-success-05) 0%, transparent 100%)'
    : 'linear-gradient(90deg, var(--color-accent-error-04) 0%, transparent 100%)'
  // Format price with appropriate precision
  const formattedPrice = (() => {
    const num = parseFloat(price.replace(/[$,]/g, ''))
    if (isNaN(num)) return price
    if (num >= 1000) return `$${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    if (num >= 1) return `$${num.toFixed(2)}`
    return `$${num.toFixed(4)}`
  })()

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
      borderRadius: tokens.radius.md,
      background: index % 2 === 0 ? bgGradient : 'transparent',
      transition: `background ${tokens.transition.fast}`,
      minHeight: 40,
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{
          width: 20,
          height: 20,
          borderRadius: tokens.radius.sm,
          background: tokens.colors.bg.tertiary,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          color: tokens.colors.text.tertiary,
          flexShrink: 0,
        }}>
          {index + 1}
        </span>
        <CryptoIcon symbol={sym} size={20} />
        <span style={{ fontWeight: 600, color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.sm }}>{sym}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
        <span style={{
          color: tokens.colors.text.secondary,
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: tokens.typography.fontSize.sm,
          tabularNums: true,
          fontVariantNumeric: 'tabular-nums',
        } as React.CSSProperties}>
          {formattedPrice}
        </span>
        <span style={{
          color,
          fontWeight: 700,
          fontSize: tokens.typography.fontSize.sm,
          minWidth: 68,
          textAlign: 'right',
          padding: `3px ${tokens.spacing[2]}`,
          borderRadius: tokens.radius.sm,
          background: isGainer ? 'var(--color-accent-success-10)' : 'var(--color-accent-error-10)',
          fontFamily: 'var(--font-mono, monospace)',
          fontVariantNumeric: 'tabular-nums',
        } as React.CSSProperties}>
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

function VolumeBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <div style={{
      width: 80,
      height: 6,
      background: tokens.colors.bg.tertiary,
      borderRadius: tokens.radius.full,
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${pct}%`,
        height: '100%',
        background: tokens.gradient.purple,
        borderRadius: tokens.radius.full,
        transition: `width ${tokens.transition.slow}`,
      }} />
    </div>
  )
}

export default function CoreCards() {
  const [gainers, setGainers] = useState<CoinRow[]>([])
  const [losers, setLosers] = useState<CoinRow[]>([])
  const [exchanges, setExchanges] = useState<ExchangeInfo[]>([])

  useEffect(() => {
    fetch('/api/market')
      .then(r => r.json())
      .then(json => {
        const rows: CoinRow[] = json.rows ?? []
        const sorted = [...rows].sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct))
        setGainers(sorted.filter(r => r.direction === 'up').slice(0, 5))
        setLosers(sorted.filter(r => r.direction === 'down').slice(-5).reverse())
      })
      .catch(() => {})

    fetch('/api/market/exchanges')
      .then(r => r.json())
      .then(json => { if (Array.isArray(json)) setExchanges(json.slice(0, 5)) })
      .catch(() => {})
  }, [])

  const maxVol = exchanges.length > 0 ? Math.max(...exchanges.map(e => e.trade_volume_24h_btc)) : 0

  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
      gap: tokens.spacing[4],
      overflowX: 'hidden',
    }}>
      {/* Gainers Top 5 */}
      <CardWrapper title="涨幅榜 Top5" accentColor={tokens.gradient.success}>
        {gainers.length === 0 ? (
          <div style={{ height: 160 }} className="skeleton" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {gainers.map((row, i) => (
              <CoinItem key={row.symbol} symbol={row.symbol} price={row.price} changePct={row.changePct} isGainer={true} index={i} />
            ))}
          </div>
        )}
      </CardWrapper>

      {/* Losers Top 5 */}
      <CardWrapper title="跌幅榜 Top5" accentColor={tokens.gradient.error}>
        {losers.length === 0 ? (
          <div style={{ height: 160 }} className="skeleton" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {losers.map((row, i) => (
              <CoinItem key={row.symbol} symbol={row.symbol} price={row.price} changePct={row.changePct} isGainer={false} index={i} />
            ))}
          </div>
        )}
      </CardWrapper>

      {/* Exchange Volume / Fund Flow */}
      <CardWrapper title="资金流向" accentColor={tokens.gradient.purple}>
        {exchanges.length === 0 ? (
          <div style={{ height: 160 }} className="skeleton" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {exchanges.map((ex, i) => (
              <div key={ex.id} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                background: i % 2 === 0 ? tokens.glass.bg.light : 'transparent',
                minHeight: 40,
              }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{
                    width: 20,
                    height: 20,
                    borderRadius: tokens.radius.sm,
                    background: tokens.colors.bg.tertiary,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    fontWeight: 700,
                    color: tokens.colors.text.tertiary,
                    flexShrink: 0,
                  }}>
                    {i + 1}
                  </span>
                  <span style={{ fontWeight: 600, color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.sm }}>{ex.name}</span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <VolumeBar value={ex.trade_volume_24h_btc} max={maxVol} />
                  <span style={{
                    color: tokens.colors.text.secondary,
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: tokens.typography.fontSize.xs,
                    fontVariantNumeric: 'tabular-nums',
                    minWidth: 76,
                    textAlign: 'right',
                  } as React.CSSProperties}>
                    {formatBTC(ex.trade_volume_24h_btc)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </CardWrapper>
    </div>
  )
}
