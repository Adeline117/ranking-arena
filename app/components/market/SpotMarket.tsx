'use client'

import { useEffect, useState, useMemo } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useRealtimePrices, type PriceFlashInfo } from '@/lib/hooks/useRealtimePrices'
import MarketTable, { Column } from './MarketTable'
import Sparkline from './Sparkline'

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

interface SparklineEntry {
  id: string
  prices: number[]
  change7d: number | null
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
  const bg = value >= 0 ? 'var(--color-accent-success-10)' : 'var(--color-accent-error-10)'
  return (
    <span style={{
      color,
      fontWeight: 700,
      padding: '2px 8px',
      borderRadius: tokens.radius.sm,
      background: bg,
      fontSize: tokens.typography.fontSize.sm,
      fontFamily: 'var(--font-mono, monospace)',
      fontVariantNumeric: 'tabular-nums',
    } as React.CSSProperties}>
      {value >= 0 ? '+' : ''}{value.toFixed(2)}%
    </span>
  )
}

const CATEGORY_MAP: Record<string, string> = {
  BTC: 'L1', ETH: 'L1', SOL: 'L1', BNB: 'L1', ADA: 'L1', AVAX: 'L1', DOT: 'L1', NEAR: 'L1', ATOM: 'L1', SUI: 'L1', APT: 'L1', TRX: 'L1', TON: 'L1', XRP: 'L1',
  LINK: 'DeFi', UNI: 'DeFi', AAVE: 'DeFi', MKR: 'DeFi', CRV: 'DeFi', SNX: 'DeFi', COMP: 'DeFi', SUSHI: 'DeFi', DYDX: 'DeFi', LDO: 'DeFi',
  ARB: 'L2', OP: 'L2', MATIC: 'L2', STRK: 'L2', IMX: 'L2', MANTA: 'L2',
  DOGE: 'Meme', SHIB: 'Meme', PEPE: 'Meme', WIF: 'Meme', FLOKI: 'Meme', BONK: 'Meme',
  RNDR: 'AI', FET: 'AI', TAO: 'AI', AGIX: 'AI', WLD: 'AI',
  AXS: 'GameFi', GALA: 'GameFi', SAND: 'GameFi', MANA: 'GameFi',
  BLUR: 'NFT', APE: 'NFT',
  USDT: 'Stable', USDC: 'Stable', DAI: 'Stable',
  XLM: 'L1', ALGO: 'L1', ICP: 'L1', FIL: 'Infra', AR: 'Infra', THETA: 'Infra',
}

function FlashPrice({ value, flash }: { value: string; flash?: PriceFlashInfo }) {
  const bg = flash?.direction === 'up'
    ? 'var(--color-accent-success-20)'
    : flash?.direction === 'down'
      ? 'var(--color-accent-error-20)'
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

export default function SpotMarket({ onTokenClick, sectorFilter, initialData }: { onTokenClick?: (token: SpotCoin) => void; sectorFilter?: string | null; initialData?: SpotCoin[] } = {}) {
  const { t } = useLanguage()
  const [data, setData] = useState<SpotCoin[]>(initialData ?? [])
  const [loading, setLoading] = useState(!initialData?.length)
  const [search, setSearch] = useState('')
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [showFavOnly, setShowFavOnly] = useState(false)
  const [sparklines, setSparklines] = useState<Map<string, SparklineEntry>>(new Map())
  const { prices: realtimePrices, flashes } = useRealtimePrices({ enabled: true })

  useEffect(() => {
    fetch('/api/market/spot')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setData(d) })
      .catch(err => console.warn('[SpotMarket] fetch failed', err))
      .finally(() => setLoading(false))
  }, [])

  // Fetch 7-day sparkline data for top 50 coins (cached 4h on server, stale-while-revalidate)
  useEffect(() => {
    fetch('/api/market/sparklines')
      .then((r) => r.json())
      .then((d: unknown) => {
        if (!Array.isArray(d)) return
        const map = new Map<string, SparklineEntry>()
        ;(d as SparklineEntry[]).forEach((entry) => {
          if (entry && typeof entry.id === 'string') map.set(entry.id, entry)
        })
        setSparklines(map)
      })
      .catch(() => {/* sparklines are non-critical; fail silently */}) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [])

  useEffect(() => {
    try {
      const saved = localStorage.getItem('market_favorites')
      if (saved) setFavorites(new Set(JSON.parse(saved)))
    } catch { /* localStorage may be unavailable (SSR/private browsing) or data corrupted */ }
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
    if (sectorFilter) {
      list = list.filter((c) => (CATEGORY_MAP[c.symbol.toUpperCase()] || 'Other') === sectorFilter)
    }
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((c) => c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    }
    return list
  }, [merged, search, showFavOnly, favorites, sectorFilter])

  const columns: Column<SpotCoin>[] = [
    {
      key: 'rank',
      label: '#',
      align: 'center',
      width: '5%',
      sortable: true,
      render: (r) => <span style={{ color: tokens.colors.text.tertiary, fontWeight: 600 }}>{r.rank}</span>,
    },
    {
      key: 'symbol',
      label: t('tradingPair'),
      align: 'left',
      width: '20%',
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
      key: 'sparkline',
      label: '7D',
      align: 'center',
      width: '10%',
      sortable: false,
      render: (r) => {
        const entry = sparklines.get(r.id)
        if (!entry || entry.prices.length < 2) {
          return <span style={{ display: 'inline-block', width: 88, height: 34 }} />
        }
        return (
          <Sparkline
            prices={entry.prices}
            width={88}
            height={34}
            positive={entry.change7d !== null ? entry.change7d >= 0 : undefined}
          />
        )
      },
    },
    {
      key: 'price',
      label: t('lastPrice'),
      width: '16%',
      sortable: true,
      render: (r) => <FlashPrice value={formatPrice(r.price)} flash={flashes[r.symbol.toUpperCase()]} />,
    },
    {
      key: 'change24h',
      label: t('change24h'),
      width: '13%',
      sortable: true,
      render: (r) => <ChangeCell value={r.change24h} />,
    },
    {
      key: 'volume24h',
      label: t('volume24h'),
      width: '16%',
      sortable: true,
      render: (r) => (
        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: tokens.typography.fontSize.sm }}>
          {formatNum(r.volume24h)}
        </span>
      ),
    },
    {
      key: 'marketCap',
      label: t('marketCapShort'),
      width: '14%',
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
            title={t('favorite')}
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
            placeholder={t('searchCoin')}
            aria-label={t('searchCoin')}
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
            color: showFavOnly ? 'var(--color-text-primary)' : tokens.colors.text.secondary,
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
          {t('favorite')}
          {favorites.size > 0 && (
            <span style={{
              padding: '1px 6px',
              borderRadius: tokens.radius.full,
              background: showFavOnly ? 'var(--color-overlay-light)' : tokens.colors.bg.tertiary,
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
