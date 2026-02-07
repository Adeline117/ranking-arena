'use client'

import { useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

type NewsItem = {
  id: string
  title: string
  time: string
  source: string
}

const MOCK_NEWS: NewsItem[] = [
  { id: '1', title: 'Bitcoin ETF inflows surge past $1B in single day', time: '5m ago', source: 'CoinDesk' },
  { id: '2', title: 'Ethereum Pectra upgrade scheduled for Q1 2026', time: '18m ago', source: 'The Block' },
  { id: '3', title: 'Solana DEX volume hits new ATH', time: '32m ago', source: 'DeFiLlama' },
  { id: '4', title: 'SEC approves new crypto exchange application', time: '1h ago', source: 'Reuters' },
  { id: '5', title: 'MicroStrategy adds 15,000 BTC to treasury', time: '2h ago', source: 'Bloomberg' },
]

export default function NewsFlash() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [news] = useState<NewsItem[]>(MOCK_NEWS)

  return (
    <SidebarCard title={isZh ? '快讯' : 'News Flash'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {news.map((item, idx) => (
          <div
            key={item.id}
            style={{
              padding: '10px 4px',
              borderBottom: idx < news.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
            }}
          >
            <p style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.4, marginBottom: 4 }}>
              {item.title}
            </p>
            <div style={{ display: 'flex', gap: 8, fontSize: 11, color: tokens.colors.text.secondary }}>
              <span>{item.source}</span>
              <span>{item.time}</span>
            </div>
          </div>
        ))}
      </div>
      <Link
        href="/flash-news"
        style={{
          display: 'block', textAlign: 'center', marginTop: tokens.spacing[2],
          fontSize: 12, color: tokens.colors.accent.primary, textDecoration: 'none',
          padding: `${tokens.spacing[1]} 0`,
        }}
      >
        {isZh ? '查看全部' : 'View All'}
      </Link>
    </SidebarCard>
  )
}
