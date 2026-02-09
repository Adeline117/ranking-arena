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

interface TriangularOpp {
  type: 'triangular'
  exchange: string
  path: string[]
  profitPct: number
}

type ArbOpp = CrossExchangeOpp | TriangularOpp

export default function ArbitrageOpportunities() {
  const [opps, setOpps] = useState<ArbOpp[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/market/arbitrage')
      .then((r) => r.json())
      .then((json) => {
        if (json.ok && Array.isArray(json.opportunities)) {
          setOpps(json.opportunities.slice(0, 4))
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

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
      {loading ? (
        <div className="skeleton" style={{ height: 40, borderRadius: 6 }} />
      ) : opps.length === 0 ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '8px 0 4px',
          gap: 4,
        }}>
          {/* Minimal balance/equilibrium SVG icon */}
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="14" stroke={tokens.colors.text.tertiary} strokeWidth="1" opacity="0.2" />
            <line x1="8" y1="16" x2="24" y2="16" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" opacity="0.35" strokeLinecap="round" />
            <line x1="16" y1="10" x2="16" y2="22" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" opacity="0.35" strokeLinecap="round" />
            <circle cx="16" cy="16" r="2.5" fill={tokens.colors.text.tertiary} opacity="0.25" />
          </svg>
          <div style={{
            fontSize: 11,
            color: tokens.colors.text.tertiary,
            textAlign: 'center',
            lineHeight: 1.3,
            opacity: 0.7,
          }}>
            Markets in equilibrium
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {opps.map((opp, i) => {
            if (opp.type === 'cross-exchange') {
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 11 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>{opp.symbol.replace('/USDT', '')}</span>
                    <span style={{ color: tokens.colors.text.tertiary, fontSize: 9 }}>
                      {opp.buyExchange} &rarr; {opp.sellExchange}
                    </span>
                  </div>
                  <span style={{ color: '#16c784', fontWeight: 700, fontSize: 12 }}>+{opp.spreadPct.toFixed(2)}%</span>
                </div>
              )
            }
            // Triangular
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: tokens.colors.text.primary, fontWeight: 600, fontSize: 9 }}>
                    {opp.path.join(' > ')}
                  </span>
                  <span style={{ color: tokens.colors.text.tertiary, fontSize: 9 }}>{opp.exchange}</span>
                </div>
                <span style={{ color: '#16c784', fontWeight: 700, fontSize: 12 }}>+{opp.profitPct.toFixed(2)}%</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
