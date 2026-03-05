'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { DefiOverview as DefiOverviewData } from '@/lib/utils/defillama'

function formatTVL(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  return `$${value.toLocaleString()}`
}

export default function DefiOverview() {
  const { t } = useLanguage()
  const [data, setData] = useState<DefiOverviewData | null>(null)

  useEffect(() => {
    fetch('/api/market/defi')
      .then((r) => r.json())
      .then((json) => { if (!json.error) setData(json) })
      .catch(() => {})
  }, [])

  if (!data) return null

  return (
    <div style={{
      padding: '10px 12px',
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.md,
      border: tokens.glass.border.light,
    }}>
      <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
        {t('defiOverview')}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: tokens.colors.text.primary, lineHeight: 1 }}>
          {formatTVL(data.totalTVL)}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: data.tvlChange24h >= 0 ? 'var(--color-accent-success)' : 'var(--color-accent-error)' }}>
          {data.tvlChange24h >= 0 ? '+' : ''}{data.tvlChange24h.toFixed(2)}%
        </span>
      </div>
      {data.topProtocols.slice(0, 3).map((p) => (
        <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', fontSize: 11 }}>
          <span style={{ color: tokens.colors.text.primary }}>{p.name}</span>
          <span style={{ color: tokens.colors.text.secondary }}>{formatTVL(p.tvl)}</span>
        </div>
      ))}
    </div>
  )
}
