'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type CoinPrice = {
  symbol: string
  price: number
  change24h: number
}

// Mock data — replace with real API (e.g. CoinGecko) later
const MOCK_COINS: CoinPrice[] = [
  { symbol: 'BTC', price: 97842.5, change24h: 2.34 },
  { symbol: 'ETH', price: 3412.8, change24h: -0.87 },
  { symbol: 'SOL', price: 198.45, change24h: 5.12 },
  { symbol: 'BNB', price: 612.3, change24h: 1.05 },
  { symbol: 'XRP', price: 2.41, change24h: -1.23 },
  { symbol: 'DOGE', price: 0.342, change24h: 3.45 },
]

export default function WatchlistMarket() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [coins] = useState<CoinPrice[]>(MOCK_COINS)

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 12 }}>
        📈 {isZh ? '自选行情' : 'Watchlist'}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {coins.map(coin => (
          <div
            key={coin.symbol}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 4px', borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary }}>
              {coin.symbol}
            </span>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: tokens.colors.text.primary }}>
                ${coin.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
              <div style={{
                fontSize: 11, fontWeight: 600,
                color: coin.change24h >= 0 ? '#22c55e' : '#ef4444',
              }}>
                {coin.change24h >= 0 ? '+' : ''}{coin.change24h.toFixed(2)}%
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
