'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface AlphaToken {
  id: string
  symbol: string
  name: string
  image: string
  price: number | null
  change24h: number | null
  volume24h: number | null
  marketCap: number | null
  rank: number | null
  score?: number
}

function formatNum(n: number | null): string {
  if (n == null) return '--'
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function TokenCard({ token }: { token: AlphaToken }) {
  const changeColor = (token.change24h ?? 0) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <div
      style={{
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.lg,
        padding: tokens.spacing[4],
        transition: tokens.transition.fast,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLElement).style.borderColor = tokens.colors.accent.primary
        ;(e.currentTarget as HTMLElement).style.background = tokens.colors.bg.hover
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLElement).style.borderColor = tokens.colors.border.primary
        ;(e.currentTarget as HTMLElement).style.background = tokens.colors.bg.secondary
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: tokens.spacing[3] }}>
        {token.image && (
          <Image src={token.image} alt={`${token.symbol || token.name || 'Token'} icon`} width={28} height={28} style={{ borderRadius: '50%' }} unoptimized />
        )}
        <div>
          <div style={{ fontWeight: 600, fontSize: tokens.typography.fontSize.base }}>{token.symbol}</div>
          <div style={{ color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.xs }}>{token.name}</div>
        </div>
        {token.rank && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
              background: tokens.colors.bg.tertiary,
              padding: `2px ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.sm,
            }}
          >
            #{token.rank}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: tokens.typography.fontFamily.mono.join(','), fontWeight: 600 }}>
          {token.price != null ? `$${token.price.toPrecision(4)}` : '--'}
        </span>
        <span style={{ color: changeColor, fontWeight: 500, fontSize: tokens.typography.fontSize.sm }}>
          {token.change24h != null ? `${token.change24h >= 0 ? '+' : ''}${token.change24h.toFixed(2)}%` : '--'}
        </span>
      </div>
      <div style={{ marginTop: tokens.spacing[2], fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary }}>
        {token.volume24h != null ? `Vol ${formatNum(token.volume24h)}` : ''}
        {token.marketCap != null ? ` / MCap ${formatNum(token.marketCap)}` : ''}
      </div>
    </div>
  )
}

export default function AlphaMarket() {
  const { t } = useLanguage()
  const [trending, setTrending] = useState<AlphaToken[]>([])
  const [volumeMovers, setVolumeMovers] = useState<AlphaToken[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/market/alpha')
      .then((r) => r.json())
      .then((d) => {
        if (d.trending) setTrending(d.trending)
        if (d.volumeMovers) setVolumeMovers(d.volumeMovers)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="skeleton" style={{ height: 400, borderRadius: tokens.radius.md }} />
  }

  const sectionTitle: React.CSSProperties = {
    fontSize: tokens.typography.fontSize.md,
    fontWeight: tokens.typography.fontWeight.semibold,
    color: tokens.colors.text.primary,
    marginBottom: tokens.spacing[3],
    paddingBottom: tokens.spacing[2],
    borderBottom: `1px solid ${tokens.colors.border.primary}`,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
      {/* Trending */}
      <div>
        <div style={sectionTitle}>{t('trendingTokens') || '热门代币'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacing[3] }}>
          {trending.map((tk) => (
            <TokenCard key={tk.id} token={tk} />
          ))}
        </div>
      </div>

      {/* Volume Movers */}
      <div>
        <div style={sectionTitle}>{t('highVolumeTokens') || '高成交量'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacing[3] }}>
          {volumeMovers.slice(0, 20).map((tk) => (
            <TokenCard key={tk.id} token={tk} />
          ))}
        </div>
      </div>
    </div>
  )
}
