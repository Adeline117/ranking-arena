'use client'

import { useEffect, useState, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import Link from 'next/link'
import { apiFetch } from '@/lib/utils/api-fetch'
import type { SpotCoin } from '@/lib/hooks/useMarketSpot'

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
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        background: accentColor || tokens.gradient.purple,
        opacity: 0.6,
      }} />
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: `${tokens.spacing[4]} ${tokens.spacing[5]} ${tokens.spacing[3]}`,
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
          <Link href={linkHref} style={{
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.accent.primary,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            borderRadius: tokens.radius.sm,
            transition: `all ${tokens.transition.fast}`,
          }}>
            {linkText}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
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
  symbol: string; price: string; changePct: string; isGainer: boolean; index: number
}) {
  const sym = symbol.replace('-USD', '').replace('USDT', '')
  const color = isGainer ? tokens.colors.accent.success : tokens.colors.accent.error
  const bgGradient = isGainer
    ? 'linear-gradient(90deg, var(--color-accent-success-05) 0%, transparent 100%)'
    : 'linear-gradient(90deg, var(--color-accent-error-04) 0%, transparent 100%)'
  const formattedPrice = (() => {
    const num = parseFloat(price.replace(/[$,]/g, ''))
    if (isNaN(num)) return price
    if (num >= 1000) return `$${num.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    if (num >= 1) return `$${num.toFixed(2)}`
    return `$${num.toFixed(4)}`
  })()
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.md, background: index % 2 === 0 ? bgGradient : 'transparent', transition: `background ${tokens.transition.fast}`, minHeight: 40 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ width: 20, height: 20, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: tokens.colors.text.tertiary, flexShrink: 0 }}>{index + 1}</span>
        <CryptoIcon symbol={sym} size={20} />
        <span style={{ fontWeight: 600, color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.sm }}>{sym}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
        <span style={{ color: tokens.colors.text.secondary, fontFamily: 'var(--font-mono, monospace)', fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums', minWidth: 80, textAlign: 'right' } as React.CSSProperties}>{formattedPrice}</span>
        <span style={{ color, fontWeight: 700, fontSize: tokens.typography.fontSize.sm, minWidth: 72, textAlign: 'right', padding: `3px ${tokens.spacing[2]}`, borderRadius: tokens.radius.sm, background: isGainer ? 'var(--color-accent-success-10)' : 'var(--color-accent-error-10)', fontFamily: 'var(--font-mono, monospace)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.4 } as React.CSSProperties}>{changePct}</span>
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
    <div style={{ width: 80, height: 6, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.full, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: tokens.gradient.purple, borderRadius: tokens.radius.full, transition: `width ${tokens.transition.slow}` }} />
    </div>
  )
}

function useTimeSince(timestamp: number | null): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!timestamp) return
    const id = setInterval(() => { if (document.visibilityState === 'hidden') return; setNow(Date.now()) }, 1000)
    return () => clearInterval(id)
  }, [timestamp])
  if (!timestamp) return ''
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}

const UpdatedAgoLabel = memo(function UpdatedAgoLabel({ timestamp, label }: { timestamp: number | null; label: string }) {
  const ago = useTimeSince(timestamp)
  if (!ago) return null
  return <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 6 }} suppressHydrationWarning>{label} {ago}</div>
})

function spotRowsToCoins(spots: SpotCoin[]): CoinRow[] {
  return spots
    .filter(s => s.change24h != null && s.price != null)
    .map(s => ({
      symbol: `${s.symbol.toUpperCase()}-USD`,
      price: s.price?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '0',
      changePct: `${s.change24h >= 0 ? '+' : ''}${s.change24h.toFixed(2)}%`,
      direction: s.change24h >= 0 ? 'up' as const : 'down' as const,
    }))
}

export default function CoreCards({ spotData }: { spotData?: SpotCoin[] }) {
  const { t } = useLanguage()
  const [gainers, setGainers] = useState<CoinRow[]>([])
  const [losers, setLosers] = useState<CoinRow[]>([])
  const [marketLoaded, setMarketLoaded] = useState(false)
  const [exchanges, setExchanges] = useState<ExchangeInfo[]>([])
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    const controller = new AbortController()

    const fetchMarketData = () => {
      fetch('/api/market', { signal: controller.signal })
        .then(r => { if (!r.ok) throw new Error(`market: ${r.status}`); return r.json() })
        .then(json => {
          if (!alive) return
          const rows: CoinRow[] = json.rows ?? []
          if (rows.length === 0) throw new Error('empty')
          const sorted = [...rows].sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct))
          let primaryLosers = sorted.filter(r => r.direction === 'down').slice(-5).reverse()
          let primaryGainers = sorted.filter(r => r.direction === 'up').slice(0, 5)

          if ((primaryLosers.length < 5 || primaryGainers.length < 5) && spotData && spotData.length > 0) {
            const spotRows = spotRowsToCoins(spotData)
            const primarySymbols = new Set(rows.map(r => r.symbol))
            const spotSorted = [...spotRows].sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct))
            if (primaryGainers.length < 5) {
              const spotGainers = spotSorted.filter(r => r.direction === 'up' && !primarySymbols.has(r.symbol))
              primaryGainers = [...primaryGainers, ...spotGainers].slice(0, 5)
            }
            if (primaryLosers.length < 5) {
              const spotLosers = spotSorted.filter(r => r.direction === 'down' && !primarySymbols.has(r.symbol)).slice(-20).reverse()
              primaryLosers = [...primaryLosers, ...spotLosers.slice(0, 5 - primaryLosers.length)]
              primaryLosers.sort((a, b) => parseFloat(a.changePct) - parseFloat(b.changePct))
            }
          }
          setGainers(primaryGainers)
          setLosers(primaryLosers)
          setMarketLoaded(true)
          setLastFetchedAt(Date.now())
        })
        .catch(() => {
          if (!alive) return
          if (spotData && spotData.length > 0) {
            const rows = spotRowsToCoins(spotData)
            const sorted = [...rows].sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct))
            setGainers(sorted.filter(r => r.direction === 'up').slice(0, 5))
            setLosers(sorted.filter(r => r.direction === 'down').slice(-5).reverse())
            setMarketLoaded(true)
            setLastFetchedAt(Date.now())
          } else { setMarketLoaded(true) }
        })

      apiFetch<ExchangeInfo[]>('/api/market/exchanges', { signal: controller.signal })
        .then(json => { if (alive && Array.isArray(json)) setExchanges(json.slice(0, 5)) })
        .catch(err => console.warn('[CoreCards] fetch failed', err))
    }
    fetchMarketData()
    const interval = setInterval(() => { if (document.visibilityState === 'hidden') return; fetchMarketData() }, 60000)
    return () => { alive = false; controller.abort(); clearInterval(interval) }
  }, [spotData])

  const maxVol = exchanges.length > 0 ? Math.max(...exchanges.map(e => e.trade_volume_24h_btc)) : 0

  return (
    <div>
    <UpdatedAgoLabel timestamp={lastFetchedAt} label={t('lastUpdated') || 'Updated'} />
    <div className="core-cards-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacing[4], overflowX: 'hidden' }}>
      <CardWrapper title={t('gainersTop5')} accentColor={tokens.gradient.success}>
        {gainers.length === 0 ? (marketLoaded ? (<div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm }}>{t('noGainers')}</div>) : (<div style={{ height: 160 }} className="skeleton" />)) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{gainers.map((row, i) => (<CoinItem key={row.symbol} symbol={row.symbol} price={row.price} changePct={row.changePct} isGainer={true} index={i} />))}</div>
        )}
      </CardWrapper>
      <CardWrapper title={t('losersTop5')} accentColor={tokens.gradient.error}>
        {losers.length === 0 ? (marketLoaded ? (<div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm }}>{t('noLosers')}</div>) : (<div style={{ height: 160 }} className="skeleton" />)) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{losers.map((row, i) => (<CoinItem key={row.symbol} symbol={row.symbol} price={row.price} changePct={row.changePct} isGainer={false} index={i} />))}</div>
        )}
      </CardWrapper>
      <CardWrapper title={t('fundFlow')} accentColor={tokens.gradient.purple}>
        {exchanges.length === 0 ? (<div style={{ height: 160 }} className="skeleton" />) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{exchanges.map((ex, i) => (
            <div key={ex.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.md, background: i % 2 === 0 ? tokens.glass.bg.light : 'transparent', minHeight: 40 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 20, height: 20, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: tokens.colors.text.tertiary, flexShrink: 0 }}>{i + 1}</span>
                <span style={{ fontWeight: 600, color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.sm }}>{ex.name}</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                <VolumeBar value={ex.trade_volume_24h_btc} max={maxVol} />
                <span style={{ color: tokens.colors.text.secondary, fontFamily: 'var(--font-mono, monospace)', fontSize: tokens.typography.fontSize.xs, fontVariantNumeric: 'tabular-nums', minWidth: 80, textAlign: 'right', letterSpacing: '-0.3px' } as React.CSSProperties}>{formatBTC(ex.trade_volume_24h_btc)}</span>
              </span>
            </div>
          ))}</div>
        )}
      </CardWrapper>
    </div>
    </div>
  )
}
