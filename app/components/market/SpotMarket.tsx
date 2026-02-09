'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useRealtimePrices, type PriceFlashInfo } from '@/lib/hooks/useRealtimePrices'
import MarketTable, { Column } from './MarketTable'

interface SpotCoin {
  id: string
  symbol: string
  name: string
  image: string
  price: number
  change24h: number
  high24h: number
  low24h: number
  volume24h: number
  marketCap: number
  rank: number
}

function formatNum(n: number | null, decimals = 2): string {
  if (n == null) return '--'
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(decimals)}`
}

function formatPrice(n: number | null): string {
  if (n == null) return '--'
  if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${n.toPrecision(4)}`
}

function ChangeCell({ value }: { value: number | null }) {
  if (value == null) return <span>--</span>
  const color = value >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  return <span style={{ color, fontWeight: 500 }}>{value >= 0 ? '+' : ''}{value.toFixed(2)}%</span>
}

function FlashPrice({ value, flash }: { value: string; flash?: PriceFlashInfo }) {
  const bg = flash?.direction === 'up'
    ? 'rgba(22, 199, 132, 0.25)'
    : flash?.direction === 'down'
      ? 'rgba(234, 57, 67, 0.25)'
      : 'transparent'
  const color = flash?.direction === 'up'
    ? tokens.colors.accent.success
    : flash?.direction === 'down'
      ? tokens.colors.accent.error
      : undefined

  return (
    <span
      style={{
        fontFamily: tokens.typography.fontFamily.mono.join(','),
        transition: 'background-color 0.3s ease, color 0.3s ease',
        backgroundColor: bg,
        color,
        borderRadius: 3,
        padding: '0 2px',
      }}
    >
      {value}
    </span>
  )
}

export default function SpotMarket({ onTokenClick }: { onTokenClick?: (token: SpotCoin) => void } = {}) {
  const { t } = useLanguage()
  const [data, setData] = useState<SpotCoin[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const { prices: realtimePrices, flashes } = useRealtimePrices({ enabled: true })

  useEffect(() => {
    fetch('/api/market/spot')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setData(d) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    try {
      const saved = localStorage.getItem('market_favorites')
      if (saved) setFavorites(new Set(JSON.parse(saved)))
    } catch { /* ignore */ }
  }, [])

  const toggleFav = (id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      localStorage.setItem('market_favorites', JSON.stringify([...next]))
      return next
    })
  }

  // Merge realtime prices into data
  const merged = useMemo(() => {
    return data.map((coin) => {
      const rt = realtimePrices[coin.symbol.toUpperCase()]
      if (!rt) return coin
      return {
        ...coin,
        price: rt.price ?? coin.price,
        change24h: rt.change24h ?? coin.change24h,
      }
    })
  }, [data, realtimePrices])

  const filtered = useMemo(() => {
    if (!search) return merged
    const q = search.toLowerCase()
    return merged.filter((c) => c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
  }, [merged, search])

  const columns: Column<SpotCoin>[] = [
    {
      key: 'rank',
      label: '#',
      align: 'center',
      width: '6%',
      sortable: true,
      render: (r) => <span style={{ color: tokens.colors.text.tertiary }}>{r.rank}</span>,
    },
    {
      key: 'symbol',
      label: t('tradingPair') || '交易对',
      align: 'left',
      width: '22%',
      sortable: true,
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          {r.image ? (
            <Image
              src={r.image}
              alt={`${r.symbol} icon`}
              width={20}
              height={20}
              style={{ borderRadius: '50%', flexShrink: 0 }}
              unoptimized={false}
            />
          ) : (
            <span style={{ width: 20, height: 20, borderRadius: '50%', background: tokens.colors.bg.tertiary, flexShrink: 0, display: 'inline-block' }} />
          )}
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.symbol}</span>
          <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
        </span>
      ),
      getValue: (r) => r.symbol,
    },
    {
      key: 'price',
      label: t('lastPrice') || '最新价',
      width: '18%',
      sortable: true,
      render: (r) => <FlashPrice value={formatPrice(r.price)} flash={flashes[r.symbol.toUpperCase()]} />,
    },
    {
      key: 'change24h',
      label: t('change24h') || '24h涨跌',
      width: '14%',
      sortable: true,
      render: (r) => <ChangeCell value={r.change24h} />,
    },
    {
      key: 'volume24h',
      label: t('volume24h') || '成交量',
      width: '18%',
      sortable: true,
      render: (r) => <span>{formatNum(r.volume24h)}</span>,
    },
    {
      key: 'marketCap',
      label: t('marketCapShort') || '市值',
      width: '16%',
      sortable: true,
      render: (r) => <span>{formatNum(r.marketCap)}</span>,
    },
    {
      key: 'fav',
      label: '',
      width: '6%',
      align: 'center',
      render: (r) => (
        <button
          onClick={(e) => { e.stopPropagation(); toggleFav(r.id) }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: favorites.has(r.id) ? tokens.colors.accent.warning : tokens.colors.text.tertiary,
            fontSize: 16,
            padding: 0,
          }}
          title={t('favorite') || '收藏'}
        >
          {favorites.has(r.id) ? '\u2605' : '\u2606'}
        </button>
      ),
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: tokens.spacing[3] }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchCoin') || '搜索币种'}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            background: tokens.colors.bg.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            width: '100%',
            maxWidth: 320,
            outline: 'none',
          }}
        />
      </div>
      <MarketTable
        columns={columns}
        data={filtered}
        loading={loading}
        defaultSortKey="rank"
        defaultSortDir="asc"
        rowKey={(r) => r.id}
        onRowClick={onTokenClick}
      />
    </div>
  )
}
