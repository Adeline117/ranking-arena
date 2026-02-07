'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type NewsItem = {
  id: string
  title: string
  time: string
  source: string
}

// Mock data — replace with real news API later
const MOCK_NEWS: NewsItem[] = [
  { id: '1', title: 'Bitcoin ETF inflows surge past $1B in single day', time: '5m ago', source: 'CoinDesk' },
  { id: '2', title: 'Ethereum Pectra upgrade scheduled for Q1 2026', time: '18m ago', source: 'The Block' },
  { id: '3', title: 'Solana DEX volume hits new ATH', time: '32m ago', source: 'DeFiLlama' },
  { id: '4', title: 'SEC approves new crypto exchange application', time: '1h ago', source: 'Reuters' },
  { id: '5', title: 'MicroStrategy adds 15,000 BTC to treasury', time: '2h ago', source: 'Bloomberg' },
  { id: '6', title: 'Binance launches new institutional trading desk', time: '3h ago', source: 'Binance' },
  { id: '7', title: 'Layer 2 TVL crosses $50B milestone', time: '4h ago', source: 'L2Beat' },
  { id: '8', title: 'Fed signals potential rate cut in March', time: '5h ago', source: 'CNBC' },
]

export default function NewsFlash() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [news] = useState<NewsItem[]>(MOCK_NEWS)

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 12 }}>
        ⚡ {isZh ? '快讯' : 'News Flash'}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {news.map(item => (
          <div
            key={item.id}
            style={{
              padding: '10px 4px',
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <p style={{
              fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.4,
              marginBottom: 4,
            }}>
              {item.title}
            </p>
            <div style={{ display: 'flex', gap: 8, fontSize: 11, color: tokens.colors.text.secondary }}>
              <span>{item.source}</span>
              <span>· {item.time}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
