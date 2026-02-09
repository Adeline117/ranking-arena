'use client'

import { useEffect, useState, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useRealtimeMarket, type PriceFlash } from '@/lib/hooks/useRealtimeMarket'

interface SentimentData {
  btcPrice: number
  btcChange24h: number
  ethPrice: number
  ethChange24h: number
  fearGreedValue: number | null
  fearGreedLabel: string
  liquidation24h: number | null
  ethGasGwei: number | null
}

function formatPrice(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toLocaleString()}`
}

function getFearGreedColor(value: number): string {
  if (value <= 25) return tokens.colors.accent.error
  if (value <= 45) return tokens.colors.accent.warning
  if (value <= 55) return tokens.colors.text.secondary
  if (value <= 75) return tokens.colors.accent.success
  return tokens.colors.accent.success
}

function FlashValue({ value, flash }: { value: string; flash?: PriceFlash }) {
  const bg = flash?.direction === 'up'
    ? 'rgba(22, 199, 132, 0.25)'
    : flash?.direction === 'down'
      ? 'rgba(234, 57, 67, 0.25)'
      : 'transparent'

  return (
    <span
      style={{
        fontWeight: 600,
        fontFamily: 'var(--font-mono, monospace)',
        transition: 'background-color 0.3s ease',
        backgroundColor: bg,
        borderRadius: 3,
        padding: '0 2px',
        color: tokens.colors.text.primary,
      }}
    >
      {value}
    </span>
  )
}

function Separator() {
  return (
    <span
      style={{
        width: 1,
        height: 20,
        background: tokens.colors.border.primary,
        flexShrink: 0,
      }}
    />
  )
}

export default function SentimentBar() {
  const [data, setData] = useState<SentimentData | null>(null)

  const { prices, flashes } = useRealtimeMarket({
    mode: 'poll',
    pollInterval: 10000,
    enabled: true,
  })

  useEffect(() => {
    async function fetchData() {
      try {
        const [overviewRes, fgRes] = await Promise.all([
          fetch('/api/market/overview'),
          fetch('/api/market/fear-greed'),
        ])
        const overview = await overviewRes.json()
        const fg = await fgRes.json()

        setData({
          btcPrice: overview.btcPrice ?? 0,
          btcChange24h: overview.btcChange24h ?? 0,
          ethPrice: overview.ethPrice ?? 0,
          ethChange24h: overview.ethChange24h ?? 0,
          fearGreedValue: fg.current?.value ?? null,
          fearGreedLabel: fg.current?.classification ?? '',
          liquidation24h: overview.liquidation24h ?? null,
          ethGasGwei: overview.ethGasGwei ?? null,
        })
      } catch { /* ignore */ }
    }
    fetchData()
    const interval = setInterval(fetchData, 60000)
    return () => clearInterval(interval)
  }, [])

  const items = useMemo(() => {
    if (!data) return []
    const btcPrice = prices.BTC?.price ?? data.btcPrice
    const btcChange = prices.BTC?.changePct24h ?? data.btcChange24h
    const ethPrice = prices.ETH?.price ?? data.ethPrice
    const ethChange = prices.ETH?.changePct24h ?? data.ethChange24h
    return { btcPrice, btcChange, ethPrice, ethChange }
  }, [data, prices])

  if (!data) return <div style={{ height: 48 }} />

  const { btcPrice, btcChange, ethPrice, ethChange } = items as any

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 100,
        height: 48,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 20px',
        background: tokens.colors.bg.secondary,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        fontSize: 13,
        overflowX: 'auto',
        whiteSpace: 'nowrap',
        scrollbarWidth: 'none',
      }}
    >
      {/* BTC */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <svg width="16" height="16" viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
          <circle cx="16" cy="16" r="16" fill="#F7931A" />
          <text x="16" y="22" textAnchor="middle" fill="#fff" fontSize="18" fontWeight="bold">B</text>
        </svg>
        <span style={{ color: tokens.colors.text.tertiary }}>BTC</span>
        <FlashValue value={formatPrice(btcPrice)} flash={flashes.BTC} />
        <span style={{ color: btcChange >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error, fontWeight: 600 }}>
          {formatPct(btcChange)}
        </span>
      </span>

      <Separator />

      {/* ETH */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <svg width="16" height="16" viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
          <circle cx="16" cy="16" r="16" fill="#627EEA" />
          <text x="16" y="22" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="bold">E</text>
        </svg>
        <span style={{ color: tokens.colors.text.tertiary }}>ETH</span>
        <FlashValue value={formatPrice(ethPrice)} flash={flashes.ETH} />
        <span style={{ color: ethChange >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error, fontWeight: 600 }}>
          {formatPct(ethChange)}
        </span>
      </span>

      <Separator />

      {/* Fear & Greed */}
      {data.fearGreedValue != null && (
        <>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: tokens.colors.text.tertiary }}>恐惧贪婪</span>
            <span style={{
              fontWeight: 700,
              color: getFearGreedColor(data.fearGreedValue),
              fontSize: 14,
            }}>
              {data.fearGreedValue}
            </span>
            <span style={{
              fontSize: 11,
              color: getFearGreedColor(data.fearGreedValue),
            }}>
              {data.fearGreedLabel}
            </span>
          </span>
          <Separator />
        </>
      )}

      {/* 24h Liquidation */}
      {data.liquidation24h != null && (
        <>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: tokens.colors.text.tertiary }}>24h清算</span>
            <span style={{ color: tokens.colors.accent.error, fontWeight: 600 }}>
              {formatUsd(data.liquidation24h)}
            </span>
          </span>
          <Separator />
        </>
      )}

      {/* Gas */}
      {data.ethGasGwei != null && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: tokens.colors.text.tertiary }}>Gas</span>
          <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>
            {Math.round(data.ethGasGwei)} Gwei
          </span>
        </span>
      )}
    </div>
  )
}
