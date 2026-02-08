'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

type CoinPrice = {
  id: string
  symbol: string
  price: number
  change24h: number
}

const DEFAULT_COINS = ['bitcoin', 'ethereum', 'solana', 'binancecoin', 'ripple']
const STORAGE_KEY = 'arena_watchlist'

type CoinOption = { id: string; symbol: string; name: string }

const FALLBACK_COIN_OPTIONS: CoinOption[] = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
  { id: 'solana', symbol: 'SOL', name: 'Solana' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB' },
  { id: 'ripple', symbol: 'XRP', name: 'XRP' },
  { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin' },
  { id: 'cardano', symbol: 'ADA', name: 'Cardano' },
  { id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche' },
  { id: 'polkadot', symbol: 'DOT', name: 'Polkadot' },
  { id: 'chainlink', symbol: 'LINK', name: 'Chainlink' },
  { id: 'sui', symbol: 'SUI', name: 'Sui' },
  { id: 'toncoin', symbol: 'TON', name: 'Toncoin' },
  { id: 'near', symbol: 'NEAR', name: 'NEAR' },
  { id: 'litecoin', symbol: 'LTC', name: 'Litecoin' },
  { id: 'aptos', symbol: 'APT', name: 'Aptos' },
  { id: 'tron', symbol: 'TRX', name: 'TRON' },
  { id: 'stellar', symbol: 'XLM', name: 'Stellar' },
  { id: 'uniswap', symbol: 'UNI', name: 'Uniswap' },
  { id: 'hedera-hashgraph', symbol: 'HBAR', name: 'Hedera' },
  { id: 'internet-computer', symbol: 'ICP', name: 'Internet Computer' },
  { id: 'render-token', symbol: 'RENDER', name: 'Render' },
  { id: 'kaspa', symbol: 'KAS', name: 'Kaspa' },
  { id: 'ethereum-classic', symbol: 'ETC', name: 'Ethereum Classic' },
  { id: 'aave', symbol: 'AAVE', name: 'Aave' },
  { id: 'filecoin', symbol: 'FIL', name: 'Filecoin' },
  { id: 'cosmos', symbol: 'ATOM', name: 'Cosmos' },
  { id: 'arbitrum', symbol: 'ARB', name: 'Arbitrum' },
  { id: 'optimism', symbol: 'OP', name: 'Optimism' },
  { id: 'injective-protocol', symbol: 'INJ', name: 'Injective' },
  { id: 'the-graph', symbol: 'GRT', name: 'The Graph' },
  { id: 'celestia', symbol: 'TIA', name: 'Celestia' },
  { id: 'sei-network', symbol: 'SEI', name: 'Sei' },
  { id: 'algorand', symbol: 'ALGO', name: 'Algorand' },
  { id: 'fantom', symbol: 'FTM', name: 'Fantom' },
  { id: 'matic-network', symbol: 'POL', name: 'Polygon' },
  { id: 'vechain', symbol: 'VET', name: 'VeChain' },
  { id: 'theta-token', symbol: 'THETA', name: 'Theta' },
  { id: 'lido-dao', symbol: 'LDO', name: 'Lido DAO' },
  { id: 'maker', symbol: 'MKR', name: 'Maker' },
  { id: 'mantle', symbol: 'MNT', name: 'Mantle' },
  { id: 'bonk', symbol: 'BONK', name: 'Bonk' },
  { id: 'pepe', symbol: 'PEPE', name: 'Pepe' },
  { id: 'floki', symbol: 'FLOKI', name: 'Floki' },
  { id: 'worldcoin-wld', symbol: 'WLD', name: 'Worldcoin' },
  { id: 'jupiter-exchange-solana', symbol: 'JUP', name: 'Jupiter' },
  { id: 'starknet', symbol: 'STRK', name: 'Starknet' },
  { id: 'pyth-network', symbol: 'PYTH', name: 'Pyth Network' },
  { id: 'ondo-finance', symbol: 'ONDO', name: 'Ondo' },
  { id: 'pendle', symbol: 'PENDLE', name: 'Pendle' },
  { id: 'wormhole', symbol: 'W', name: 'Wormhole' },
]

function getWatchlist(): string[] {
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
  const [watchIds, setWatchIds] = useState<string[]>(DEFAULT_COINS)
  const [coins, setCoins] = useState<CoinPrice[]>([])
  const [loading, setLoading] = useState(true)
  const [showPicker, setShowPicker] = useState(false)
  const [search, setSearch] = useState('')
  const [coinOptions, setCoinOptions] = useState<CoinOption[]>(FALLBACK_COIN_OPTIONS)

  useEffect(() => {
    setWatchIds(getWatchlist())
    // Fetch top 50 coins from CoinGecko for picker
    fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((data: any[]) => {
        const opts = data.map(c => ({ id: c.id, symbol: (c.symbol as string).toUpperCase(), name: c.name }))
        if (opts.length > 0) setCoinOptions(opts)
      })
      .catch(() => { /* keep fallback */ })
  }, [])

  const fetchPrices = useCallback(async (ids: string[]) => {
    if (ids.length === 0) { setCoins([]); setLoading(false); return }
    try {
      // Use our own /api/market proxy to avoid CoinGecko rate limits
      const pairsParam = ids.map(id => {
        const opt = FALLBACK_COIN_OPTIONS.find(c => c.id === id)
        return opt ? `${opt.symbol}-USD` : null
      }).filter(Boolean).join(',')

      const res = await fetch(`/api/market?pairs=${encodeURIComponent(pairsParam)}`)
      if (!res.ok) throw new Error('fetch failed')
      const data = await res.json()
      const rows = data.rows || []

      const results: CoinPrice[] = ids.map(id => {
        const opt = FALLBACK_COIN_OPTIONS.find(c => c.id === id)
        if (!opt) return null
        const row = rows.find((r: { symbol: string }) => r.symbol === `${opt.symbol}-USD`)
        if (!row) return null
        const price = parseFloat(row.price.replace(/,/g, '')) || 0
        const change = parseFloat(row.changePct) || 0
        return { id, symbol: opt.symbol, price, change24h: change }
      }).filter((r): r is CoinPrice => r !== null)

      setCoins(results)
    } catch {
      // Fallback: try CoinGecko directly
      try {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`
        )
        if (!res.ok) throw new Error('fallback failed')
        const data = await res.json()
        const results: CoinPrice[] = ids
          .filter(id => data[id])
          .map(id => {
            const opt = coinOptions.find(c => c.id === id)
            return { id, symbol: opt?.symbol || id.toUpperCase(), price: data[id].usd || 0, change24h: data[id].usd_24h_change || 0 }
          })
        setCoins(results)
      } catch {
        // silent fail, keep old data
      }
    } finally {
      setLoading(false)
    }
  }, [coinOptions])

  useEffect(() => {
    fetchPrices(watchIds)
    const interval = setInterval(() => fetchPrices(watchIds), 60000) // refresh every 60s
    return () => clearInterval(interval)
  }, [watchIds, fetchPrices])

  const toggleCoin = (coinId: string) => {
    setWatchIds(prev => {
      const next = prev.includes(coinId)
        ? prev.filter(id => id !== coinId)
        : [...prev, coinId]
      saveWatchlist(next)
      return next
    })
  }

  const filteredOptions = coinOptions.filter(c =>
    c.symbol.toLowerCase().includes(search.toLowerCase()) ||
    c.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <SidebarCard title={isZh ? '自选行情' : 'Watchlist'}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="skeleton" style={{ height: 40, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {coins.map((coin, idx) => (
              <div
                key={coin.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 4px',
                  borderBottom: idx < coins.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                  borderRadius: tokens.radius.sm,
                  transition: `background ${tokens.transition.fast}`,
                  cursor: 'pointer',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary }}>
                  {coin.symbol}
                </span>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: tokens.colors.text.primary }}>
                    ${coin.price.toLocaleString(undefined, { maximumFractionDigits: coin.price < 1 ? 4 : 2 })}
                  </div>
                  <div style={{
                    fontSize: 11, fontWeight: 600,
                    color: coin.change24h >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                  }}>
                    {coin.change24h >= 0 ? '+' : ''}{coin.change24h.toFixed(2)}%
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Add/Edit button */}
          <button
            onClick={() => setShowPicker(!showPicker)}
            style={{
              width: '100%', marginTop: 8, padding: '8px 0',
              background: 'transparent',
              border: `1px dashed ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.md,
              color: tokens.colors.text.secondary,
              fontSize: 12, fontWeight: 500,
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
            {showPicker
              ? (isZh ? '收起' : 'Close')
              : (isZh ? '+ 管理自选' : '+ Manage Watchlist')
            }
          </button>

          {/* Coin picker */}
          {showPicker && (
            <div style={{ marginTop: 8 }}>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={isZh ? '搜索币种...' : 'Search coins...'}
                style={{
                  width: '100%', padding: '6px 10px', marginBottom: 8,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: 12,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {filteredOptions.map(opt => {
                  const selected = watchIds.includes(opt.id)
                  return (
                    <button
                      key={opt.id}
                      onClick={() => toggleCoin(opt.id)}
                      style={{
                        padding: '4px 10px',
                        borderRadius: tokens.radius.full,
                        border: selected ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                        background: selected ? tokens.colors.accent.brand : 'transparent',
                        color: selected ? '#fff' : tokens.colors.text.secondary,
                        fontSize: 11, fontWeight: 500,
                        cursor: 'pointer',
                        transition: `all ${tokens.transition.fast}`,
                      }}
                    >
                      {opt.symbol}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
    </SidebarCard>
  )
}
