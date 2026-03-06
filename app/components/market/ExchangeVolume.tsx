'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { ExchangeInfo } from '@/lib/utils/coingecko'
import { uiLogger } from '@/lib/utils/logger'

function formatBTC(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return value.toFixed(0)
}

export default function ExchangeVolume() {
  const { t } = useLanguage()
  const [exchanges, setExchanges] = useState<ExchangeInfo[]>([])

  useEffect(() => {
    fetch('/api/market/exchanges')
      .then((r) => r.json())
      .then((json) => { if (Array.isArray(json)) setExchanges(json) })
      .catch((err) => { uiLogger.warn('ExchangeVolume fetch failed', { error: err instanceof Error ? err.message : String(err) }) })
  }, [])

  if (exchanges.length === 0) return null

  return (
    <div style={{
      padding: '10px 12px',
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.md,
      border: tokens.glass.border.light,
    }}>
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
