'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

const STORAGE_KEY = 'watchlist_coins'

const DEFAULT_COINS = ['bitcoin', 'ethereum', 'solana', 'binancecoin']

// CoinGecko id -> display symbol
const COIN_MAP: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  binancecoin: 'BNB',
  ripple: 'XRP',
  dogecoin: 'DOGE',
  cardano: 'ADA',
  polkadot: 'DOT',
  avalanche: 'AVAX',
  'matic-network': 'MATIC',
  chainlink: 'LINK',
  tron: 'TRX',
  litecoin: 'LTC',
  uniswap: 'UNI',
  'shiba-inu': 'SHIB',
  'the-open-network': 'TON',
  sui: 'SUI',
  aptos: 'APT',
  near: 'NEAR',
  arbitrum: 'ARB',
  optimism: 'OP',
  celestia: 'TIA',
  jupiter: 'JUP',
  render: 'RNDR',
}

type CoinPrice = {
  id: string
  symbol: string
  price: number
  change24h: number
}

function getStoredWatchlist(): string[] {
  if (typeof window === 'undefined') return DEFAULT_COINS
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_COINS
    }
  } catch { /* ignore */ }
  return DEFAULT_COINS
}

function saveWatchlist(ids: string[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}

export default function WatchlistMarket() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [watchlist, setWatchlist] = useState<string[]>(() => getStoredWatchlist())
  const [prices, setPrices] = useState<Record<string, { usd: number; usd_24h_change: number }>>({})
  const [loading, setLoading] = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const fetchPrices = useCallback(async (ids: string[]) => {
    if (ids.length === 0) { setPrices({}); setLoading(false); return }
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`
      )
      if (res.ok) {
        const data = await res.json()
        setPrices(data)
      }
    } catch { /* silent */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchPrices(watchlist)
    const interval = setInterval(() => fetchPrices(watchlist), 60000)
    return () => clearInterval(interval)
  }, [watchlist, fetchPrices])

  useEffect(() => {
    if (showSearch && searchRef.current) searchRef.current.focus()
  }, [showSearch])

  const addCoin = (id: string) => {
    if (watchlist.includes(id)) return
    const next = [...watchlist, id]
    setWatchlist(next)
    saveWatchlist(next)
    setShowSearch(false)
    setSearchQuery('')
  }

  const removeCoin = (id: string) => {
    const next = watchlist.filter(c => c !== id)
    setWatchlist(next)
    saveWatchlist(next)
  }

  const coins: CoinPrice[] = watchlist.map(id => {
    const p = prices[id]
    return {
      id,
      symbol: COIN_MAP[id] || id.toUpperCase().slice(0, 5),
      price: p?.usd ?? 0,
      change24h: p?.usd_24h_change ?? 0,
    }
  })

  const searchResults = Object.entries(COIN_MAP)
    .filter(([id, sym]) =>
      !watchlist.includes(id) &&
      (id.includes(searchQuery.toLowerCase()) || sym.toLowerCase().includes(searchQuery.toLowerCase()))
    )
    .slice(0, 6)

  const formatPrice = (price: number) => {
    if (price >= 1) return price.toLocaleString(undefined, { maximumFractionDigits: 2 })
    if (price >= 0.01) return price.toFixed(4)
    return price.toFixed(6)
  }

  return (
    <SidebarCard title={isZh ? '自选行情' : 'Watchlist'}>
      {loading && coins.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="skeleton" style={{ height: 40, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : coins.length === 0 ? (
        <div
          style={{
            padding: '16px 0',
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
            cursor: 'pointer',
          }}
          onClick={() => setShowSearch(true)}
        >
          {isZh ? '点击添加自选币种' : 'Click to add coins'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {coins.map((coin, idx) => (
            <div
              key={coin.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 6px',
                borderBottom: idx < coins.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                borderRadius: tokens.radius.sm,
                transition: `background ${tokens.transition.fast}`,
                cursor: 'pointer',
                position: 'relative',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  color: tokens.colors.text.primary,
                }}
              >
                {coin.symbol}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ textAlign: 'right' }}>
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.medium,
                      color: tokens.colors.text.primary,
                    }}
                  >
                    ${formatPrice(coin.price)}
                  </div>
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: tokens.typography.fontWeight.semibold,
                      color: coin.change24h >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                    }}
                  >
                    {coin.change24h >= 0 ? '+' : ''}{coin.change24h.toFixed(2)}%
                  </div>
                </div>
                {/* Remove button */}
                <button
                  onClick={e => { e.stopPropagation(); removeCoin(coin.id) }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: tokens.colors.text.tertiary,
                    fontSize: tokens.typography.fontSize.xs,
                    padding: '2px 4px',
                    borderRadius: tokens.radius.sm,
                    transition: `color ${tokens.transition.fast}`,
                    opacity: 0.4,
                    lineHeight: 1,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = tokens.colors.accent.error }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = '0.4'; e.currentTarget.style.color = tokens.colors.text.tertiary }}
                  title={isZh ? '移除' : 'Remove'}
                >
                  x
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add button / search */}
      {showSearch ? (
        <div style={{ marginTop: 8 }}>
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={isZh ? '搜索币种...' : 'Search coin...'}
            style={{
              width: '100%',
              padding: '6px 10px',
              fontSize: tokens.typography.fontSize.sm,
              background: tokens.colors.bg.tertiary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.md,
              color: tokens.colors.text.primary,
              outline: 'none',
              boxSizing: 'border-box',
            }}
            onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') } }}
          />
          {searchResults.length > 0 && (
            <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 0 }}>
              {searchResults.map(([id, sym]) => (
                <div
                  key={id}
                  onClick={() => addCoin(id)}
                  style={{
                    padding: '6px 10px',
                    fontSize: tokens.typography.fontSize.sm,
                    color: tokens.colors.text.primary,
                    cursor: 'pointer',
                    borderRadius: tokens.radius.sm,
                    transition: `background ${tokens.transition.fast}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ fontWeight: tokens.typography.fontWeight.medium }}>{sym}</span>
                  <span style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                    {id}
                  </span>
                </div>
              ))}
            </div>
          )}
          {searchQuery && searchResults.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
              {isZh ? '未找到匹配币种' : 'No matching coins'}
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={() => setShowSearch(true)}
          style={{
            marginTop: 8,
            width: '100%',
            padding: '6px 0',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            color: tokens.colors.text.secondary,
            background: 'none',
            border: `1px dashed ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            cursor: 'pointer',
            transition: `all ${tokens.transition.fast}`,
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = tokens.colors.accent.brand
            e.currentTarget.style.color = tokens.colors.accent.brand
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = tokens.colors.border.primary
            e.currentTarget.style.color = tokens.colors.text.secondary
          }}
        >
          + {isZh ? '添加' : 'Add'}
        </button>
      )}
    </SidebarCard>
  )
}
