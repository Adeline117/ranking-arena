'use client'

import { useEffect, useState, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
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

export default function SpotMarket() {
  const { t } = useLanguage()
  const [data, setData] = useState<SpotCoin[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [favorites, setFavorites] = useState<Set<string>>(new Set())

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
    } catch {}
  }, [])

  const toggleFav = (id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      localStorage.setItem('market_favorites', JSON.stringify([...next]))
      return next
    })
  }

  const filtered = useMemo(() => {
    if (!search) return data
    const q = search.toLowerCase()
    return data.filter((c) => c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
  }, [data, search])

  const columns: Column<SpotCoin>[] = [
    {
      key: 'rank',
      label: '#',
      align: 'center',
      width: '50px',
      sortable: true,
      render: (r) => <span style={{ color: tokens.colors.text.tertiary }}>{r.rank}</span>,
    },
    {
      key: 'symbol',
      label: t('tradingPair') || '交易对',
      align: 'left',
      sortable: true,
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {r.image && (
            <img src={r.image} alt="" width={20} height={20} style={{ borderRadius: '50%' }} loading="lazy" />
          )}
          <span style={{ fontWeight: 600 }}>{r.symbol}</span>
          <span style={{ color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.xs }}>/USDT</span>
        </span>
      ),
      getValue: (r) => r.symbol,
    },
    {
      key: 'price',
      label: t('lastPrice') || '最新价',
      sortable: true,
      render: (r) => <span style={{ fontFamily: tokens.typography.fontFamily.mono.join(',') }}>{formatPrice(r.price)}</span>,
    },
    {
      key: 'change24h',
      label: t('change24h') || '24h涨跌',
      sortable: true,
      render: (r) => <ChangeCell value={r.change24h} />,
    },
    {
      key: 'high24h',
      label: t('high24h') || '24h最高',
      sortable: true,
      render: (r) => <span>{formatPrice(r.high24h)}</span>,
    },
    {
      key: 'low24h',
      label: t('low24h') || '24h最低',
      sortable: true,
      render: (r) => <span>{formatPrice(r.low24h)}</span>,
    },
    {
      key: 'volume24h',
      label: t('volume24h') || '24h成交量',
      sortable: true,
      render: (r) => <span>{formatNum(r.volume24h)}</span>,
    },
    {
      key: 'marketCap',
      label: t('marketCapShort') || '市值',
      sortable: true,
      render: (r) => <span>{formatNum(r.marketCap)}</span>,
    },
    {
      key: 'fav',
      label: '',
      width: '40px',
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
      />
    </div>
  )
}
