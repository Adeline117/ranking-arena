'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import type { DefiOverview as DefiOverviewData } from '@/lib/utils/defillama'

function formatTVL(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  return `$${value.toLocaleString()}`
}

export default function DefiOverview() {
  const [data, setData] = useState<DefiOverviewData | null>(null)

  useEffect(() => {
    fetch('/api/market/defi')
      .then((r) => r.json())
      .then((json) => {
        if (!json.error) setData(json)
      })
      .catch(() => {})
  }, [])

  if (!data) return null

  const totalChainTVL = data.chains.reduce((sum, c) => sum + c.tvl, 0)
  const chainColors = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#6366f1', '#ec4899', '#14b8a6', '#f97316', '#64748b']

  return (
    <div
      style={{
        background: tokens.glass.bg.secondary,
        borderRadius: 12,
        padding: 14,
        border: tokens.glass.border.light,
      }}
    >
      <div style={{ color: tokens.colors.text.secondary, fontSize: 12, marginBottom: 8 }}>
        {t('defiOverview')}
      </div>

      {/* Total TVL */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: tokens.colors.text.primary }}>
          {formatTVL(data.totalTVL)}
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: data.tvlChange24h >= 0 ? '#16c784' : '#ea3943',
          }}
        >
          {data.tvlChange24h >= 0 ? '+' : ''}{data.tvlChange24h.toFixed(2)}%
        </span>
      </div>

      {/* Top 5 Protocols */}
      <div style={{ color: tokens.colors.text.secondary, fontSize: 11, marginBottom: 6 }}>
        {t('topProtocols')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
        {data.topProtocols.map((p) => (
          <div
            key={p.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: 12,
            }}
          >
            <span style={{ color: tokens.colors.text.primary }}>{p.name}</span>
            <span style={{ color: tokens.colors.text.secondary }}>{formatTVL(p.tvl)}</span>
          </div>
        ))}
      </div>

      {/* Chain Breakdown Bar */}
      <div style={{ color: tokens.colors.text.secondary, fontSize: 11, marginBottom: 6 }}>
        {t('chainBreakdown')}
      </div>
      <div
        style={{
          display: 'flex',
          height: 8,
          borderRadius: 4,
          overflow: 'hidden',
          marginBottom: 6,
        }}
      >
        {data.chains.slice(0, 10).map((chain, i) => {
          const pct = totalChainTVL > 0 ? (chain.tvl / totalChainTVL) * 100 : 0
          if (pct < 1) return null
          return (
            <div
              key={chain.name}
              title={`${chain.name}: ${formatTVL(chain.tvl)}`}
              style={{
                width: `${pct}%`,
                background: chainColors[i % chainColors.length],
                minWidth: 2,
              }}
            />
          )
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
        {data.chains.slice(0, 5).map((chain, i) => (
          <div key={chain.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
            <div style={{ width: 6, height: 6, borderRadius: 2, background: chainColors[i % chainColors.length] }} />
            <span style={{ color: tokens.colors.text.secondary }}>{chain.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
