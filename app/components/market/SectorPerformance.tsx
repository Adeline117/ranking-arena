'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { CryptoCategory } from '@/lib/utils/coingecko'
import { uiLogger } from '@/lib/utils/logger'

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

export default function SectorPerformance() {
  const { t } = useLanguage()
  const [sectors, setSectors] = useState<CryptoCategory[]>([])

  useEffect(() => {
    fetch('/api/market/sectors')
      .then((r) => r.json())
      .then((json) => { if (Array.isArray(json)) setSectors(json.slice(0, 4)) })
      .catch(err => console.warn('[SectorPerformance] fetch failed', err))
  }, [])

  if (sectors.length === 0) return null

  return (
    <div style={{
      padding: '10px 12px',
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.md,
      border: tokens.glass.border.light,
    }}>
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
