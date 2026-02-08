'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import type { ExchangeInfo } from '@/lib/utils/coingecko'

function formatBTC(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return value.toFixed(0)
}

const BAR_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#6366f1', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]

export default function ExchangeVolume() {
  const [exchanges, setExchanges] = useState<ExchangeInfo[]>([])

  useEffect(() => {
    fetch('/api/market/exchanges')
      .then((r) => r.json())
      .then((json) => {
        if (Array.isArray(json)) setExchanges(json)
      })
      .catch(() => {})
  }, [])

  if (exchanges.length === 0) return null

  const maxVol = Math.max(...exchanges.map((e) => e.trade_volume_24h_btc))
  const totalVol = exchanges.reduce((sum, e) => sum + e.trade_volume_24h_btc, 0)

  return (
    <div
      style={{
        background: tokens.glass.bg.secondary,
        borderRadius: 12,
        padding: 14,
        border: tokens.glass.border.light,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 10,
        }}
      >
        <span style={{ color: tokens.colors.text.secondary, fontSize: 12 }}>
          {t('exchangeVolume')}
        </span>
        <span style={{ color: tokens.colors.text.tertiary, fontSize: 10 }}>
          24h / BTC
        </span>
      </div>

      {/* Stacked bar overview */}
      <div
        style={{
          display: 'flex',
          height: 8,
          borderRadius: 4,
          overflow: 'hidden',
          marginBottom: 10,
        }}
      >
        {exchanges.map((ex, i) => {
          const pct = totalVol > 0 ? (ex.trade_volume_24h_btc / totalVol) * 100 : 0
          if (pct < 0.5) return null
          return (
            <div
              key={ex.id}
              title={`${ex.name}: ${formatBTC(ex.trade_volume_24h_btc)} BTC`}
              style={{
                width: `${pct}%`,
                background: BAR_COLORS[i % BAR_COLORS.length],
                minWidth: 2,
              }}
            />
          )
        })}
      </div>

      {/* Exchange list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {exchanges.slice(0, 8).map((ex, i) => {
          const barWidth = maxVol > 0 ? Math.max((ex.trade_volume_24h_btc / maxVol) * 100, 3) : 3

          return (
            <div key={ex.id}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 2,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 2,
                      background: BAR_COLORS[i % BAR_COLORS.length],
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: 12, color: tokens.colors.text.primary }}>
                    {ex.name}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: tokens.colors.text.secondary, fontWeight: 600 }}>
                  {formatBTC(ex.trade_volume_24h_btc)}
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  borderRadius: 2,
                  background: tokens.colors.bg.primary,
                  overflow: 'hidden',
                  marginLeft: 12,
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${barWidth}%`,
                    borderRadius: 2,
                    background: BAR_COLORS[i % BAR_COLORS.length],
                    opacity: 0.6,
                    transition: 'width 0.6s ease',
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
