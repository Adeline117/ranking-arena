'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { ExchangeInfo } from '@/lib/utils/coingecko'

function formatBTC(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return value.toFixed(0)
}

const cardStyle = {
  padding: '10px 12px',
  background: tokens.glass.bg.secondary,
  backdropFilter: tokens.glass.blur.md,
  borderRadius: tokens.radius.md,
  border: tokens.glass.border.light,
}

export default function ExchangeVolume() {
  const { t } = useLanguage()
  const [exchanges, setExchanges] = useState<ExchangeInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/market/exchanges', { signal: AbortSignal.timeout(15000) })
      .then((r) => r.json())
      .then((json) => { if (Array.isArray(json)) setExchanges(json) })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Failed to load')
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div style={cardStyle}>
        <div className="skeleton" style={{ height: 12, width: '50%', marginBottom: 8, borderRadius: 4 }} />
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="skeleton" style={{ height: 14, width: `${95 - i * 5}%`, marginBottom: 4, borderRadius: 4 }} />
        ))}
      </div>
    )
  }

  if (error || exchanges.length === 0) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
          {t('exchangeVolume')}
        </div>
        <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, textAlign: 'center', padding: '4px 0' }}>
          {error ? t('sidebarLoadFailed') : t('noDataGeneric')}
        </div>
      </div>
    )
  }

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
        {t('exchangeVolume')}
      </div>
      {exchanges.slice(0, 4).map((ex) => (
        <div key={ex.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 11 }}>
          <span style={{ color: tokens.colors.text.primary, fontWeight: 500 }}>{ex.name}</span>
          <span style={{ color: tokens.colors.text.secondary, fontWeight: 600 }}>{formatBTC(ex.trade_volume_24h_btc)}</span>
        </div>
      ))}
    </div>
  )
}
