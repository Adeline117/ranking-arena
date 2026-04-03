'use client'

import { useState, useEffect, useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import useSWR from 'swr'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import { useDeferredKey } from '@/lib/hooks/useDeferredSWR'

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
  const { t } = useLanguage()
  const [watchIds, setWatchIds] = useState<string[]>(DEFAULT_COINS)
  const [showPicker, setShowPicker] = useState(false)
  const [search, setSearch] = useState('')
  const coinOptions = FALLBACK_COIN_OPTIONS

  useEffect(() => {
    setWatchIds(getWatchlist())
  }, [])

  // Build pairs param for SWR key
  const pairsParam = watchIds.map(id => {
    const opt = FALLBACK_COIN_OPTIONS.find(c => c.id === id)
    return opt ? `${opt.symbol}-USD` : null
  }).filter(Boolean).join(',')

  const marketFetcher = useCallback(async (url: string): Promise<CoinPrice[]> => {
    try {
      const res = await fetch(url)
      // On non-200, return empty array instead of throwing — stale data or "–" is
      // better than a visible error state in the sidebar.
      if (!res.ok) return []
      const data = await res.json()
      // Handle both { rows: [...] } envelope and plain error objects gracefully
      if (!data || typeof data !== 'object') return []
      const rows = Array.isArray(data.rows) ? data.rows : []
      if (rows.length === 0) return []

      return watchIds.map(id => {
        const opt = FALLBACK_COIN_OPTIONS.find(c => c.id === id)
        if (!opt) return null
        const row = rows.find((r: { symbol: string }) => r.symbol === `${opt.symbol}-USD`)
        if (!row) return null
        const price = parseFloat(String(row.price ?? '').replace(/,/g, '')) || 0
        const change = parseFloat(String(row.changePct ?? '')) || 0
        return { id, symbol: opt.symbol, price, change24h: change }
      }).filter((r): r is CoinPrice => r !== null)
    } catch {
      // Network error or parse failure — return empty array to avoid error state
      return []
    }
  }, [watchIds])

  // Defer SWR key until after LCP — prevents simultaneous sidebar fetches from blocking main thread
  const immediateKey = pairsParam ? `/api/market?pairs=${encodeURIComponent(pairsParam)}` : null
  const swrKey = useDeferredKey(immediateKey, 1200)

  const { data: coins = [], isLoading: loading, error: swrError, mutate: mutateMarket } = useSWR(
    swrKey,
    marketFetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
      refreshInterval: 60000, // Refresh every 60s
      keepPreviousData: true,
      errorRetryCount: 3,
      errorRetryInterval: 5000,
      // Suppress error state propagation — fetcher returns [] on failure, so this
      // only fires for genuine network-level throws (which we already catch).
      onError: () => { /* silently ignore; UI shows keepPreviousData or empty state */ },
    }
  )

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

  const handleRowEnter = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.background = tokens.colors.bg.tertiary
  }, [])
  const handleRowLeave = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.background = 'transparent'
  }, [])

  return (
    <SidebarCard title={t('sidebarWatchlist')}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="skeleton" style={{ height: 40, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : swrError ? (
        <div style={{ padding: `${tokens.spacing[3]} 0`, textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm }}>
          <div>{t('sidebarLoadFailedShort')}</div>
          <button
            onClick={() => mutateMarket()}
            style={{ marginTop: 6, padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.sm, border: `1px solid ${tokens.colors.border.primary}`, background: 'transparent', color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.xs, cursor: 'pointer' }}
          >
            {t('retry') || 'Retry'}
          </button>
        </div>
      ) : coins.length === 0 ? (
        <div style={{ padding: `${tokens.spacing[3]} 0`, textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.xs }}>
          {t('marketDataLoading') || 'Loading market data...'}
          <button
            onClick={() => mutateMarket()}
            style={{ display: 'block', margin: '8px auto 0', padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.sm, border: `1px solid ${tokens.colors.border.primary}`, background: 'transparent', color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.xs, cursor: 'pointer' }}
          >
            {t('retry') || 'Retry'}
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {coins.map((coin, idx) => (
              <div
                key={coin.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '9px 6px',
                  borderBottom: idx < coins.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                  borderRadius: tokens.radius.sm,
                  transition: `background ${tokens.transition.fast}`,
                }}
                onMouseEnter={handleRowEnter}
                onMouseLeave={handleRowLeave}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: tokens.typography.fontSize.sm, fontWeight: tokens.typography.fontWeight.semibold, color: tokens.colors.text.primary }}>
                  <CryptoIcon symbol={coin.symbol} size={18} />
                  {coin.symbol}
                </span>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: tokens.typography.fontSize.sm, fontWeight: tokens.typography.fontWeight.medium, color: tokens.colors.text.primary }}>
                    ${coin.price.toLocaleString('en-US', { maximumFractionDigits: coin.price < 1 ? 4 : 2 })}
                  </div>
                  <div style={{
                    fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.semibold,
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
              width: '100%', marginTop: 8, padding: `${tokens.spacing[2]} 0`,
              background: 'transparent',
              border: `1px dashed ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.md,
              color: tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.medium,
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
              ? t('sidebarCollapse')
              : t('sidebarManageWatchlist')
            }
          </button>

          {/* Coin picker */}
          {showPicker && (
            <div style={{ marginTop: 8 }}>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('sidebarSearchCoins')}
                aria-label={t('searchCoin')}
                style={{
                  width: '100%', padding: '6px 10px', marginBottom: 8,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.xs,
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
                        color: selected ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                        fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.medium,
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
