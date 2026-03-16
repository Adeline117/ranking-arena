'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'

const HERO_SEEN_KEY = 'arena_hero_seen'

function formatCount(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K+`
  return `${n}+`
}

export default function HomeHero() {
  const { language } = useLanguage()
  const [show, setShow] = useState(false)
  const [traderCount, setTraderCount] = useState('—')
  const [exchangeCount, setExchangeCount] = useState('—')

  useEffect(() => {
    if (!sessionStorage.getItem(HERO_SEEN_KEY)) {
      setShow(true)
    }
    supabase.from('trader_sources').select('source', { count: 'exact' })
      .then(({ data, count }) => {
        if (count) setTraderCount(formatCount(count))
        if (data) {
          const platforms = new Set(data.map((r: { source: string }) => r.source.split('_')[0]))
          setExchangeCount(`${platforms.size}+`)
        }
      })
  }, [])

  if (!show) return null

  const dismiss = () => {
    setShow(false)
    sessionStorage.setItem(HERO_SEEN_KEY, '1')
  }

  return (
    <div
      style={{
        padding: `${tokens.spacing[8]} ${tokens.spacing[6]}`,
        marginBottom: tokens.spacing[4],
        background: `linear-gradient(135deg, var(--color-accent-primary-08) 0%, transparent 50%, var(--color-accent-primary-08) 100%)`,
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary)',
        position: 'relative',
        textAlign: 'center',
      }}
    >
      <button
        onClick={dismiss}
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          background: 'none',
          border: 'none',
          color: 'var(--color-text-tertiary)',
          cursor: 'pointer',
          fontSize: 18,
          lineHeight: 1,
          padding: 4,
          minWidth: 44,
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        aria-label="Dismiss"
      >
        ×
      </button>

      <h2 style={{
        fontSize: tokens.typography.fontSize['2xl'],
        fontWeight: tokens.typography.fontWeight.black,
        color: 'var(--color-text-primary)',
        marginBottom: tokens.spacing[2],
        lineHeight: tokens.typography.lineHeight.tight,
      }}>
        {language === 'zh'
          ? '发现全球顶尖加密交易员'
          : 'Discover the World\'s Top Crypto Traders'}
      </h2>

      <p style={{
        fontSize: tokens.typography.fontSize.base,
        color: 'var(--color-text-secondary)',
        marginBottom: tokens.spacing[5],
        maxWidth: 560,
        margin: `0 auto ${tokens.spacing[5]}`,
        lineHeight: tokens.typography.lineHeight.normal,
      }}>
        {language === 'zh'
          ? `跨 ${exchangeCount} 交易所追踪 ${traderCount} 交易员表现，用 Arena Score 找到最优秀的交易员`
          : `Track ${traderCount} traders across ${exchangeCount} exchanges. Find top performers with Arena Score.`}
      </p>

      <div style={{
        display: 'flex',
        justifyContent: 'center',
        gap: 'clamp(16px, 4vw, 32px)',
        flexWrap: 'wrap',
      }}>
        {[
          { value: traderCount, label: language === 'zh' ? '交易员' : 'Traders' },
          { value: exchangeCount, label: language === 'zh' ? '交易所' : 'Exchanges' },
          { value: '24/7', label: language === 'zh' ? '实时更新' : 'Live Data' },
        ].map((stat) => (
          <div key={stat.label} style={{ textAlign: 'center' }}>
            <div style={{
              fontSize: tokens.typography.fontSize.xl,
              fontWeight: tokens.typography.fontWeight.black,
              color: 'var(--color-accent-primary)',
              fontVariantNumeric: 'tabular-nums',
              ...(stat.value === '—' ? {
                animation: 'hero-pulse 1.5s ease-in-out infinite',
                borderRadius: 4,
                minWidth: 40,
              } : {}),
            }}>
              {stat.value}
            </div>
            <div style={{
              fontSize: tokens.typography.fontSize.xs,
              color: 'var(--color-text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 600,
            }}>
              {stat.label}
            </div>
          </div>
        ))}
      </div>
      <style>{`@keyframes hero-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </div>
  )
}
