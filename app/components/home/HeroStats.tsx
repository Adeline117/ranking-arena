'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

interface Stats {
  traderCount: number
  exchangeCount: number
}

function formatCount(n: number): string {
  if (n >= 1000) {
    const k = Math.floor(n / 1000)
    return `${k.toLocaleString()},000+`
  }
  return String(n)
}

export default function HeroStats() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [stats, setStats] = useState<Stats>({ traderCount: 31000, exchangeCount: 16 })

  useEffect(() => {
    fetch('/api/stats')
      .then(r => r.json())
      .then((data: Stats) => {
        if (data.traderCount) setStats(data)
      })
      .catch(() => {})
  }, [])

  const items = [
    { value: formatCount(stats.traderCount), label: isZh ? '交易员' : 'Traders' },
    { value: String(stats.exchangeCount), label: isZh ? '交易所' : 'Exchanges' },
    { value: '24/7', label: isZh ? '实时排名' : 'Live Rankings' },
  ]

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        gap: 32,
        flexWrap: 'wrap',
      }}
    >
      {items.map((stat) => (
        <div key={stat.label} style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: 24,
              fontWeight: 800,
              color: tokens.colors.accent.brand,
              lineHeight: 1.2,
            }}
          >
            {stat.value}
          </div>
          <div
            style={{
              fontSize: 13,
              color: tokens.colors.text.tertiary,
              marginTop: 2,
            }}
          >
            {stat.label}
          </div>
        </div>
      ))}
    </div>
  )
}
