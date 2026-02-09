'use client'

import { useEffect, useState, useMemo } from 'react'
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
  const bg = value >= 0 ? 'rgba(47, 229, 125, 0.1)' : 'rgba(255, 124, 124, 0.1)'
  return (
    <span style={{
      color,
      fontWeight: 700,
      padding: '2px 8px',
      borderRadius: tokens.radius.sm,
      background: bg,
      fontSize: tokens.typography.fontSize.sm,
    }}>
      {value >= 0 ? '+' : ''}{value.toFixed(2)}%
    </span>
  )
}

function FlashPrice({ value, flash }: { value: string; flash?: PriceFlashInfo }) {
  const bg = flash?.direction === 'up'
    ? 'rgba(47, 229, 125, 0.2)'
    : flash?.direction === 'down'
      ? 'rgba(255, 124, 124, 0.2)'
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
        borderRadius: tokens.radius.sm,
        padding: '1px 4px',
        fontWeight: 600,
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
  const [showFavOnly, setShowFavOnly] = useState(false)
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
    let list = merged
    if (showFavOnly) list = list.filter((c) => favorites.has(c.id))
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((c) => c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    }
    return list
  }, [merged, search, showFavOnly, favorites])

  const columns: Column<SpotCoin>[] = [
    {
      key: 'rank',
      label: '#',
      align: 'center',
      width: '6%',
      sortable: true,
      render: (r) => <span style={{ color: tokens.colors.text.tertiary, fontWeight: 600 }}>{r.rank}</span>,
    },
    {
      key: 'symbol',
      label: t('tradingPair') || '交易对',
      align: 'left',
      width: '22%',
      sortable: true,
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          {r.image ? (
            <Image
              src={r.image}
              alt={`${r.symbol} icon`}
              width={22}
              height={22}
              style={{ borderRadius: '50%', flexShrink: 0 }}
              unoptimized={false}
            />
          ) : (
            <span style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: tokens.colors.bg.tertiary,
              flexShrink: 0,
              display: 'inline-block',
            }} />
          )}
          <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.symbol}
          </span>
          <span style={{
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {r.name}
          </span>
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
      render: (r) => (
        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: tokens.typography.fontSize.sm }}>
          {formatNum(r.volume24h)}
        </span>
      ),
    },
    {
      key: 'marketCap',
      label: t('marketCapShort') || '市值',
      width: '16%',
      sortable: true,
      render: (r) => (
        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: tokens.typography.fontSize.sm }}>
          {formatNum(r.marketCap)}
        </span>
      ),
    },
    {
      key: 'fav',
      label: '',
      width: '6%',
      align: 'center',
      render: (r) => {
        const isFav = favorites.has(r.id)
        return (
          <button
            onClick={(e) => { e.stopPropagation(); toggleFav(r.id) }}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: isFav ? tokens.colors.accent.warning : tokens.colors.text.tertiary,
              fontSize: 18,
              padding: 4,
              minWidth: 44,
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: tokens.radius.md,
              transition: `all ${tokens.transition.fast}`,
            }}
            title={t('favorite') || '收藏'}
          >
            {isFav ? '\u2605' : '\u2606'}
          </button>
        )
      },
    },
  ]

  return (
    <div>
      {/* Search & Filter Bar */}
      <div style={{
        marginBottom: tokens.spacing[4],
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
      }}>
        {/* Search input with icon */}
        <div style={{
          position: 'relative',
          flex: 1,
          maxWidth: 360,
        }}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke={tokens.colors.text.tertiary}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              position: 'absolute',
              left: 14,
              top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
            }}
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchCoin') || '搜索币种...'}
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]} ${tokens.spacing[3]} 40px`,
              background: tokens.glass.bg.medium,
              border: tokens.glass.border.light,
              borderRadius: tokens.radius.lg,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              width: '100%',
              outline: 'none',
              transition: `all ${tokens.transition.fast}`,
              minHeight: 44,
              backdropFilter: tokens.glass.blur.sm,
            }}
          />
        </div>

        {/* Favorites button */}
        <button
          onClick={() => setShowFavOnly((v) => !v)}
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
            background: showFavOnly ? tokens.colors.accent.warning : tokens.glass.bg.medium,
            color: showFavOnly ? '#000' : tokens.colors.text.secondary,
            border: showFavOnly ? 'none' : tokens.glass.border.light,
            borderRadius: tokens.radius.lg,
            cursor: 'pointer',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            transition: `all ${tokens.transition.fast}`,
            minHeight: 44,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            backdropFilter: tokens.glass.blur.sm,
          }}
        >
          <span style={{ fontSize: 16 }}>{showFavOnly ? '\u2605' : '\u2606'}</span>
          {'收藏'}
          {favorites.size > 0 && (
            <span style={{
              padding: '1px 6px',
              borderRadius: tokens.radius.full,
              background: showFavOnly ? 'rgba(0,0,0,0.15)' : tokens.colors.bg.tertiary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: 700,
            }}>
              {favorites.size}
            </span>
          )}
        </button>
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
