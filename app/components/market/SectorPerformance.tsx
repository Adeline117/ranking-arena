'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import type { CryptoCategory } from '@/lib/utils/coingecko'

/** Friendly sector names (Chinese-first, mapped from CoinGecko category IDs) */
const SECTOR_LABELS: Record<string, string> = {
  'layer-1': 'L1',
  'layer-2': 'L2',
  'decentralized-finance-defi': 'DeFi',
  'meme-token': 'Meme',
  'artificial-intelligence': 'AI',
  'gaming': 'GameFi',
  'real-world-assets-rwa': 'RWA',
  'decentralized-exchange-dex-token': 'DEX',
  'liquid-staking-tokens': 'LSD',
  'stablecoins': 'Stablecoin',
}

function formatMarketCap(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`
  return `$${value.toLocaleString()}`
}

export default function SectorPerformance() {
  const [sectors, setSectors] = useState<CryptoCategory[]>([])

  useEffect(() => {
    fetch('/api/market/sectors')
      .then((r) => r.json())
      .then((json) => {
        if (Array.isArray(json)) setSectors(json)
      })
      .catch(() => {})
  }, [])

  if (sectors.length === 0) return null

  // Find max market cap for bar scaling
  const maxCap = Math.max(...sectors.map((s) => s.market_cap || 0))

  return (
    <div
      style={{
        background: tokens.glass.bg.secondary,
        borderRadius: 12,
        padding: 14,
        border: tokens.glass.border.light,
      }}
    >
      <div style={{ color: tokens.colors.text.secondary, fontSize: 12, marginBottom: 10 }}>
        {t('sectorPerformance')}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sectors.map((sector) => {
          const pct = sector.market_cap_change_24h ?? 0
          const isUp = pct >= 0
          const barWidth = maxCap > 0 ? Math.max((sector.market_cap / maxCap) * 100, 4) : 4

          return (
            <div key={sector.id}>
              {/* Label row */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 2,
                }}
              >
                <span style={{ fontSize: 12, color: tokens.colors.text.primary, fontWeight: 600 }}>
                  {SECTOR_LABELS[sector.id] ?? sector.name}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: isUp ? '#16c784' : '#ea3943',
                  }}
                >
                  {isUp ? '+' : ''}{pct.toFixed(2)}%
                </span>
              </div>

              {/* Bar */}
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: tokens.colors.bg.primary,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${barWidth}%`,
                    borderRadius: 3,
                    background: isUp
                      ? 'linear-gradient(90deg, #16c784, #16c78466)'
                      : 'linear-gradient(90deg, #ea3943, #ea394366)',
                    transition: 'width 0.6s ease',
                  }}
                />
              </div>

              {/* Market cap label */}
              <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, marginTop: 1 }}>
                {formatMarketCap(sector.market_cap)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
