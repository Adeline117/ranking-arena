'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'

interface CrossExchangeOpp {
  type: 'cross-exchange'
  symbol: string
  buyExchange: string
  sellExchange: string
  spreadPct: number
}

export default function ArbitrageOpportunities() {
  const [opps, setOpps] = useState<CrossExchangeOpp[]>([])

  useEffect(() => {
    fetch('/api/market/arbitrage')
      .then((r) => r.json())
      .then((json) => {
        if (json.ok && Array.isArray(json.opportunities)) {
          setOpps(json.opportunities.filter((o: any) => o.type === 'cross-exchange').slice(0, 3))
        }
      })
      .catch(() => {})
  }, [])

  const hasData = opps.length > 0

  return (
    <div style={{
      padding: '10px 12px',
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.md,
      border: tokens.glass.border.light,
    }}>
      <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
        {t('arbitrageOpportunities')}
      </div>
      {!hasData ? (
        <div style={{ color: tokens.colors.text.tertiary, fontSize: 11 }}>{t('noData')}</div>
      ) : opps.map((opp, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 11 }}>
          <span style={{ color: tokens.colors.text.primary, fontWeight: 500 }}>{opp.symbol}</span>
          <span style={{ color: '#16c784', fontWeight: 600 }}>+{opp.spreadPct}%</span>
        </div>
      ))}
    </div>
  )
}
