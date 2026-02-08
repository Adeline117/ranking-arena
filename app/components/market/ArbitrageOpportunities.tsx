'use client'

import { useEffect, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'

interface CrossExchangeOpp {
  type: 'cross-exchange'
  symbol: string
  buyExchange: string
  sellExchange: string
  buyPrice: number
  sellPrice: number
  spreadPct: number
  updatedAt: number
}

interface TriangularOpp {
  type: 'triangular'
  exchange: string
  path: string[]
  steps: { from: string; to: string; rate: number; symbol: string }[]
  profitPct: number
  updatedAt: number
}

type Opportunity = CrossExchangeOpp | TriangularOpp

function profitColor(pct: number): string {
  if (pct >= 1.0) return '#00e676'
  if (pct >= 0.5) return '#66bb6a'
  if (pct >= 0.2) return '#a5d6a7'
  return '#c8e6c9'
}

function formatPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(4)
  return n.toPrecision(4)
}

export default function ArbitrageOpportunities() {
  const [opps, setOpps] = useState<Opportunity[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState<number>(0)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/market/arbitrage')
      const json = await res.json()
      if (json.ok && Array.isArray(json.opportunities)) {
        setOpps(json.opportunities)
        setLastUpdate(json.ts ?? Date.now())
      }
    } catch {
      // 静默
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, 30_000)
    return () => clearInterval(iv)
  }, [fetchData])

  const c = tokens.colors

  return (
    <div style={{
      background: c.bg.secondary,
      borderRadius: 12,
      padding: '20px',
      border: `1px solid ${c.border.primary}`,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
      }}>
        <h3 style={{ color: c.text.primary, fontSize: 16, fontWeight: 600, margin: 0 }}>
          {t('arbitrageOpportunities')}
        </h3>
        {lastUpdate > 0 && (
          <span style={{ color: c.text.tertiary, fontSize: 12 }}>
            {new Date(lastUpdate).toLocaleTimeString()}
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ color: c.text.tertiary, textAlign: 'center', padding: 20 }}>
          {t('loading')}...
        </div>
      ) : opps.length === 0 ? (
        <div style={{ color: c.text.tertiary, textAlign: 'center', padding: 20 }}>
          {t('noData')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {opps.map((opp, i) => (
            <OppCard key={i} opp={opp} colors={c} />
          ))}
        </div>
      )}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function OppCard({ opp, colors: c }: { opp: Opportunity; colors: any }) {
  const pct = opp.type === 'cross-exchange' ? opp.spreadPct : opp.profitPct
  const color = profitColor(pct)

  if (opp.type === 'cross-exchange') {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 16px',
        borderRadius: 8,
        background: c.bg.tertiary,
        borderLeft: `3px solid ${color}`,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: c.text.primary, fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
            {opp.symbol}
          </div>
          <div style={{ color: c.text.tertiary, fontSize: 12 }}>
            {t('buyAt')}: {opp.buyExchange} @ {formatPrice(opp.buyPrice)}
          </div>
          <div style={{ color: c.text.tertiary, fontSize: 12 }}>
            {t('sellAt')}: {opp.sellExchange} @ {formatPrice(opp.sellPrice)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color, fontWeight: 700, fontSize: 18 }}>
            +{pct}%
          </div>
          <div style={{ color: c.text.tertiary, fontSize: 11 }}>
            {t('spread')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '12px 16px',
      borderRadius: 8,
      background: c.bg.tertiary,
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ color: c.text.primary, fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
          {opp.path.join(' > ')}
        </div>
        <div style={{ color: c.text.tertiary, fontSize: 12 }}>
          {opp.exchange} | {opp.steps.map(s => s.symbol).join(' > ')}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ color, fontWeight: 700, fontSize: 18 }}>
          +{pct}%
        </div>
        <div style={{ color: c.text.tertiary, fontSize: 11 }}>
          {t('estimatedProfit')}
        </div>
      </div>
    </div>
  )
}
