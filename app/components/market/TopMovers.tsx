'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import CryptoIcon from '@/app/components/common/CryptoIcon'

interface CoinRow {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

export default function TopMovers() {
  const [gainers, setGainers] = useState<CoinRow[]>([])

  useEffect(() => {
    fetch('/api/market')
      .then((r) => r.json())
      .then((json) => {
        const rows: CoinRow[] = json.rows ?? []
        const sorted = [...rows].sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct))
        setGainers(sorted.filter((r) => r.direction === 'up').slice(0, 3))
      })
      .catch(() => {})
  }, [])

  if (gainers.length === 0) return null

  return (
    <div style={{
      padding: '10px 12px',
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.md,
      border: tokens.glass.border.light,
    }}>
      <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
        {t('topGainers')}
      </div>
      {gainers.map((row) => {
        const symbol = row.symbol.replace('-USD', '')
        return (
          <div key={row.symbol} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 11 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CryptoIcon symbol={symbol} size={14} />
              <span style={{ color: tokens.colors.text.primary, fontWeight: 500 }}>{symbol}</span>
            </span>
            <span style={{ color: 'var(--color-accent-success)', fontWeight: 600 }}>{row.changePct}</span>
          </div>
        )
      })}
    </div>
  )
}
