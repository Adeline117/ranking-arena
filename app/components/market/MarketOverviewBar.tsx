'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'

interface OverviewData {
  btcPrice: number
  btcChange24h: number
  ethPrice: number
  ethChange24h: number
  totalMarketCap: number
  totalVolume24h: number
  btcDominance: number
  ethGasGwei: number | null
}

function formatUsd(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatPrice(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function ChangeSpan({ value }: { value: number }) {
  const color = value >= 0 ? '#16c784' : '#ea3943'
  return <span style={{ color, fontWeight: 600 }}>{formatPct(value)}</span>
}

export default function MarketOverviewBar() {
  const [data, setData] = useState<OverviewData | null>(null)

  useEffect(() => {
    fetch('/api/market/overview')
      .then((r) => r.json())
      .then((json) => {
        if (json.btcPrice) setData(json)
      })
      .catch(() => {})

    const interval = setInterval(() => {
      fetch('/api/market/overview')
        .then((r) => r.json())
        .then((json) => {
          if (json.btcPrice) setData(json)
        })
        .catch(() => {})
    }, 5 * 60 * 1000)

    return () => clearInterval(interval)
  }, [])

  if (!data) return null

  const items = [
    { label: 'BTC', value: formatPrice(data.btcPrice), change: data.btcChange24h },
    { label: 'ETH', value: formatPrice(data.ethPrice), change: data.ethChange24h },
    { label: t('marketCap'), value: formatUsd(data.totalMarketCap) },
    { label: t('tradingVolume24h'), value: formatUsd(data.totalVolume24h) },
    { label: t('btcDominance'), value: `${data.btcDominance.toFixed(1)}%` },
    ...(data.ethGasGwei != null
      ? [{ label: t('ethGas'), value: `${Math.round(data.ethGasGwei)} Gwei` }]
      : []),
  ]

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        padding: '8px 16px',
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.md,
        borderRadius: tokens.radius.lg,
        border: tokens.glass.border.light,
        fontSize: 13,
        color: tokens.colors.text.secondary,
        overflowX: 'auto',
        whiteSpace: 'nowrap',
        marginBottom: 12,
        scrollbarWidth: 'none',
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: tokens.colors.text.tertiary,
          flexShrink: 0,
        }}
      >
        {t('marketOverview')}
      </span>
      {items.map((item, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ color: tokens.colors.text.tertiary }}>{item.label}</span>
          <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>{item.value}</span>
          {'change' in item && item.change != null && <ChangeSpan value={item.change} />}
        </span>
      ))}
    </div>
  )
}
