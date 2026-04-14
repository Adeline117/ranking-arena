'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { CryptoCategory } from '@/lib/utils/coingecko'

const SECTOR_LABELS: Record<string, string> = {
  'layer-1': 'L1',
  'layer-2': 'L2',
  'decentralized-finance-defi': 'DeFi',
  'meme-token': 'Meme',
  'artificial-intelligence': 'AI',
  'gaming': 'GameFi',
  'real-world-assets-rwa': 'RWA',
  'stablecoins': 'Stable',
}

const cardStyle = {
  padding: '10px 12px',
  background: tokens.glass.bg.secondary,
  backdropFilter: tokens.glass.blur.md,
  borderRadius: tokens.radius.md,
  border: tokens.glass.border.light,
}

export default function SectorPerformance() {
  const { t } = useLanguage()
  const [sectors, setSectors] = useState<CryptoCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/market/sectors', { signal: AbortSignal.timeout(15000) })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((json) => { if (Array.isArray(json)) setSectors(json.slice(0, 4)) })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Failed to load')
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div style={cardStyle}>
        <div className="skeleton" style={{ height: 12, width: '55%', marginBottom: 8, borderRadius: 4 }} />
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="skeleton" style={{ height: 14, width: `${100 - i * 5}%`, marginBottom: 4, borderRadius: 4 }} />
        ))}
      </div>
    )
  }

  if (error || sectors.length === 0) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
          {t('sectorPerformance')}
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
        {t('sectorPerformance')}
      </div>
      {sectors.map((s) => {
        const pct = s.market_cap_change_24h ?? 0
        const isUp = pct >= 0
        return (
          <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 11 }}>
            <span style={{ color: tokens.colors.text.primary, fontWeight: 500 }}>
              {SECTOR_LABELS[s.id] ?? s.name}
            </span>
            <span style={{ color: isUp ? 'var(--color-accent-success)' : 'var(--color-accent-error)', fontWeight: 600 }}>
              {isUp ? '+' : ''}{pct.toFixed(2)}%
            </span>
          </div>
        )
      })}
    </div>
  )
}
