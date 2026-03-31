import type { Metadata } from 'next'
import { unstable_cache } from 'next/cache'
import MarketPageClient from './MarketPageClient'
import { BASE_URL } from '@/lib/constants/urls'

export const revalidate = 60 // ISR: 1 min

export const metadata: Metadata = {
  title: 'Crypto Market Overview | Live Prices, Gainers & Losers',
  description: 'Real-time crypto market data. Track top gainers, losers, prices, volume, and market cap across 100+ tokens. Updated every minute.',
  alternates: {
    canonical: `${BASE_URL}/market`,
  },
  openGraph: {
    title: 'Crypto Market Overview',
    description: 'Real-time crypto market data. Track top gainers, losers, prices, volume, and market cap across 100+ tokens.',
    url: `${BASE_URL}/market`,
    siteName: 'Arena',
    type: 'website',
    images: [{
      url: `${BASE_URL}/og-image.png`,
      width: 1200,
      height: 630,
      alt: 'Arena - Crypto Market Overview'
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Crypto Market Overview',
    description: 'Real-time crypto market data. Track top gainers, losers, prices, volume, and market cap.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

interface SpotCoinSSR {
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

// Prefetch spot market data server-side via CoinGecko
const getSpotMarketData = unstable_cache(
  async (): Promise<SpotCoinSSR[]> => {
    try {
      const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h'

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 8000)

      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!res.ok) return []

      const raw = await res.json()
      if (!Array.isArray(raw)) return []

      return raw.map((c: Record<string, unknown>) => ({
        id: String(c.id ?? ''),
        symbol: String(c.symbol ?? '').toUpperCase(),
        name: String(c.name ?? ''),
        image: typeof c.image === 'string' ? c.image.replace('/large/', '/small/') : '',
        price: Number(c.current_price) || 0,
        change24h: Number(c.price_change_percentage_24h) || 0,
        high24h: Number(c.high_24h) || 0,
        low24h: Number(c.low_24h) || 0,
        volume24h: Number(c.total_volume) || 0,
        marketCap: Number(c.market_cap) || 0,
        rank: Number(c.market_cap_rank) || 0,
      }))
    } catch {
      return []
    }
  },
  ['market-spot-ssr'],
  { revalidate: 60, tags: ['market'] }
)

export default async function MarketPage() {
  const initialSpotData = await getSpotMarketData()

  return <MarketPageClient initialSpotData={initialSpotData} />
}
