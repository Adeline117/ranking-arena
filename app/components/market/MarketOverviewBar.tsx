'use client'

import { useEffect, useState, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import { useRealtimeMarket, type PriceFlash } from '@/lib/hooks/useRealtimeMarket'

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

/** 价格闪烁效果组件 */
function FlashPrice({
  value,
  flash,
}: {
  value: string
  flash: PriceFlash | undefined
}) {
  const flashColor = flash?.direction === 'up'
    ? 'rgba(22, 199, 132, 0.3)'
    : flash?.direction === 'down'
      ? 'rgba(234, 57, 67, 0.3)'
      : 'transparent'

  return (
    <span
      style={{
        color: tokens.colors.text.primary,
        fontWeight: 600,
        transition: 'background-color 0.3s ease',
        backgroundColor: flashColor,
        borderRadius: 3,
        padding: '0 2px',
      }}
    >
      {value}
    </span>
  )
}

export default function MarketOverviewBar() {
  const [data, setData] = useState<OverviewData | null>(null)

  // 从 overview API 获取基础数据（总市值等）
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

  // 实时价格数据
  const { prices, flashes, connected } = useRealtimeMarket({
    mode: 'poll',
    pollInterval: 10000,
    enabled: true,
  })

  // 合并实时数据与 overview 数据
  const items = useMemo(() => {
    if (!data) return []

    const btcPrice = prices.BTC?.price ?? data.btcPrice
    const btcChange = prices.BTC?.changePct24h ?? data.btcChange24h
    const ethPrice = prices.ETH?.price ?? data.ethPrice
    const ethChange = prices.ETH?.changePct24h ?? data.ethChange24h

    return [
      {
        label: 'BTC',
        value: formatPrice(btcPrice),
        change: btcChange,
        symbol: 'BTC',
      },
      {
        label: 'ETH',
        value: formatPrice(ethPrice),
        change: ethChange,
        symbol: 'ETH',
      },
      // 额外的实时币种
      ...(prices.SOL
        ? [{
            label: 'SOL',
            value: formatPrice(prices.SOL.price),
            change: prices.SOL.changePct24h,
            symbol: 'SOL',
          }]
        : []),
      ...(prices.BNB
        ? [{
            label: 'BNB',
            value: formatPrice(prices.BNB.price),
            change: prices.BNB.changePct24h,
            symbol: 'BNB',
          }]
        : []),
      { label: t('marketCap'), value: formatUsd(data.totalMarketCap) },
      { label: t('tradingVolume24h'), value: formatUsd(data.totalVolume24h) },
      { label: t('btcDominance'), value: `${data.btcDominance.toFixed(1)}%` },
      ...(data.ethGasGwei != null
        ? [{ label: t('ethGas'), value: `${Math.round(data.ethGasGwei)} Gwei` }]
        : []),
    ]
  }, [data, prices])

  if (!data) return null

  return (
    <div
      className="market-overview-bar"
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
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {t('marketOverview')}
        {connected && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: '#16c784',
              display: 'inline-block',
            }}
            title="实时数据已连接"
          />
        )}
      </span>
      {items.map((item, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ color: tokens.colors.text.tertiary }}>{item.label}</span>
          {'symbol' in item && item.symbol ? (
            <FlashPrice
              value={item.value}
              flash={flashes[item.symbol]}
            />
          ) : (
            <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>{item.value}</span>
          )}
          {'change' in item && item.change != null && <ChangeSpan value={item.change} />}
        </span>
      ))}
    </div>
  )
}
