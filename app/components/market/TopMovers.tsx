'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'

interface CoinRow {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

export default function TopMovers() {
  const [gainers, setGainers] = useState<CoinRow[]>([])
  const [losers, setLosers] = useState<CoinRow[]>([])

  useEffect(() => {
    fetch('/api/market')
      .then((r) => r.json())
      .then((json) => {
        const rows: CoinRow[] = json.rows ?? []
        const sorted = [...rows].sort((a, b) => {
          const pA = parseFloat(a.changePct)
          const pB = parseFloat(b.changePct)
          return pB - pA
        })
        setGainers(sorted.filter((r) => r.direction === 'up').slice(0, 5))
        setLosers(sorted.filter((r) => r.direction === 'down').slice(-5).reverse())
      })
      .catch(() => {})
  }, [])

  if (gainers.length === 0 && losers.length === 0) return null

  return (
    <div
      style={{
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.md,
        borderRadius: tokens.radius.lg,
        border: tokens.glass.border.light,
      }}
    >
      {gainers.length > 0 && (
        <Section title={t('topGainers')} rows={gainers} />
      )}
      {losers.length > 0 && (
        <Section title={t('topLosers')} rows={losers} />
      )}
    </div>
  )
}

function Section({ title, rows }: { title: string; rows: CoinRow[] }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.secondary,
          fontWeight: tokens.typography.fontWeight.medium,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {rows.map((row) => {
        const color = row.direction === 'up' ? '#16c784' : '#ea3943'
        const symbol = row.symbol.replace('-USD', '')
        return (
          <div
            key={row.symbol}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '3px 0',
              fontSize: 12,
            }}
          >
            <span style={{ color: tokens.colors.text.primary, fontWeight: 500 }}>{symbol}</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: tokens.colors.text.secondary }}>{row.price}</span>
              <span style={{ color, fontWeight: 600, minWidth: 60, textAlign: 'right' }}>
                {row.changePct}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
